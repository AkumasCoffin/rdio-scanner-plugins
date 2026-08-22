// Transcripts — Whisper transcription for Rdio Scanner.
//
// Ported from the implementation that used to live in the server. The webapp
// and the Android app are unchanged: this puts `transcript` on the call payload
// where it has always been, answers the same TRX websocket command, and serves
// the same HTTP endpoints, so nothing downstream of here can tell the
// difference.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Groq rejects a prompt longer than this outright (HTTP 400). OpenAI documents
// a 224-token guideline but accepts longer, and a self-hosted server has no
// limit at all, so this is only enforced for Groq.
var PROMPT_MAX_CHARS = 896

// A call with no more audio than a WAV header has nothing to transcribe.
var MIN_AUDIO_BYTES = 44

var HTTP_TIMEOUT_MS = 120000

// How long a transcript that arrived before its call is held. Comfortably
// longer than any plausible upload skew, short enough to bound the memory a
// misconfigured upstream can pin.
var PENDING_TTL_MS = 5 * 60 * 1000
var PENDING_CAP = 1000

// How long to wait for an upstream's promised transcript before transcribing
// the call locally instead.
var FALLBACK_TTL_MS = 2 * 60 * 1000

// How many due fallbacks one sweep may process, and how many may be tracked at
// all.
//
// Everything this plugin does shares one event loop, and each due entry costs a
// synchronous database read before anything else can run. An uncapped sweep
// therefore scales its own stall with the size of the backlog, and once a tick
// costs more than the interval between ticks the plugin never catches up — it
// stops answering its own HTTP routes while looking, from the outside, simply
// slow. The leftovers are not lost; they are handled by the next tick.
var SWEEP_MAX_PER_TICK = 50
var FALLBACK_CAP = 5000

var PROVIDERS = {
    groq: { url: 'groqBaseUrl', key: 'groqApiKey', model: 'groqModel' },
    openai: { url: 'openaiBaseUrl', key: 'openaiApiKey', model: 'openaiModel' },
    'whisper-selfhosted': { url: 'whisperBaseUrl', key: 'whisperApiKey', model: 'whisperModel' },
}

// Marks the single "no authentication" slot used when a self-hosted server
// needs no key. Never sent on the wire — the request just omits the header.
var ANONYMOUS_KEY = '__anonymous__'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Round-robin ring of API keys, each rate-limited and backed off on its own.
// Rotation only helps if usage is tracked per key, because that is how the
// upstream limits are applied.
var keys = []
var keysHash = ''
var nextKeyIndex = 0

// Calls currently being transcribed, so a burst doesn't pin every audio blob
// in memory at once.
var inFlight = 0
var queue = []

// Transcripts that arrived before their call. The upstream's tiny JSON push
// regularly overtakes its own large multipart upload.
var pending = {}

// Timers waiting on an upstream's promised transcript, keyed by call id.
var fallbackTimers = {}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfg(key) {
    return rdio.config.get(key)
}

function activeProvider() {
    var provider = cfg('provider')
    if (!PROVIDERS[provider]) provider = 'groq'
    return provider
}

function activeConfig() {
    var provider = activeProvider()
    var slot = PROVIDERS[provider]

    return {
        provider: provider,
        baseUrl: String(cfg(slot.url) || '').replace(/\/+$/, ''),
        apiKey: String(cfg(slot.key) || ''),
        model: String(cfg(slot.model) || '').trim(),
    }
}

function isSelfHosted(provider) {
    return provider === 'whisper-selfhosted'
}

// ---------------------------------------------------------------------------
// Key ring
// ---------------------------------------------------------------------------

function refreshKeys() {
    var active = activeConfig()

    var parts = active.apiKey.split(/[,\n\r ;\t]+/)
    var cleaned = []
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim()
        if (part) cleaned.push(part)
    }

    // A self-hosted server with no key still needs a slot for the scheduling
    // and rate-limiting machinery to operate on. A hosted provider with no key
    // legitimately ends up with an empty ring, which reads as "not configured".
    if (!cleaned.length && isSelfHosted(active.provider)) {
        cleaned = [ANONYMOUS_KEY]
    }

    var hash = active.provider + '|' + cleaned.join('|')
    if (hash === keysHash) return

    keysHash = hash
    keys = []
    for (var j = 0; j < cleaned.length; j++) {
        keys.push({ value: cleaned[j], pausedUntil: 0, recent: [] })
    }
    if (nextKeyIndex >= keys.length) nextKeyIndex = 0
}

