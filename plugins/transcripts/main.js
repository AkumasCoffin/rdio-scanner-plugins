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

// The longest inbound transcript worth reading.
//
// sanitize and the hallucination guard are both O(n) character walks in an
// interpreted runtime, run on the event loop before anything else can happen,
// and the push body has no size limit of its own. A transcript of a radio call
// is a few hundred characters; anything past this is a bug or an attack, and
// truncating beats spending seconds of everyone else's time proving it is
// rubbish.
var MAX_INBOUND_TRANSCRIPT = 20000

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
    // From the settings cache, not the database: this is read for every
    // transcription attempt, and a blocking read here lands inside the promise
    // continuation where it is charged to the loop exactly as anywhere else.
    // A cold cache falls through to the global prompt, which is what a system
    // with no prompt of its own uses anyway.
    var prompt = ''

    if (transcribeFlags) {
        prompt = transcribeFlags.prompts[systemId] || ''
    } else {
        loadTranscribeFlags()
    }

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

// The per-system and per-talkgroup switches, held in memory.
//
// These are read for every ingested call, and they are configuration — they
// change when someone edits the settings page, not as calls arrive. Reading
// them from the database per call meant two blocking queries on the event loop
// before anything else could happen, which is where the one-second `call.stored`
// holds came from. Both tables are small enough to hold whole.
//
// null means "not loaded yet"; the loader replaces both together so a lookup
// never sees one table refreshed and the other stale.
var transcribeFlags = null
var transcribeFlagsLoading = false

function loadTranscribeFlags() {
    if (transcribeFlagsLoading) return
    transcribeFlagsLoading = true

    Promise.all([
        rdio.db.queryAsync('select `systemId`, `transcribe`, `prompt` from `systems`', []),
        rdio.db.queryAsync('select `systemId`, `talkgroupId`, `transcribe` from `talkgroups`', []),
    ]).then(function (results) {
        var flags = { systems: {}, talkgroups: {}, prompts: {} }

        results[0].forEach(function (row) {
            flags.systems[row.systemId] = !!row.transcribe
            if (row.prompt) flags.prompts[row.systemId] = String(row.prompt).trim()
        })

        results[1].forEach(function (row) {
            flags.talkgroups[row.systemId + ':' + row.talkgroupId] = !!row.transcribe
        })

        transcribeFlags = flags
        transcribeFlagsLoading = false
    }).catch(function (err) {
        transcribeFlagsLoading = false
        rdio.log('warn', 'could not load transcribe settings: ' + err)
    })
}

function invalidateTranscribeFlags() {
    transcribeFlags = null
    loadTranscribeFlags()
}

// Absent means "not configured", and the historical default is on — for a
// missing row and for a cache that has not loaded yet alike. Being briefly
// permissive at startup transcribes a call someone had switched off; being
// briefly strict would lose one that should have been transcribed, and that is
// the one that cannot be recovered later.
function systemTranscribes(systemId) {
    if (!transcribeFlags) {
        loadTranscribeFlags()
        return true
    }

    var value = transcribeFlags.systems[systemId]
    return value === undefined ? true : value
}

function talkgroupTranscribes(systemId, talkgroupId) {
    if (!transcribeFlags) {
        loadTranscribeFlags()
        return true
    }

    var value = transcribeFlags.talkgroups[systemId + ':' + talkgroupId]
    return value === undefined ? true : value
}

// Whether transcripts arriving from other instances are thrown away.
//
// Set when this instance is meant to be the one that transcribes, so a chain of
// servers produces one instance's wording, prompt and provider rather than
// whichever copy happened to get there first.
function ignoreUpstream() {
    return !!cfg('ignoreUpstreamTranscripts')
}

// Counts drops between log lines, so a busy chain does not write one line per
// call to say it did the thing it was configured to do.
var droppedUpstream = 0
var droppedUpstreamLoggedAt = 0
var DROP_LOG_INTERVAL_MS = 60000

