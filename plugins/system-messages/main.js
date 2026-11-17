// System Messages — notices for listeners.
//
// An admin (or another program, through the HTTP API) posts a message; every
// connected listener sees it above the scanner display until it ends or they
// close it. Two kinds are kept apart, system messages and maintenance
// messages, because "the county system is down" and "we are updating the
// server tonight" are different things to read at a glance.
//
// The whole set is small, so it is held in memory and the database is only
// the copy that survives a restart. Every write reloads it, and a timer
// notices the moment a scheduled message starts or a running one expires.

var COMMAND = 'SYM'

var KINDS = ['system', 'maintenance']

var COLORS = ['blue', 'green', 'amber', 'orange', 'red', 'purple', 'grey']

var DEFAULT_COLOR = { system: 'blue', maintenance: 'amber' }

var LIMITS = {
    title: 80,
    body: 500,
    linkUrl: 500,
    linkLabel: 60,
    keyLabel: 60,
    // Messages that are showing or still to come. A program posting in a loop
    // must not be able to push the scanner off the bottom of the screen.
    live: 20,
    stored: 500,
    keys: 50,
}

// Anything outside this is a mistake rather than a date — most often a time
// given in seconds, which read as milliseconds lands in January 1970.
var EARLIEST = Date.UTC(2000, 0, 1)
var LATEST = Date.UTC(2100, 0, 1)

// ---------------------------------------------------------------------------
// Pure parts: no database, no clock of their own. These are what the tests
// exercise directly.
// ---------------------------------------------------------------------------

function isBlank(value) {
    return value === undefined || value === null || value === ''
}

// A point in time, given as an ISO 8601 string or as milliseconds since the
// epoch. Returns {value} or {error}.
function parseTime(value, name) {
    if (isBlank(value)) return { value: null }

    var ms

    if (typeof value === 'number') {
        ms = value
    } else if (typeof value === 'string') {
        var text = value.trim()
        ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text)
    } else {
        return { error: name + ' must be a date-time string or a number of milliseconds' }
    }

    if (typeof ms !== 'number' || !isFinite(ms)) {
        return { error: name + ' is not a date and time this server can read; use ISO 8601, such as 2026-03-01T22:00:00Z' }
    }

    ms = Math.round(ms)

    if (ms < EARLIEST || ms >= LATEST) {
        return { error: name + ' is outside the years 2000 to 2100; a number must be milliseconds, not seconds' }
    }

    return { value: ms }
}

function cleanLine(value) {
    return String(value).replace(/\s+/g, ' ').trim()
}