// Picks the first key that is neither backed off nor at its own per-minute cap,
// records the use, and advances the cursor. Returns null with a reason when
// nothing is currently usable.
function reserveKey(now) {
    refreshKeys()

    if (!keys.length) {
        return { key: null, reason: 'no transcription api key configured' }
    }

    var max = Number(cfg('maxPerMinute')) || 0
    var cutoff = now - 60000
    var allPaused = true
    var earliestResume = 0

    for (var i = 0; i < keys.length; i++) {
        var index = (nextKeyIndex + i) % keys.length
        var key = keys[index]

        if (now < key.pausedUntil) {
            if (!earliestResume || key.pausedUntil < earliestResume) {
                earliestResume = key.pausedUntil
            }
            continue
        }
        allPaused = false

        var trimmed = []
        for (var r = 0; r < key.recent.length; r++) {
            if (key.recent[r] > cutoff) trimmed.push(key.recent[r])
        }
        key.recent = trimmed

        if (max > 0 && key.recent.length >= max) continue

        key.recent.push(now)
        nextKeyIndex = (index + 1) % keys.length
        return { key: key.value, reason: '' }
    }

    if (allPaused && earliestResume) {
        var seconds = Math.round((earliestResume - now) / 1000)
        return { key: null, reason: 'all keys paused ~' + seconds + 's (upstream backoff)' }
    }
    if (max > 0) {
        return { key: null, reason: 'all keys at per-key cap (' + max + '/min)' }
    }
    return { key: null, reason: 'no key available' }
}

function pauseKey(value, until) {
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].value === value && until > keys[i].pausedUntil) {
            keys[i].pausedUntil = until
        }
    }
}

function keyTail(value) {
    return value.length <= 4 ? value : value.slice(-4)
}

// Reads how long to sit out after a 429, from the standard header or from
// Groq's prose ("Please try again in 43.2s."). Falls back to a minute.
function parseBackoff(headers, body) {
    var retryAfter = headers && (headers['Retry-After'] || headers['retry-after'])
    if (retryAfter) {
        var seconds = parseInt(String(retryAfter).trim(), 10)
        if (!isNaN(seconds) && seconds > 0) return seconds * 1000
    }

    var match = /try again in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m)/i.exec(String(body || ''))
    if (match) {
        var value = parseFloat(match[1])
        if (match[2].toLowerCase() === 'ms') return value
        if (match[2].toLowerCase() === 'm') return value * 60000
        return value * 1000
    }

    return 60000
}

// ---------------------------------------------------------------------------
// Transcript text
// ---------------------------------------------------------------------------

// Strips Whisper's special/decoder tokens. Groq and OpenAI remove these
// upstream but self-hosted servers often don't, and on near-silent audio
// Whisper emits runs of language tokens that would otherwise be stored, shown
// and forwarded as a transcript.
// Whisper on near-silent audio, left to auto-detect the language, often
// "hears" another language entirely and emits fluent hallucinations in it —
// Korean thank-yous are the classic. When this instance's Language setting
// names a Latin-script language, a transcript written mostly in some other
// script cannot be a transcription of that traffic, so it is treated the same
// as silence. Keyed on the Language setting deliberately: an instance that
// leaves it empty has told us nothing, and gets no opinion forced on it.
var LATIN_SCRIPT_LANGS = {
    en: true, es: true, fr: true, de: true, it: true, pt: true, nl: true,
    sv: true, no: true, da: true, fi: true, pl: true, cs: true, ro: true,
    hu: true, tr: true, id: true, ms: true, vi: true, sw: true, tl: true,
}

function foreignHallucination(text) {
    var lang = String(cfg('language') || '').trim().toLowerCase()
    if (!LATIN_SCRIPT_LANGS[lang]) return false

    var latin = 0
    var foreign = 0

    for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i)
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xC0 && c <= 0x24F)) {
            latin++
        } else if (
            (c >= 0x0370 && c <= 0x06FF) ||  // greek, cyrillic, hebrew, arabic
            (c >= 0x0900 && c <= 0x0E7F) ||  // indic scripts, thai
            (c >= 0x3040 && c <= 0x30FF) ||  // kana
            (c >= 0x4E00 && c <= 0x9FFF) ||  // cjk
            (c >= 0xAC00 && c <= 0xD7AF)     // hangul
        ) {
            foreign++
        }
    }

    return foreign > latin
}