function noteUpstreamDrop(ident, system, talkgroup) {
    droppedUpstream++

    var now = Date.now()
    if (droppedUpstreamLoggedAt && now - droppedUpstreamLoggedAt < DROP_LOG_INTERVAL_MS) {
        return
    }

    rdio.log('info', 'transcript push dropped (set to transcribe locally): [' + ident +
        '] system=' + system + ' talkgroup=' + talkgroup +
        (droppedUpstream > 1 ? ' — ' + droppedUpstream + ' dropped so far' : ''))

    droppedUpstreamLoggedAt = now
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

// Everything below is async.
//
// The synchronous forms of these ran on the event loop, where a wait for a free
// database connection is a wait for the whole plugin — and the connection pool
// is shared with core's ingest, so a busy server made a three-statement store
// into a minute and a half of the plugin answering nothing at all. The async
// variants do the same work on a goroutine and hand the result back, which is
// the whole difference between "this call is slow" and "this plugin is down".
function storedTranscript(callId) {
    return rdio.db.queryAsync('select `transcript` from `calls` where `callId` = ?', [callId])
        .then(function (rows) {
            return rows.length ? String(rows[0].transcript || '') : ''
        })
}

function storeTranscript(callId, text) {
    return rdio.db.queryAsync('select `callId` from `calls` where `callId` = ?', [callId])
        .then(function (rows) {
            if (rows.length) {
                return rdio.db.execAsync('update `calls` set `transcript` = ? where `callId` = ?', [text, callId])
            }

            return rdio.db.execAsync('insert into `calls` (`callId`, `transcript`) values (?, ?)', [callId, text])
        })
}

// First write wins. This is the guard that stops a cyclic downstream topology
// (A forwards to B, B forwards to A) looping forever: the second arrival finds
// a transcript already present, and does not re-broadcast or re-forward.
//
// Resolves true when this caller was the one that wrote.
function storeTranscriptIfEmpty(callId, text) {
    return storedTranscript(callId).then(function (existing) {
        if (existing) return false

        return storeTranscript(callId, text).then(function () {
            return true
        })
    })
}

// The two host calls that read core's tables, always as promises.
//
// Both have async variants from Rdio Scanner 6.14.2, and neither did before —
// so each is used when it is there and the synchronous form wrapped in a
// resolved promise when it is not. The callers do not need to know which; they
// await either way, and on a host with the async variants nothing here touches
// the event loop at all.
//
// Neither can be replaced with a plain SQL query. findId matches within a
// ±500ms window in the backend's own date format (server call.go GetIdByKey),
// so a bound RFC3339 string compares equal on PostgreSQL and silently matches
// nothing on SQLite; and reading audio through rdio.db would corrupt it,
// because the database binding normalises every []byte column to a string
// (server plugin_db.go normalizePluginValue).
function findCallId(system, talkgroup, dateTime) {
    if (rdio.calls.findIdAsync) {
        return rdio.calls.findIdAsync(system, talkgroup, dateTime)
    }

    return Promise.resolve(rdio.calls.findId(system, talkgroup, dateTime))
}

function loadCall(id, withAudio) {
    var options = { audio: !!withAudio }

    if (rdio.calls.getAsync) {
        return rdio.calls.getAsync(id, options)
    }

    return Promise.resolve(rdio.calls.get(id, options))
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

// Hands the next attempt to a fresh tick.
//
// Recursing straight into transcribe() from inside .then/.catch kept the whole
// retry chain in one loop job: eight attempts meant eight multipart bodies
// built back to back, each copying the call's audio, with nothing else able to
// run in between. Same attempt, same moment — just not on the caller's back.
function retryTranscribe(call, attempt, tried, lastError, done) {
    setTimeout(function () {
        transcribe(call, attempt, tried, lastError, done)
    }, 0)
}

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

            retryTranscribe(call, attempt + 1, tried, 'rate limited on key', done)
            return
        }

        if (res.status >= 500) {
            retryTranscribe(call, attempt + 1, tried, 'api status ' + res.status, done)
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
        retryTranscribe(call, attempt + 1, tried, 'network error: ' + err, done)
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
    // An admin asking for a retranscribe is asking for exactly the overwrite
    // the check below exists to prevent, and every call the button is offered
    // on already has a transcript — so without this a forced job would be
    // dropped here every time, silently and with nothing logged.
    if (job.force) {
        startTranscription(job)
        return
    }

    // A retry may have been overtaken by the upstream's transcript push while
    // it waited; finishing the local job anyway would overwrite it.
    storedTranscript(job.id).then(function (existing) {
        if (existing) {
            inFlight--
            drainQueue()
            return
        }

        startTranscription(job)
    }).catch(function (err) {
        rdio.log('warn', 'could not check existing transcript for call ' + job.id + ': ' + err)
        inFlight--
        drainQueue()
    })
}

function startTranscription(job) {
    // Reading a call's audio is the heaviest thing this plugin asks for — 50 to
    // 200 KB, and on a busy server a couple of seconds of disk. Held the loop
    // for exactly that long until the host grew an async variant.
    loadCall(job.id, true).then(function (call) {
        if (!call || !call.audio || call.audio.length <= MIN_AUDIO_BYTES) {
            inFlight--
            drainQueue()
            return
        }

        runTranscription(job, call)
    }).catch(function (err) {
        rdio.log('warn', 'could not load audio for call ' + job.id + ': ' + err)
        inFlight--
        drainQueue()
    })
}

function runTranscription(job, call) {
    transcribe(call, 0, {}, null, function (text, err) {
        inFlight--

        // Set when the store path takes over responsibility for draining.
        var drained = false

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

            // Held open until the write lands: draining the queue first
            // would let a retry read "no transcript yet" and transcribe the
            // same call twice.
            drained = true

            storeTranscript(job.id, text).then(function () {
                emitTranscript(job.id, call.system, call.talkgroup, text)
                rdio.log('info', 'transcribed call ' + job.id + ' (' + text.length + ' chars)')
                forwardDownstream(call.system, call.talkgroup, call.dateTime, text)
            }).catch(function (storeErr) {
                rdio.log('warn', 'could not store transcript for call ' + job.id + ': ' + storeErr)
            }).then(function () {
                drainQueue()
            })
        } finally {
            if (!drained) drainQueue()
        }
    })
}