function cleanText(value) {
    return String(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

// Checks everything about a message before anything is written. Returns
// {value}, the message as it will be stored, or {error}, a sentence a person
// can act on.
function validateMessage(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'the request body must be a JSON object' }
    }

    var out = {}

    if (KINDS.indexOf(input.kind) < 0) {
        return { error: 'kind must be one of: ' + KINDS.join(', ') }
    }
    out.kind = input.kind

    if (isBlank(input.color)) {
        out.color = DEFAULT_COLOR[out.kind]
    } else if (COLORS.indexOf(input.color) < 0) {
        return { error: 'color must be one of: ' + COLORS.join(', ') }
    } else {
        out.color = input.color
    }

    if (typeof input.title !== 'string') {
        return { error: 'title is required' }
    }
    out.title = cleanLine(input.title)
    if (!out.title) {
        return { error: 'title is required' }
    }
    if (out.title.length > LIMITS.title) {
        return { error: 'title is longer than ' + LIMITS.title + ' characters' }
    }

    if (isBlank(input.body)) {
        out.body = null
    } else if (typeof input.body !== 'string') {
        return { error: 'body must be text' }
    } else {
        out.body = cleanText(input.body) || null
        if (out.body && out.body.length > LIMITS.body) {
            return { error: 'body is longer than ' + LIMITS.body + ' characters' }
        }
    }

    if (isBlank(input.linkUrl)) {
        out.linkUrl = null
    } else if (typeof input.linkUrl !== 'string') {
        return { error: 'linkUrl must be text' }
    } else {
        out.linkUrl = input.linkUrl.trim()
        // http and https only. A javascript: or data: address here would run
        // in the page of every listener who clicked it.
        if (!/^https?:\/\/[^\s<>"'`\\]+$/i.test(out.linkUrl)) {
            return { error: 'linkUrl must be an http:// or https:// address' }
        }
        if (out.linkUrl.length > LIMITS.linkUrl) {
            return { error: 'linkUrl is longer than ' + LIMITS.linkUrl + ' characters' }
        }
    }

    if (isBlank(input.linkLabel)) {
        out.linkLabel = null
    } else if (typeof input.linkLabel !== 'string') {
        return { error: 'linkLabel must be text' }
    } else if (!out.linkUrl) {
        return { error: 'linkLabel was given without a linkUrl' }
    } else {
        out.linkLabel = cleanLine(input.linkLabel) || null
        if (out.linkLabel && out.linkLabel.length > LIMITS.linkLabel) {
            return { error: 'linkLabel is longer than ' + LIMITS.linkLabel + ' characters' }
        }
    }

    var starts = parseTime(input.startsAt, 'startsAt')
    if (starts.error) return { error: starts.error }
    out.startsAt = starts.value

    var ends = parseTime(input.endsAt, 'endsAt')
    if (ends.error) return { error: ends.error }
    out.endsAt = ends.value

    if (out.startsAt !== null && out.endsAt !== null && out.endsAt <= out.startsAt) {
        return { error: 'endsAt must be later than startsAt' }
    }

    return { value: out }
}

// When a message with no start of its own begins: the moment it was posted.
function startOf(message) {
    return message.startsAt === null ? message.createdAt : message.startsAt
}

// 'scheduled', 'active' or 'ended'. The end is exclusive: a message ending at
// 22:00 is gone at 22:00.
function stateOf(message, now) {
    if (message.endsAt !== null && message.endsAt <= now) return 'ended'
    if (startOf(message) > now) return 'scheduled'
    return 'active'
}

// System messages first, then maintenance; the most recent first within each.
function displayOrder(a, b) {
    var kind = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
    if (kind !== 0) return kind

    var start = startOf(b) - startOf(a)
    if (start !== 0) return start

    return b.id - a.id
}

function activeMessages(messages, now) {
    return messages
        .filter(function (message) {
            return stateOf(message, now) === 'active'
        })
        .sort(displayOrder)
}

// What a listener's client is sent. Nothing about who posted it.
function toWire(message) {
    return {
        id: message.id,
        revision: message.revision,
        kind: message.kind,
        color: message.color,
        title: message.title,
        body: message.body || '',
        linkUrl: message.linkUrl || '',
        linkLabel: message.linkLabel || '',
        startsAt: startOf(message),
        endsAt: message.endsAt,
    }
}

function isoOrNull(ms) {
    return ms === null ? null : new Date(ms).toISOString()
}

// What the HTTP API returns.
function toApi(message, now) {
    return {
        id: message.id,
        kind: message.kind,
        color: message.color,
        title: message.title,
        body: message.body,
        linkUrl: message.linkUrl,
        linkLabel: message.linkLabel,
        startsAt: isoOrNull(message.startsAt),
        endsAt: isoOrNull(message.endsAt),
        state: stateOf(message, now),
        revision: message.revision,
        source: message.source,
        createdAt: isoOrNull(message.createdAt),
        updatedAt: isoOrNull(message.updatedAt),
    }
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null
    var n = Number(value)
    return isFinite(n) ? n : null
}

function textOrNull(value) {
    return value === undefined || value === null || value === '' ? null : String(value)
}

// A database row as a message. Every number is converted: some drivers hand a
// 64-bit column back as text.
function fromRow(row) {
    return {
        id: Number(row.id),
        uid: String(row.uid),
        kind: String(row.kind),
        color: String(row.color),
        title: String(row.title),
        body: textOrNull(row.body),
        linkUrl: textOrNull(row.linkUrl),
        linkLabel: textOrNull(row.linkLabel),
        startsAt: numberOrNull(row.startsAt),
        endsAt: numberOrNull(row.endsAt),
        revision: Number(row.revision) || 1,
        source: String(row.source),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
    }
}

// A row id from a query string: a positive whole number and nothing else.
function parseId(value) {
    var text = String(value === undefined || value === null ? '' : value)
    return /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : null
}

// The key a request presented, from X-API-Key or from Authorization: Bearer.
function presentedKey(headers) {
    headers = headers || {}

    var direct = headers['x-api-key'] || headers['X-Api-Key'] || headers['X-API-Key']
    if (typeof direct === 'string' && direct.trim()) return direct.trim()

    var authorization = headers.authorization || headers.Authorization
    if (typeof authorization === 'string') {
        var match = /^Bearer\s+(\S+)\s*$/i.exec(authorization)
        if (match) return match[1]
    }

    return ''
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var messages = [] // every stored message, newest id first
var keys = [] // {id, label, hash, createdAt, lastUsedAt}
var ready = null // the promise of the first load
var lastSent = null // what listeners were last told, as text
var keyTouched = {} // key id -> when its last use was last written

// Numbers are bound as text. A JavaScript number can reach the database
// driver as a float, and "1.7e+12" is not something a 64-bit column accepts;
// digits are read correctly by all three databases.
function num(value) {
    return value === null || value === undefined ? null : String(Math.round(value))
}

function loadMessages() {
    return rdio.db
        .queryAsync('select * from `messages` where `id` > ? order by `id` desc', ['0'])
        .then(function (rows) {
            messages = (rows || []).map(fromRow)
            return messages
        })
}

function loadKeys() {
    return rdio.db
        .queryAsync('select * from `keys` where `id` > ? order by `id`', ['0'])
        .then(function (rows) {
            keys = (rows || []).map(function (row) {
                return {
                    id: Number(row.id),
                    label: String(row.label),
                    hash: String(row.hash),
                    createdAt: Number(row.createdAt),
                    lastUsedAt: numberOrNull(row.lastUsedAt),
                }
            })
            return keys
        })
}

function whenReady() {
    if (!ready) {
        ready = Promise.all([loadMessages(), loadKeys()]).then(
            function () {
                lastSent = JSON.stringify(currentWire())
            },
            function (err) {
                // Not kept: the next request tries again instead of failing
                // for as long as the server runs.
                ready = null
                throw err
            }
        )
    }
    return ready
}

function currentWire() {
    return activeMessages(messages, Date.now()).map(toWire)
}

// Tells every listener what is showing now, if that is not what they were
// last told.
function announce() {
    var wire = currentWire()
    var text = JSON.stringify(wire)

    if (text === lastSent) return
    lastSent = text

    rdio.ws.emit(null, COMMAND, { messages: wire })
}

function findMessage(id) {
    for (var i = 0; i < messages.length; i++) {
        if (messages[i].id === id) return messages[i]
    }
    return null
}

function liveCount(now, exceptId) {
    return messages.filter(function (message) {
        return message.id !== exceptId && stateOf(message, now) !== 'ended'
    }).length
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

var JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function reply(status, body) {
    return { status: status, headers: JSON_HEADERS, body: body }
}

function fail(status, message) {
    return reply(status, { error: message })
}

function readBody(req) {
    var body
    try {
        body = JSON.parse(req.body)
    } catch (err) {
        return null
    }
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function listMessages(req) {
    var now = Date.now()
    var only = req.query && String(req.query.active || '').toLowerCase()
    var list = only === 'true' || only === '1' ? activeMessages(messages, now) : messages

    return reply(200, {
        messages: list.map(function (message) {
            return toApi(message, now)
        }),
    })
}

function getMessage(req) {
    var id = parseId(req.query && req.query.id)
    if (id === null) return fail(400, 'id must be a positive whole number')

    var message = findMessage(id)
    if (!message) return fail(404, 'no message has that id')

    return reply(200, toApi(message, Date.now()))
}

function createMessage(req, source) {
    var body = readBody(req)
    if (!body) return fail(400, 'the request body must be a JSON object')

    var checked = validateMessage(body)
    if (checked.error) return fail(400, checked.error)

    var value = checked.value
    var now = Date.now()

    if (messages.length >= LIMITS.stored) {
        return fail(409, 'there are already ' + LIMITS.stored + ' stored messages; delete some that have ended')
    }

    var endsLater = value.endsAt === null || value.endsAt > now
    if (endsLater && liveCount(now, null) >= LIMITS.live) {
        return fail(409, 'there are already ' + LIMITS.live + ' messages showing or scheduled; end one first')
    }

    var uid = rdio.crypto.uuid()

    return rdio.db
        .execAsync(
            'insert into `messages` (`uid`, `kind`, `color`, `title`, `body`, `linkUrl`, `linkLabel`, ' +
                '`startsAt`, `endsAt`, `revision`, `source`, `createdAt`, `updatedAt`) ' +
                'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                uid,
                value.kind,
                value.color,
                value.title,
                value.body,
                value.linkUrl,
                value.linkLabel,
                num(value.startsAt),
                num(value.endsAt),
                '1',
                source,
                num(now),
                num(now),
            ]
        )
        .then(loadMessages)
        .then(function () {
            announce()

            for (var i = 0; i < messages.length; i++) {
                if (messages[i].uid === uid) return reply(201, toApi(messages[i], Date.now()))
            }

            return fail(500, 'the message was stored but could not be read back')
        })
}

function updateMessage(req) {
    var id = parseId(req.query && req.query.id)
    if (id === null) return fail(400, 'id must be a positive whole number')

    var body = readBody(req)
    if (!body) return fail(400, 'the request body must be a JSON object')

    var checked = validateMessage(body)
    if (checked.error) return fail(400, checked.error)

    var existing = findMessage(id)
    if (!existing) return fail(404, 'no message has that id')

    var value = checked.value
    var now = Date.now()

    var endsLater = value.endsAt === null || value.endsAt > now
    if (endsLater && liveCount(now, id) >= LIMITS.live) {
        return fail(409, 'there are already ' + LIMITS.live + ' messages showing or scheduled; end one first')
    }

    return rdio.db
        .execAsync(
            'update `messages` set `kind` = ?, `color` = ?, `title` = ?, `body` = ?, `linkUrl` = ?, ' +
                '`linkLabel` = ?, `startsAt` = ?, `endsAt` = ?, `revision` = `revision` + 1, `updatedAt` = ? ' +
                'where `id` = ?',
            [
                value.kind,
                value.color,
                value.title,
                value.body,
                value.linkUrl,
                value.linkLabel,
                num(value.startsAt),
                num(value.endsAt),
                num(now),
                num(id),
            ]
        )
        .then(loadMessages)
        .then(function () {
            announce()

            var message = findMessage(id)
            return message ? reply(200, toApi(message, Date.now())) : fail(404, 'no message has that id')
        })
}

function endMessage(req) {
    var id = parseId(req.query && req.query.id)
    if (id === null) return fail(400, 'id must be a positive whole number')

    var existing = findMessage(id)
    if (!existing) return fail(404, 'no message has that id')

    var now = Date.now()

    // Already over: ending it again changes nothing, and must not move the
    // time it really ended.
    if (stateOf(existing, now) === 'ended') return reply(200, toApi(existing, now))

    return rdio.db
        .execAsync('update `messages` set `endsAt` = ?, `updatedAt` = ? where `id` = ?', [num(now), num(now), num(id)])
        .then(loadMessages)
        .then(function () {
            announce()

            var message = findMessage(id)
            return message ? reply(200, toApi(message, Date.now())) : fail(404, 'no message has that id')
        })
}

function deleteMessage(req) {
    var id = parseId(req.query && req.query.id)
    if (id === null) return fail(400, 'id must be a positive whole number')

    if (!findMessage(id)) return fail(404, 'no message has that id')

    return rdio.db
        .execAsync('delete from `messages` where `id` = ?', [num(id)])
        .then(loadMessages)
        .then(function () {
            announce()
            return { status: 204 }
        })
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
//
// Only a key's SHA-256 is stored, so the list of keys in the database opens
// nothing. The key itself exists in one place: the response to the request
// that created it.

function hashKey(key) {
    return rdio.crypto.hash('sha256', key)
}

function keyFor(req) {
    var presented = presentedKey(req.headers)
    if (!presented) return null

    var hash = hashKey(presented)

    for (var i = 0; i < keys.length; i++) {
        if (keys[i].hash === hash) return keys[i]
    }

    return null
}

// Records that a key was used, at most once a minute so a busy client does
// not turn every request into a write.
function touchKey(key) {
    var now = Date.now()
    if (keyTouched[key.id] && now - keyTouched[key.id] < 60000) return

    keyTouched[key.id] = now
    key.lastUsedAt = now

    rdio.db
        .execAsync('update `keys` set `lastUsedAt` = ? where `id` = ?', [num(now), num(key.id)])
        .then(null, function (err) {
            rdio.log('warn', 'system-messages: could not record a key use: ' + err)
        })
}

function keyToApi(key) {
    return {
        id: key.id,
        label: key.label,
        createdAt: isoOrNull(key.createdAt),
        lastUsedAt: isoOrNull(key.lastUsedAt),
    }
}

function listKeys() {
    return reply(200, { keys: keys.map(keyToApi) })
}

function createKey(req) {
    var body = readBody(req)
    if (!body) return fail(400, 'the request body must be a JSON object')

    var label = typeof body.label === 'string' ? cleanLine(body.label) : ''
    if (!label) return fail(400, 'label is required: say what will use this key')
    if (label.length > LIMITS.keyLabel) return fail(400, 'label is longer than ' + LIMITS.keyLabel + ' characters')

    if (keys.length >= LIMITS.keys) return fail(409, 'there are already ' + LIMITS.keys + ' keys; revoke one first')

    var key = 'sm_' + rdio.crypto.hexEncode(rdio.crypto.randomBytes(24))
    var hash = hashKey(key)
    var now = Date.now()

    return rdio.db
        .execAsync('insert into `keys` (`label`, `hash`, `createdAt`) values (?, ?, ?)', [label, hash, num(now)])
        .then(loadKeys)
        .then(function () {
            for (var i = 0; i < keys.length; i++) {
                if (keys[i].hash === hash) {
                    var created = keyToApi(keys[i])
                    created.key = key
                    return reply(201, created)
                }
            }

            return fail(500, 'the key was stored but could not be read back')
        })
}

function deleteKey(req) {
    var id = parseId(req.query && req.query.id)
    if (id === null) return fail(400, 'id must be a positive whole number')

    var found = keys.some(function (key) {
        return key.id === id
    })
    if (!found) return fail(404, 'no key has that id')

    return rdio.db
        .execAsync('delete from `keys` where `id` = ?', [num(id)])
        .then(loadKeys)
        .then(function () {
            delete keyTouched[id]
            return { status: 204 }
        })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Every route this plugin serves, so the tests can hold the published
// contract to it.
var ROUTES = []

// Who may call a route. Each returns the name the message is filed under, or
// null to refuse.
function asAdmin(req) {
    var headers = req.headers || {}
    return rdio.admin.verifyToken(headers.Authorization || headers.authorization || '') ? 'admin' : null
}

function asKeyHolder(req) {
    var key = keyFor(req)
    if (!key) return null

    touchKey(key)
    return key.label
}

function asAnyone() {
    return 'anyone'
}

function route(method, path, who, handler) {
    ROUTES.push({ method: method, path: path, access: who === asAdmin ? 'admin' : who === asKeyHolder ? 'key' : 'open' })

    rdio.routes.register(method, path, function (req) {
        return whenReady()
            .then(function () {
                var caller = who(req)

                if (!caller) {
                    return who === asAdmin
                        ? fail(401, 'sign in to the administration page')
                        : fail(401, 'a valid API key is required, in the X-API-Key header')
                }

                return handler(req, caller)
            })
            .then(null, function (err) {
                rdio.log('error', 'system-messages: ' + method + ' ' + path + ' failed: ' + err)
                return fail(500, 'the server could not complete the request')
            })
    })
}

// The administration page reaches these through ctx.api in the webapp, which
// shapes what they can answer with. It sends GET and POST only; it reads every
// answer as JSON, so an empty one is an error to it; and anything but a 2xx
// reaches the page as the bare words "HTTP 400", with the reason thrown away.
// So for the page, a refusal travels as a 200 carrying {error, status}, and
// "done, nothing to say" as {ok: true}. A missing or expired login stays a
// real 401, because that is what tells the page to sign in again.
function forPage(handler) {
    return function (req, caller) {
        return Promise.resolve(handler(req, caller)).then(function (res) {
            if (res.status === 204) return reply(200, { ok: true })

            if (res.status >= 400 && res.status < 500 && res.status !== 401) {
                return reply(200, { error: res.body.error, status: res.status })
            }

            return res
        })
    }
}

route('GET', 'admin/messages', asAdmin, forPage(listMessages))
route('POST', 'admin/messages', asAdmin, forPage(createMessage))
route('POST', 'admin/messages/update', asAdmin, forPage(updateMessage))
route('POST', 'admin/messages/end', asAdmin, forPage(endMessage))
route('POST', 'admin/messages/delete', asAdmin, forPage(deleteMessage))
route('GET', 'admin/keys', asAdmin, forPage(listKeys))
route('POST', 'admin/keys', asAdmin, forPage(createKey))
route('POST', 'admin/keys/delete', asAdmin, forPage(deleteKey))

// The API for other programs, described by openapi.json.
route('GET', 'v1/messages', asKeyHolder, listMessages)
route('POST', 'v1/messages', asKeyHolder, createMessage)
route('GET', 'v1/messages/item', asKeyHolder, getMessage)
route('PUT', 'v1/messages/item', asKeyHolder, updateMessage)
route('DELETE', 'v1/messages/item', asKeyHolder, deleteMessage)
route('POST', 'v1/messages/end', asKeyHolder, endMessage)

// The contract itself, read from the file that ships with the plugin so the
// published description and the running one cannot drift apart.
var openapiText = null

route('GET', 'v1/openapi.json', asAnyone, function () {
    if (openapiText === null) {
        try {
            openapiText = rdio.fs.readText(rdio.plugin.dir + '/openapi.json')
        } catch (err) {
            // A server started with a relative base folder reports a relative
            // plugin folder, and a relative path is read from this plugin's
            // data folder instead. The two folders are siblings two levels
            // up, so the file can be reached from there.
            openapiText = rdio.fs.readText('../../plugins/' + rdio.plugin.id + '/openapi.json')
        }
    }

    return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: openapiText,
    }
})

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

// A client asking what is showing: sent when it connects, since a push only
// reaches whoever was connected at the time.
rdio.ws.on(COMMAND, function (client) {
    whenReady().then(
        function () {
            rdio.ws.emit({ client: client }, COMMAND, { messages: currentWire() })
        },
        function (err) {
            rdio.log('error', 'system-messages: could not load messages: ' + err)
        }
    )
})

rdio.on('startup', function () {
    whenReady().then(
        function () {
            rdio.log('info', 'system-messages started, version ' + rdio.plugin.version)
        },
        function (err) {
            rdio.log('error', 'system-messages: could not load messages: ' + err)
        }
    )
})

// Nothing is written when a scheduled message starts or a running one runs
// out, so the clock has to be watched.
rdio.schedule(2000, function () {
    if (lastSent === null) return
    announce()
})