function sanitize(text) {
    return String(text || '')
        .replace(/<\|[^|]*\|>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function audioFilename(call) {
    if (call.audioName) return call.audioName

    switch (call.audioType) {
        case 'audio/mp4':
        case 'audio/m4a':
        case 'audio/x-m4a': return 'call.m4a'
        case 'audio/mpeg':
        case 'audio/mp3': return 'call.mp3'
        case 'audio/wav':
        case 'audio/x-wav': return 'call.wav'
        case 'audio/ogg': return 'call.ogg'
        case 'audio/flac': return 'call.flac'
        case 'audio/webm': return 'call.webm'
        default: return 'call.m4a'
    }
}

function promptFor(systemId) {
    var rows = rdio.db.query('select `prompt` from `systems` where `systemId` = ?', [systemId])
    var prompt = rows.length && rows[0].prompt ? String(rows[0].prompt).trim() : ''

    if (!prompt) prompt = String(cfg('prompt') || '').trim()
    if (!prompt) return ''

    // Only Groq enforces a hard cap. Keep the tail, where domain vocabulary
    // tends to sit, and cut at a word boundary.
    if (activeProvider() === 'groq' && prompt.length > PROMPT_MAX_CHARS) {
        var start = prompt.length - PROMPT_MAX_CHARS
        while (start < prompt.length && !/[\s,;.]/.test(prompt[start])) start++
        var truncated = prompt.slice(start).trim()
        rdio.log('info', 'prompt truncated to ' + truncated.length + ' chars (was ' + prompt.length + ') for Groq')
        return truncated
    }

    return prompt
}

// ---------------------------------------------------------------------------
// Settings lookups
// ---------------------------------------------------------------------------

function systemTranscribes(systemId) {
    var rows = rdio.db.query('select `transcribe` from `systems` where `systemId` = ?', [systemId])
    // Absent means "not configured", and the historical default is on.
    if (!rows.length) return true
    return !!rows[0].transcribe
}

function talkgroupTranscribes(systemId, talkgroupId) {
    var rows = rdio.db.query(
        'select `transcribe` from `talkgroups` where `systemId` = ? and `talkgroupId` = ?',
        [systemId, talkgroupId]
    )
    if (!rows.length) return true
    return !!rows[0].transcribe
}

function enabled() {
    if (!cfg('enabled')) return false

    var active = activeConfig()
    if (isSelfHosted(active.provider) && !active.baseUrl) return false

    refreshKeys()
    return keys.length > 0
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storedTranscript(callId) {
    var rows = rdio.db.query('select `transcript` from `calls` where `callId` = ?', [callId])
    return rows.length ? String(rows[0].transcript || '') : ''
}

function storeTranscript(callId, text) {
    var rows = rdio.db.query('select `callId` from `calls` where `callId` = ?', [callId])
    if (rows.length) {
        rdio.db.exec('update `calls` set `transcript` = ? where `callId` = ?', [text, callId])
    } else {
        rdio.db.exec('insert into `calls` (`callId`, `transcript`) values (?, ?)', [callId, text])
    }
}

// First write wins. This is the guard that stops a cyclic downstream topology
// (A forwards to B, B forwards to A) looping forever: the second arrival finds
// a transcript already present, and does not re-broadcast or re-forward.
function storeTranscriptIfEmpty(callId, text) {
    if (storedTranscript(callId)) return false
    storeTranscript(callId, text)
    return true
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

// Pushes to every listener allowed to see the call, using the same TRX command
// and payload shape the server used to send — which is why the webapp and the
// Android app need no changes.
function emitTranscript(callId, system, talkgroup, text) {
    rdio.ws.emit(
        { system: system, talkgroup: talkgroup },
        'TRX',
        { id: callId, system: system, talkgroup: talkgroup, transcript: text }
    )

    // Tell other plugins too. Announced from here rather than at each of the
    // five places a transcript can become final — local transcription, an
    // inbound push, a transcript that beat its own call, a manual retranscribe —
    // because this function is the one thing they all already go through. Adding
    // a sixth path in future gets the announcement for free instead of silently
    // missing it.
    //
    // publish never waits and never reports who listened, so a keyword matcher
    // or a notifier subscribing here cannot slow transcription down or fail it.
    rdio.plugins.publish('transcript', {
        id: callId,
        system: system,
        talkgroup: talkgroup,
        transcript: text,
    })
}

function forwardDownstream(system, talkgroup, dateTime, text) {
    rdio.downstreams.forward({
        path: '/api/call-transcript',
        system: system,
        talkgroup: talkgroup,
        requireFeature: 'transcript-forward',
        body: {
            system: system,
            talkgroup: talkgroup,
            dateTime: dateTime,
            transcript: text,
        },
    }).catch(function (err) {
        rdio.log('warn', 'downstream transcript forward failed: ' + err)
    })
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

function transcribe(call, attempt, tried, lastError, done) {
    if (attempt >= 8) {
        done(null, lastError || 'transcription exhausted retries')
        return
    }

    var active = activeConfig()

    if (!active.baseUrl) {
        done(null, 'provider ' + active.provider + ' has no base URL configured')
        return
    }
    if (!active.model) {
        done(null, 'provider ' + active.provider + ' has no model configured')
        return
    }

    var reserved = reserveKey(Date.now())
    if (!reserved.key) {
        done(null, lastError || ('skipped: ' + reserved.reason))
        return
    }
    if (tried[reserved.key]) {
        // The ring handed back a key already tried for this call, so everything
        // else is paused or capped. Stop rather than spin.
        done(null, lastError || 'skipped: exhausted all keys')
        return
    }
    tried[reserved.key] = true

    var fields = {
        model: active.model,
        response_format: 'json',
    }

    var language = String(cfg('language') || '').trim()
    if (language) fields.language = language

    var prompt = promptFor(call.system)
    if (prompt) fields.prompt = prompt

    var headers = {}
    if (reserved.key !== ANONYMOUS_KEY) {
        headers.Authorization = 'Bearer ' + reserved.key
    }

    rdio.http.multipart({
        url: active.baseUrl + '/audio/transcriptions',
        headers: headers,
        fields: fields,
        files: [{ field: 'file', filename: audioFilename(call), data: call.audio }],
        timeoutMs: HTTP_TIMEOUT_MS,
    }).then(function (res) {
        if (res.status === 429) {
            var backoff = parseBackoff(res.headers, res.body)
            pauseKey(reserved.key, Date.now() + backoff)

            var label = reserved.key === ANONYMOUS_KEY ? '(anonymous)' : '…' + keyTail(reserved.key)
            rdio.log('info', 'transcription 429 on key ' + label + ', paused ' + Math.round(backoff / 1000) + 's; trying next key')

            transcribe(call, attempt + 1, tried, 'rate limited on key', done)
            return
        }

        if (res.status >= 500) {
            transcribe(call, attempt + 1, tried, 'api status ' + res.status, done)
            return
        }

        if (res.status < 200 || res.status >= 300) {
            done(null, 'api status ' + res.status + ': ' + String(res.body).trim())
            return
        }

        var parsed
        try {
            parsed = JSON.parse(res.body)
        } catch (err) {
            done(null, 'unparseable response: ' + err)
            return
        }

        if (parsed.error && parsed.error.message) {
            done(null, parsed.error.message)
            return
        }

        done(sanitize(parsed.text), null)
    }).catch(function (err) {
        // Network-level failure: could be specific to this request path, so
        // another key is worth trying.
        transcribe(call, attempt + 1, tried, 'network error: ' + err, done)
    })
}

// A failed job used to be dropped on the spot. Production numbers said how
// wrong that was: ninety percent of failures were "all keys paused" — every
// call landing inside a rate-limit backoff window lost its transcript forever.
// Transient failures now go back on the queue after a delay sized from the
// backoff the provider asked for.
var RETRY_BASE_MS = 75 * 1000
var RETRY_MAX = 8

function retryableError(err) {
    var text = String(err)

    return text.indexOf('skipped:') === 0
        || text.indexOf('rate limited') !== -1
        || text.indexOf('network error') === 0
        || /api status 5\d\d/.test(text)
}

function retryDelayMs(err) {
    // "all keys paused ~43s" carries the provider's own backoff; sit that out
    // plus a little, clamped to something sane either way.
    var match = /~(\d+)s/.exec(String(err))
    if (match) {
        var ms = Number(match[1]) * 1000 + 5000
        return Math.min(Math.max(ms, 30000), 300000)
    }

    return RETRY_BASE_MS
}

function drainQueue() {
    var limit = Number(cfg('concurrency')) || 8

    while (queue.length && inFlight < limit) {
        var job = queue.shift()
        inFlight++
        startJob(job)
    }
}

// Each job starts on its own tick.
//
// runJob loads the call's audio synchronously, and the event loop it runs on is
// the same one serving this plugin's HTTP routes. Starting the whole batch in
// one tick meant up to `concurrency` blob reads back to back with nothing able
// to run in between — the queue drained a little sooner and every route handler
// waiting behind it paid for it.
function startJob(job) {
    setTimeout(function () {
        runJob(job)
    }, 0)
}

function runJob(job) {
    // A retry may have been overtaken by the upstream's transcript push while
    // it waited; finishing the local job anyway would overwrite it.
    if (storedTranscript(job.id)) {
        inFlight--
        drainQueue()
        return
    }

    var call = rdio.calls.get(job.id, { audio: true })

    if (!call || !call.audio || call.audio.length <= MIN_AUDIO_BYTES) {
        inFlight--
        drainQueue()
        return
    }

    transcribe(call, 0, {}, null, function (text, err) {
        inFlight--

        try {
            if (err) {
                if (retryableError(err) && (job.retries || 0) < RETRY_MAX) {
                    job.retries = (job.retries || 0) + 1

                    var delay = retryDelayMs(err)
                    rdio.log('info', 'transcription retry ' + job.retries + '/' + RETRY_MAX +
                        ' for call ' + job.id + ' in ' + Math.round(delay / 1000) + 's (' + err + ')')

                    setTimeout(function () {
                        queue.push(job)
                        drainQueue()
                    }, delay)

                    return
                }

                var level = String(err).indexOf('skipped:') === 0 ? 'info' : 'warn'
                rdio.log(level, 'transcription failed for call ' + job.id + ': ' + err)
                return
            }

            // Empty after sanitising means the model returned only special
            // tokens or silence. Leaving the call untranscribed is better than
            // storing, showing and forwarding noise.
            if (!text) {
                rdio.log('info', 'transcription produced no usable text for call ' + job.id + ' (silence/noise)')
                return
            }

            if (foreignHallucination(text)) {
                rdio.log('info', 'transcription discarded for call ' + job.id + ' (wrong-script hallucination): ' + text)
                return
            }

            storeTranscript(job.id, text)
            emitTranscript(job.id, call.system, call.talkgroup, text)
            rdio.log('info', 'transcribed call ' + job.id + ' (' + text.length + ' chars)')
            forwardDownstream(call.system, call.talkgroup, call.dateTime, text)
        } finally {
            drainQueue()
        }
    })
}

function enqueue(id) {
    queue.push({ id: id })
    drainQueue()
}

// ---------------------------------------------------------------------------
// Pending transcripts
// ---------------------------------------------------------------------------

function pendingKey(system, talkgroup, dateTime) {
    return system + ':' + talkgroup + ':' + dateTime
}

function prunePending() {
    var now = Date.now()
    var live = []

    for (var key in pending) {
        if (now - pending[key].storedAt > PENDING_TTL_MS) {
            delete pending[key]
        } else {
            live.push({ key: key, at: pending[key].storedAt })
        }
    }

    // Still over capacity: drop oldest first, so a firehose from a
    // misconfigured upstream cannot grow this without bound.
    if (live.length >= PENDING_CAP) {
        live.sort(function (a, b) { return a.at - b.at })
        for (var i = 0; i <= live.length - PENDING_CAP; i++) {
            delete pending[live[i].key]
        }
    }
}

function storePending(system, talkgroup, dateTime, text, ident) {
    prunePending()
    pending[pendingKey(system, talkgroup, dateTime)] = {
        transcript: text,
        ident: ident,
        storedAt: Date.now(),
    }
}

function takePending(system, talkgroup, dateTime) {
    var key = pendingKey(system, talkgroup, dateTime)
    var entry = pending[key]
    if (!entry) return null

    delete pending[key]

    // An expired entry is a miss: a stale transcript should not be applied.
    if (Date.now() - entry.storedAt > PENDING_TTL_MS) return null

    return entry
}

function cancelFallback(callId) {
    if (fallbackTimers[callId]) {
        delete fallbackTimers[callId]
        return true
    }
    return false
}

function scheduleFallback(call) {
    fallbackTimers[call.id] = {
        dueAt: Date.now() + FALLBACK_TTL_MS,
        system: call.system,
        talkgroup: call.talkgroup,
    }

    // Bounded like `pending` is. Without this the set grows with every call an
    // upstream promised and never delivered, and both the memory and the sweep
    // that walks it grow with it, indefinitely.
    var keys = Object.keys(fallbackTimers)
    if (keys.length <= FALLBACK_CAP) return

    keys.sort(function (a, b) {
        return fallbackTimers[a].dueAt - fallbackTimers[b].dueAt
    })

    var drop = keys.length - FALLBACK_CAP
    for (var i = 0; i < drop; i++) {
        delete fallbackTimers[keys[i]]
    }

    rdio.log('warn', 'dropped ' + drop + ' fallback timers over the cap of ' + FALLBACK_CAP +
        '; upstream transcripts are not arriving and local transcription is not keeping up')
}

// Swept on a timer rather than one setTimeout per call: the number of pending
// timers tracks ingest rate, and a sweep is one pass regardless.
//
// Bounded per tick — see SWEEP_MAX_PER_TICK. Whatever is left over is still
// due on the next tick, so nothing is dropped by stopping early.
function sweepFallbacks() {
    var now = Date.now()
    var handled = 0

    for (var key in fallbackTimers) {
        if (handled >= SWEEP_MAX_PER_TICK) break
        if (fallbackTimers[key].dueAt > now) continue

        delete fallbackTimers[key]
        handled++

        // Object keys are strings. Postgres will not compare an integer column
        // against a text parameter, so this has to be a number before it goes
        // anywhere near a query.
        var callId = Number(key)

        // The upstream may have delivered while we waited.
        if (storedTranscript(callId)) continue
        if (!enabled()) continue

        rdio.log('info', 'upstream transcript never arrived for call ' + callId + '; transcribing locally')
        enqueue(callId)
    }
}

// ---------------------------------------------------------------------------
// Applying an inbound transcript
// ---------------------------------------------------------------------------

// The shared tail of every path that receives a transcript from elsewhere:
// store it if the call has none, tell listeners, stop any fallback, and pass it
// on. Returns false when the call already had one.
function applyInbound(callId, system, talkgroup, dateTime, text, ident) {
    if (!storeTranscriptIfEmpty(callId, text)) {
        // Duplicate. Skip the broadcast, and crucially skip forwarding — that
        // is what would loop forever between mutual downstreams. Still cancel
        // the fallback, because the upstream did make a real delivery.
        cancelFallback(callId)
        rdio.log('info', 'transcript push duplicate: [' + ident + '] system=' + system +
            ' talkgroup=' + talkgroup + ' id=' + callId + ' (call already has a transcript, rejected)')
        return false
    }

    emitTranscript(callId, system, talkgroup, text)
    rdio.log('info', 'transcript received: [' + ident + '] system=' + system +
        ' talkgroup=' + talkgroup + ' id=' + callId + ' (' + text.length + ' chars)')

    if (cancelFallback(callId)) {
        rdio.log('info', 'fallback transcription cancelled: id=' + callId + ' (transcript arrived from upstream)')
    }

    forwardDownstream(system, talkgroup, dateTime, text)
    return true
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

rdio.on('call.stored', function (call) {
    if (!systemTranscribes(call.system) || !talkgroupTranscribes(call.system, call.talkgroup)) {
        return
    }

    // A transcript that beat its own call to the wire.
    var held = takePending(call.system, call.talkgroup, call.dateTime)
    if (held) {
        storeTranscript(call.id, held.transcript)
        emitTranscript(call.id, call.system, call.talkgroup, held.transcript)
        rdio.log('info', 'transcript applied from hold: [' + held.ident + '] id=' + call.id)
        forwardDownstream(call.system, call.talkgroup, call.dateTime, held.transcript)
        return
    }

    if (!enabled()) return

    var minBytes = Number(cfg('minAudioBytes')) || 0
    if (minBytes > 0 && call.audioSize < minBytes) return
    if (call.audioSize <= MIN_AUDIO_BYTES) return

    // A transcriptPending hint on the upload means an upstream is transcribing
    // this call and will push the result. Don't duplicate the work — but do set
    // a timer, so a push that never comes doesn't leave the call blank forever.
    // call.meta carries whatever non-core fields the uploader sent.
    if (call.meta && call.meta.transcriptPending) {
        rdio.log('info', 'call from upstream with pending transcript: id=' + call.id + ' (awaiting push)')
        scheduleFallback(call)
        return
    }

    enqueue(call.id)
})

// ---------------------------------------------------------------------------
// Websocket
// ---------------------------------------------------------------------------

// Answers a client asking for one call's transcript. Same command and payload
// the server used to serve, so the webapp and Android need no changes.
rdio.ws.on('TRX', function (client, payload) {
    var id = 0

    if (typeof payload === 'number') id = payload
    else if (typeof payload === 'string') id = parseInt(payload, 10)
    else if (payload && payload.id) id = Number(payload.id)

    if (!id) return

    rdio.ws.emit({ client: client }, 'TRX', { id: id, transcript: storedTranscript(id) })
})

// ---------------------------------------------------------------------------
// Server-to-server protocol
// ---------------------------------------------------------------------------

// Peers probe /api/capabilities to decide whether they can forward transcripts
// here. That endpoint stays in the server and reports what every enabled plugin
// advertises — one plugin claiming it would have to answer on behalf of all the
// others, which is not its business.
rdio.capabilities.advertise('transcript-forward')

rdio.routes.registerAbsolute('/api/call-transcript', function (req) {
    if (req.method !== 'POST') {
        return { status: 405, body: 'method not allowed' }
    }

    var body
    try {
        body = JSON.parse(req.body)
    } catch (err) {
        return { status: 400, body: 'invalid json' }
    }

    if (!body.dateTime || !/^\d{4}-\d{2}-\d{2}T/.test(String(body.dateTime))) {
        return { status: 400, body: 'invalid dateTime' }
    }

    var auth = rdio.apikeys.verify(String(body.key || ''), body.system, body.talkgroup)
    if (!auth.valid) {
        rdio.log('warn', 'transcript push auth failed: system=' + body.system +
            ' talkgroup=' + body.talkgroup + ' dateTime=' + body.dateTime)
        return {
            status: 401,
            body: 'Invalid API key for system ' + body.system + ' talkgroup ' + body.talkgroup + '.\n',
        }
    }

    // Sanitise defensively. An upstream on a self-hosted backend may push raw
    // special tokens; strip them so this instance never stores or forwards
    // garbage even when the upstream didn't clean up. Nothing usable left is
    // accepted and ignored, leaving the call open to local transcription
    // rather than marking it done with noise.
    var text = sanitize(body.transcript)
    if (!text) {
        rdio.log('info', 'transcript push ignored (no usable text after sanitize): [' + auth.ident +
            '] system=' + body.system + ' talkgroup=' + body.talkgroup)
        return { status: 200, body: 'Transcript ignored (no usable text).\n' }
    }

    if (foreignHallucination(text)) {
        rdio.log('info', 'transcript push ignored (wrong-script hallucination): [' + auth.ident +
            '] system=' + body.system + ' talkgroup=' + body.talkgroup + ': ' + text)
        return { status: 200, body: 'Transcript ignored (hallucination guard).' }
    }

    rdio.log('info', 'transcript push received: [' + auth.ident + '] system=' + body.system +
        ' talkgroup=' + body.talkgroup + ' dateTime=' + body.dateTime)

    var id = rdio.calls.findId(body.system, body.talkgroup, body.dateTime)

    if (!id) {
        // The push overtook its own call upload. Hold it; call.stored will
        // collect it when the call lands, and it expires if that never happens.
        storePending(body.system, body.talkgroup, body.dateTime, text, auth.ident)
        rdio.log('info', 'transcript deferred (holding for incoming call): [' + auth.ident +
            '] system=' + body.system + ' talkgroup=' + body.talkgroup)

        // Tight race: the call may have landed between the lookup above and
        // the hold just now, in which case call.stored already ran and would
        // leave the entry sitting unused until it expired.
        var raced = rdio.calls.findId(body.system, body.talkgroup, body.dateTime)
        if (raced) {
            var entry = takePending(body.system, body.talkgroup, body.dateTime)
            if (entry) {
                applyInbound(raced, body.system, body.talkgroup, body.dateTime, entry.transcript, entry.ident)
            }
        }

        return { status: 200, body: 'Transcript accepted (deferred until matching call arrives).\n' }
    }

    if (!applyInbound(id, body.system, body.talkgroup, body.dateTime, text, auth.ident)) {
        return { status: 200, body: 'Transcript already applied (no-op).\n' }
    }

    return { status: 200, body: 'Transcript updated successfully.\n' }
})

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// Backs the retranscribe button in search results.
rdio.routes.registerAbsolute('/api/admin/transcribe', function (req) {
    if (!rdio.admin.verifyToken(req.headers.Authorization || '')) {
        return { status: 401, body: 'unauthorized' }
    }

    var body
    try {
        body = JSON.parse(req.body)
    } catch (err) {
        return { status: 400, body: 'invalid json' }
    }

    var id = Number(body.id || 0)
    if (!id) return { status: 400, body: 'no call id' }

    // An admin typing a correction by hand.
    if (body.manual) {
        var manual = sanitize(body.transcript)
        storeTranscript(id, manual)
        return { status: 200, body: { id: id, transcript: manual } }
    }

    if (!enabled()) {
        return { status: 400, body: 'transcription is not configured' }
    }

    var call = rdio.calls.get(id, { audio: true })
    if (!call) return { status: 404, body: 'no such call' }

    return new Promise(function (resolve) {
        transcribe(call, 0, {}, null, function (text, err) {
            if (err) {
                resolve({ status: 500, body: String(err) })
                return
            }

            storeTranscript(id, text)
            emitTranscript(id, call.system, call.talkgroup, text)
            resolve({ status: 200, body: { id: id, transcript: text } })
        })
    })
})

// Per-system and per-talkgroup transcription settings, for the admin UI.
rdio.routes.register('GET', 'settings', function (req) {
    if (!rdio.admin.verifyToken(req.headers.Authorization || '')) {
        return { status: 401, body: 'unauthorized' }
    }

    var systems = rdio.db.query('select * from `systems`')
    var talkgroups = rdio.db.query('select * from `talkgroups`')

    return {
        status: 200,
        body: {
            systems: rdio.systems.list(),
            systemSettings: systems,
            talkgroupSettings: talkgroups,
            // A per-system prompt is subject to the same cap as the global one,
            // and on Groq an over-long prompt is silently trimmed from the front
            // at transcription time. The editor needs all three to say so before
            // the prompt is saved rather than after calls come back wrong.
            provider: activeProvider(),
            promptMaxChars: PROMPT_MAX_CHARS,
            globalPrompt: String(cfg('prompt') || '').trim(),
        },
    }
})

rdio.routes.register('POST', 'settings', function (req) {
    if (!rdio.admin.verifyToken(req.headers.Authorization || '')) {
        return { status: 401, body: 'unauthorized' }
    }

    var body
    try {
        body = JSON.parse(req.body)
    } catch (err) {
        return { status: 400, body: 'invalid json' }
    }

    var i

    for (i = 0; i < (body.systems || []).length; i++) {
        var system = body.systems[i]
        var existing = rdio.db.query('select `systemId` from `systems` where `systemId` = ?', [system.systemId])
        if (existing.length) {
            rdio.db.exec('update `systems` set `transcribe` = ?, `prompt` = ? where `systemId` = ?',
                [!!system.transcribe, String(system.prompt || ''), system.systemId])
        } else {
            rdio.db.exec('insert into `systems` (`systemId`, `transcribe`, `prompt`) values (?, ?, ?)',
                [system.systemId, !!system.transcribe, String(system.prompt || '')])
        }
    }

    for (i = 0; i < (body.talkgroups || []).length; i++) {
        var tg = body.talkgroups[i]
        var found = rdio.db.query(
            'select `talkgroupId` from `talkgroups` where `systemId` = ? and `talkgroupId` = ?',
            [tg.systemId, tg.talkgroupId]
        )
        if (found.length) {
            rdio.db.exec('update `talkgroups` set `transcribe` = ? where `systemId` = ? and `talkgroupId` = ?',
                [!!tg.transcribe, tg.systemId, tg.talkgroupId])
        } else {
            rdio.db.exec('insert into `talkgroups` (`systemId`, `talkgroupId`, `transcribe`) values (?, ?, ?)',
                [tg.systemId, tg.talkgroupId, !!tg.transcribe])
        }
    }

    return { status: 200, body: { saved: true } }
})

// ---------------------------------------------------------------------------
// What other plugins can ask for
// ---------------------------------------------------------------------------

// Offered so nothing else has to reach into this plugin's tables. A keyword
// matcher or an alerting plugin querying `plugin_transcripts_calls` directly
// would be coupled to a schema that is this plugin's business to change; asking
// through the bus keeps that free to move.

rdio.plugins.handle('get', function (args) {
    var id = Number(args && args.id)
    if (!id) return null

    var text = storedTranscript(id)
    return text ? { id: id, transcript: text } : null
})

// Answers "is there a transcript for this call yet", which is the question a
// plugin waiting on one actually has. Cheaper than get() for a caller that only
// needs to know whether to wait.
rdio.plugins.handle('has', function (args) {
    var id = Number(args && args.id)
    return { id: id, ready: !!(id && storedTranscript(id)) }
})

// Transcribes on demand. Returns a promise, so the caller's own event loop keeps
// running while this one works — and the bus refuses a call from a plugin that
// is itself mid-call, so a cycle fails immediately rather than deadlocking.
rdio.plugins.handle('transcribe', function (args) {
    var id = Number(args && args.id)
    if (!id) throw new Error('transcribe requires an id')

    var existing = storedTranscript(id)
    if (existing && !(args && args.force)) {
        return { id: id, transcript: existing, cached: true }
    }

    var call = rdio.calls.get(id, { audio: true })
    if (!call) throw new Error('no call ' + id)

    return new Promise(function (resolve, reject) {
        // Callback is (text, err), in that order — matching the two existing
        // callers. Reading it as (err, text) would resolve with the error
        // message as the transcript on every failure, and look like it worked.
        transcribe(call, 0, {}, null, function (text, err) {
            if (err) {
                reject(new Error(String(err)))
                return
            }

            if (text) {
                storeTranscript(id, text)
                emitTranscript(id, call.system, call.talkgroup, text)
            }

            resolve({ id: id, transcript: text || '', cached: false })
        })
    })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function publishConfig() {
    // The webapp gates its transcript UI on exactly these three keys. Publishing
    // them under their original names is what lets the LCD, the search rows and
    // the stream overlay keep working with no changes at all.
    rdio.config.expose('transcriptionEnabled', !!cfg('enabled'))
    rdio.config.expose('waitForTranscript', !!cfg('waitForTranscript'))
    rdio.config.expose('showRetranscribeButton', !!cfg('showRetranscribeButton'))
}

rdio.on('startup', function () {
    // Puts `transcript` on every call payload, sourced from this plugin's
    // table. Declarative on purpose: the server does the lookup in native code
    // on the emit and search paths, so no JavaScript runs per call or per row.
    rdio.calls.extendField({
        field: 'transcript',
        table: 'calls',
        keyColumn: 'callId',
        valueColumn: 'transcript',
    })

    // Keeps the search box and the public API's ?q= parameter searching
    // transcripts, exactly as they did when the column lived on the calls table.
    rdio.search.extend({
        table: 'calls',
        keyColumn: 'callId',
        textColumn: 'transcript',
        resultField: 'transcript',
    })

    publishConfig()
    refreshKeys()

    rdio.log('info', 'transcripts ready (provider ' + activeProvider() +
        ', ' + keys.length + ' key(s), ' + (cfg('enabled') ? 'enabled' : 'disabled') + ')')
})

rdio.on('config.changed', function () {
    publishConfig()
    refreshKeys()
})

// Fallback timers and the pending-transcript cache both need a periodic sweep.
rdio.schedule(15000, function () {
    sweepFallbacks()
    prunePending()
})