// force re-transcribes a call that already has a transcript. Retries carry the
// flag with them, so a forced job that comes back for another attempt is not
// quietly downgraded into one that gives up the moment it sees its own earlier
// result.
function enqueue(id, options) {
    queue.push({ id: id, force: !!(options && options.force) })
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

        if (!enabled()) continue

        // The upstream may have delivered while we waited. Asked off the loop,
        // so a backlog of due entries costs concurrency rather than a stall.
        checkThenEnqueue(callId)
    }
}

// Queues a call for local transcription unless a transcript turned up first.
function checkThenEnqueue(callId) {
    storedTranscript(callId).then(function (existing) {
        if (existing) return

        rdio.log('info', 'upstream transcript never arrived for call ' + callId + '; transcribing locally')
        enqueue(callId)
    }).catch(function (err) {
        rdio.log('warn', 'fallback check failed for call ' + callId + ': ' + err)
    })
}

// ---------------------------------------------------------------------------
// Applying an inbound transcript
// ---------------------------------------------------------------------------

// The shared tail of every path that receives a transcript from elsewhere:
// store it if the call has none, tell listeners, stop any fallback, and pass it
// on. Returns false when the call already had one.
// Resolves true when this caller wrote the transcript, false when the call
// already had one.
function applyInbound(callId, system, talkgroup, dateTime, text, ident) {
    return storeTranscriptIfEmpty(callId, text).then(function (wrote) {
        if (!wrote) {
            // Duplicate. Skip the broadcast, and crucially skip forwarding —
            // that is what would loop forever between mutual downstreams. Still
            // cancel the fallback, because the upstream did make a real
            // delivery.
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
    })
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

rdio.on('call.stored', function (call) {
    if (!systemTranscribes(call.system) || !talkgroupTranscribes(call.system, call.talkgroup)) {
        return
    }

    // A transcript that beat its own call to the wire. Skipped when upstream
    // transcripts are being ignored — the route stops parking new ones, but
    // entries held from before the setting was turned on are still in the map
    // and would otherwise be applied after the fact.
    var held = ignoreUpstream() ? null : takePending(call.system, call.talkgroup, call.dateTime)
    if (held) {
        storeTranscript(call.id, held.transcript).then(function () {
            emitTranscript(call.id, call.system, call.talkgroup, held.transcript)
            rdio.log('info', 'transcript applied from hold: [' + held.ident + '] id=' + call.id)
            forwardDownstream(call.system, call.talkgroup, call.dateTime, held.transcript)
        }).catch(function (err) {
            rdio.log('warn', 'could not store held transcript for id=' + call.id + ': ' + err)
        })
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
    //
    // Ignored outright when this instance is set to transcribe locally. The
    // hint's whole purpose is to suppress local transcription in favour of a
    // push that is now going to be discarded, so honouring it would leave the
    // call waiting on a transcript already decided against, and only transcribe
    // it when the fallback timer eventually gave up.
    if (call.meta && call.meta.transcriptPending && !ignoreUpstream()) {
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

    storedTranscript(id).then(function (text) {
        rdio.ws.emit({ client: client }, 'TRX', { id: id, transcript: text })
    }).catch(function (err) {
        rdio.log('warn', 'could not read transcript for id=' + id + ': ' + err)
    })
})

// ---------------------------------------------------------------------------
// Server-to-server protocol
// ---------------------------------------------------------------------------

// Peers probe /api/capabilities to decide whether they can forward transcripts
// here. That endpoint stays in the server and reports what every enabled plugin
// advertises — one plugin claiming it would have to answer on behalf of all the
// others, which is not its business.
//
// Not advertised when upstream transcripts are being ignored: a peer that knows
// this instance does not take forwarded transcripts stops sending them, which
// is better than sending them to be dropped. Only the announcement depends on
// the setting — the route drops them regardless, so a peer that never re-reads
// capabilities, or was told before the setting changed, still cannot override
// the choice.
//
// advertise runs once at load and there is no way to withdraw it, and saving
// settings does not restart a plugin, so a change here reaches peers at the
// next restart. The dropping itself takes effect immediately.
if (!ignoreUpstream()) {
    rdio.capabilities.advertise('transcript-forward')
}

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

    // Dropped here rather than at the door: the key is verified first, so an
    // unauthenticated caller learns nothing about this instance's settings, and
    // the answer is a 200 because the push was well formed and the sender did
    // nothing wrong. Refusing it would make a correctly-behaving upstream retry,
    // or mark this instance as failing, over a local preference.
    if (ignoreUpstream()) {
        noteUpstreamDrop(auth.ident, body.system, body.talkgroup)
        return { status: 200, body: 'Transcript ignored (this instance transcribes locally).\n' }
    }

    // Sanitise defensively. An upstream on a self-hosted backend may push raw
    // special tokens; strip them so this instance never stores or forwards
    // garbage even when the upstream didn't clean up. Nothing usable left is
    // accepted and ignored, leaving the call open to local transcription
    // rather than marking it done with noise.
    var raw = String(body.transcript || '')
    if (raw.length > MAX_INBOUND_TRANSCRIPT) {
        rdio.log('warn', 'transcript push truncated: [' + auth.ident + '] system=' + body.system +
            ' talkgroup=' + body.talkgroup + ' (' + raw.length + ' chars)')
        raw = raw.slice(0, MAX_INBOUND_TRANSCRIPT)
    }

    var text = sanitize(raw)
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

    // Everything below returns a promise, so the loop is free while the
    // database works. The handler's synchronous part ends at the line above.
    return findCallId(body.system, body.talkgroup, body.dateTime).then(function (id) {
        if (!id) {
            // The push overtook its own call upload. Hold it; call.stored
            // collects it when the call lands, and it expires if that never
            // happens.
            //
            // The second lookup that used to sit here covered a tight race —
            // the call landing between the first lookup and the hold. The hold
            // itself already covers it: call.stored takes the entry whenever it
            // arrives. Asking the same question twice bought nothing and cost
            // another blocking lookup.
            storePending(body.system, body.talkgroup, body.dateTime, text, auth.ident)
            rdio.log('info', 'transcript deferred (holding for incoming call): [' + auth.ident +
                '] system=' + body.system + ' talkgroup=' + body.talkgroup)

            return { status: 200, body: 'Transcript accepted (deferred until matching call arrives).\n' }
        }

        return applyInbound(id, body.system, body.talkgroup, body.dateTime, text, auth.ident)
            .then(function (wrote) {
                if (!wrote) {
                    return { status: 200, body: 'Transcript already applied (no-op).\n' }
                }

                return { status: 200, body: 'Transcript updated successfully.\n' }
            })
    }).catch(function (err) {
        rdio.log('warn', 'transcript push failed: [' + auth.ident + '] system=' + body.system +
            ' talkgroup=' + body.talkgroup + ': ' + err)
        return { status: 500, body: 'Could not store transcript.\n' }
    })
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

        return storeTranscript(id, manual).then(function () {
            return { status: 200, body: { id: id, transcript: manual } }
        }).catch(function (err) {
            return { status: 500, body: String(err) }
        })
    }

    if (!enabled()) {
        return { status: 400, body: 'transcription is not configured' }
    }

    // Queued, not transcribed inline.
    //
    // This used to hold the HTTP request open for the whole job: read the
    // audio, call the provider, retry it on a 429 with up to five minutes of
    // backoff, store, emit. A single provider attempt is allowed sixty seconds
    // and the route itself ninety, so a slow one outlived every reverse proxy
    // in front of it — nginx gives up at sixty by default — and the admin who
    // clicked the button got a 502 while the server was still working. The
    // transcript then landed correctly a minute later, with nothing on screen
    // to say so.
    //
    // Nothing about the answer needed the request to stay open. The queue is
    // the same one automatic transcription uses, and it already stores the
    // result, pushes it to every connected client over TRX, and forwards it
    // downstream — so the browser learns the outcome the same way it learns
    // about a transcript that was never asked for by hand.
    return loadCall(id, false).then(function (call) {
        if (!call) return { status: 404, body: 'no such call' }

        enqueue(id, { force: true })

        return { status: 202, body: { id: id, queued: true } }
    }).catch(function (err) {
        return { status: 500, body: String(err) }
    })
})

// Per-system and per-talkgroup transcription settings, for the admin UI.
rdio.routes.register('GET', 'settings', function (req) {
    if (!rdio.admin.verifyToken(req.headers.Authorization || '')) {
        return { status: 401, body: 'unauthorized' }
    }

    return Promise.all([
        rdio.db.queryAsync('select * from `systems`', []),
        rdio.db.queryAsync('select * from `talkgroups`', []),
    ]).then(function (results) {
        return {
        status: 200,
        body: {
            systems: rdio.systems.list(),
            systemSettings: results[0],
            talkgroupSettings: results[1],
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

    var chain = Promise.resolve()

    ;(body.systems || []).forEach(function (system) {
        chain = chain.then(function () {
            return rdio.db.queryAsync('select `systemId` from `systems` where `systemId` = ?', [system.systemId])
        }).then(function (existing) {
            if (existing.length) {
                return rdio.db.execAsync(
                    'update `systems` set `transcribe` = ?, `prompt` = ? where `systemId` = ?',
                    [!!system.transcribe, String(system.prompt || ''), system.systemId]
                )
            }

            return rdio.db.execAsync(
                'insert into `systems` (`systemId`, `transcribe`, `prompt`) values (?, ?, ?)',
                [system.systemId, !!system.transcribe, String(system.prompt || '')]
            )
        })
    })

    ;(body.talkgroups || []).forEach(function (tg) {
        chain = chain.then(function () {
            return rdio.db.queryAsync(
                'select `talkgroupId` from `talkgroups` where `systemId` = ? and `talkgroupId` = ?',
                [tg.systemId, tg.talkgroupId]
            )
        }).then(function (found) {
            if (found.length) {
                return rdio.db.execAsync(
                    'update `talkgroups` set `transcribe` = ? where `systemId` = ? and `talkgroupId` = ?',
                    [!!tg.transcribe, tg.systemId, tg.talkgroupId]
                )
            }

            return rdio.db.execAsync(
                'insert into `talkgroups` (`systemId`, `talkgroupId`, `transcribe`) values (?, ?, ?)',
                [tg.systemId, tg.talkgroupId, !!tg.transcribe]
            )
        })
    })

    return chain.then(function () {
        // These settings are cached for the ingest path, so the cache has to
        // learn about the edit that just happened.
        invalidateTranscribeFlags()

        return { status: 200, body: { saved: true } }
    }).catch(function (err) {
        return { status: 500, body: String(err) }
    })
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

    return storedTranscript(id).then(function (text) {
        return text ? { id: id, transcript: text } : null
    })
})

// Answers "is there a transcript for this call yet", which is the question a
// plugin waiting on one actually has. Cheaper than get() for a caller that only
// needs to know whether to wait.
rdio.plugins.handle('has', function (args) {
    var id = Number(args && args.id)
    if (!id) return { id: id, ready: false }

    return storedTranscript(id).then(function (text) {
        return { id: id, ready: !!text }
    })
})

// Transcribes on demand. Returns a promise, so the caller's own event loop keeps
// running while this one works — and the bus refuses a call from a plugin that
// is itself mid-call, so a cycle fails immediately rather than deadlocking.
rdio.plugins.handle('transcribe', function (args) {
    var id = Number(args && args.id)
    if (!id) throw new Error('transcribe requires an id')

    return storedTranscript(id).then(function (existing) {
        if (existing && !(args && args.force)) {
            return { id: id, transcript: existing, cached: true }
        }

        return transcribeOnDemand(id)
    })
})

function transcribeOnDemand(id) {
    return loadCall(id, true).then(function (call) {
        if (!call) throw new Error('no call ' + id)

        return transcribeCall(id, call)
    })
}

function transcribeCall(id, call) {
    return new Promise(function (resolve, reject) {
        // Callback is (text, err), in that order — matching the two existing
        // callers. Reading it as (err, text) would resolve with the error
        // message as the transcript on every failure, and look like it worked.
        transcribe(call, 0, {}, null, function (text, err) {
            if (err) {
                reject(new Error(String(err)))
                return
            }

            if (!text) {
                resolve({ id: id, transcript: '', cached: false })
                return
            }

            storeTranscript(id, text).then(function () {
                emitTranscript(id, call.system, call.talkgroup, text)
                resolve({ id: id, transcript: text, cached: false })
            }).catch(reject)
        })
    })
}

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
    loadTranscribeFlags()

    // Says plainly which path the call lookups will take. On a host without
    // the async variants everything still works, but reading a call's audio
    // holds the event loop for as long as that read takes — which on a busy
    // server is seconds, and is the one thing left that can.
    var callsApi = rdio.calls.getAsync
        ? 'calls api async'
        : 'calls api synchronous (server 6.14.2+ moves it off the event loop)'

    rdio.log('info', 'transcripts ready (provider ' + activeProvider() +
        ', ' + keys.length + ' key(s), ' + (cfg('enabled') ? 'enabled' : 'disabled') +
        ', ' + callsApi + ')')
})

rdio.on('config.changed', function () {
    publishConfig()
    refreshKeys()
    invalidateTranscribeFlags()
})

// Fallback timers and the pending-transcript cache both need a periodic sweep.
rdio.schedule(15000, function () {
    sweepFallbacks()
    prunePending()
})
