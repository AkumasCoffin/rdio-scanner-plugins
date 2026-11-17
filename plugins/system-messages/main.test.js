/*
 * Tests for the parts of the server half that decide things: what a valid
 * message is, when one is showing, the order listeners see them in, and that
 * the published OpenAPI document describes exactly the routes that exist.
 *
 * main.js is loaded into a sandbox with a stand-in for `rdio` that records
 * what was registered and has no database behind it.
 *
 * Run: node main.test.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function load() {
    const registered = []
    const emitted = []

    const rdio = {
        plugin: { id: 'system-messages', version: 'test', dir: __dirname },
        log() {},
        on() {},
        schedule() {},
        routes: {
            register(method, route, handler) {
                registered.push({ method, path: route, handler })
            },
        },
        ws: {
            on() {},
            emit(filter, command, payload) {
                emitted.push({ filter, command, payload })
            },
        },
        admin: { verifyToken: (token) => token === 'good-token' },
        crypto: {
            hash: (algorithm, data) => require('crypto').createHash(algorithm).update(data).digest('hex'),
            uuid: () => require('crypto').randomUUID(),
            randomBytes: (n) => require('crypto').randomBytes(n),
            hexEncode: (data) => Buffer.from(data).toString('hex'),
        },
        fs: { readText: (file) => fs.readFileSync(file, 'utf8') },
        db: {
            queryAsync: () => Promise.resolve([]),
            execAsync: () => Promise.resolve(0),
        },
    }

    const context = vm.createContext({ rdio, console, Promise, Date, JSON, Math })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), context, { filename: 'main.js' })

    return { m: context, registered, emitted }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// vm objects have another realm's prototypes, which deepStrictEqual minds.
const plain = (value) => JSON.parse(JSON.stringify(value))

// ---------------------------------------------------------------------------
// validateMessage
// ---------------------------------------------------------------------------

test('a minimal message is accepted and filled in', () => {
    const { m } = load()
    assert.deepStrictEqual(plain(m.validateMessage({ kind: 'system', title: 'Down' })), {
        value: { kind: 'system', color: 'green', title: 'Down', body: null, linkUrl: null, linkLabel: null, startsAt: null, endsAt: null },
    })
    assert.strictEqual(m.validateMessage({ kind: 'maintenance', title: 'x' }).value.color, 'blue')
})

test('each kind takes its own three colours, and not the other kind\'s', () => {
    const { m } = load()
    const own = { system: ['green', 'yellow', 'purple'], maintenance: ['blue', 'amber', 'red'] }

    assert.deepStrictEqual(plain(m.COLORS), own)

    for (const kind of Object.keys(own)) {
        const other = kind === 'system' ? 'maintenance' : 'system'

        for (const color of own[kind]) {
            assert.strictEqual(m.validateMessage({ kind, title: 'x', color }).value.color, color)
        }
        for (const color of own[other]) {
            assert.match(m.validateMessage({ kind, title: 'x', color }).error, new RegExp(own[kind].join(', ')), `${kind} ${color}`)
        }
        // Colours version 1.0 offered and this one does not.
        for (const color of ['orange', 'grey', 'pink', 'GREEN', '#ff0000', 7, {}]) {
            assert.ok(m.validateMessage({ kind, title: 'x', color }).error, `${kind} ${String(color)}`)
        }
    }

    // No colour belongs to both kinds, or the colour would not tell them apart.
    assert.strictEqual(own.system.filter((c) => own.maintenance.includes(c)).length, 0)
})

test('kind must be one of the two', () => {
    const { m } = load()
    for (const kind of [undefined, null, '', 'outage', 'System', 1]) {
        assert.ok(m.validateMessage({ kind, title: 'x' }).error, String(kind))
    }
})

test('title: required, one line, 80 characters at most', () => {
    const { m } = load()
    assert.ok(m.validateMessage({ kind: 'system' }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: ' \n\t ' }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: 42 }).error)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: '  two\n lines  ' }).value.title, 'two lines')
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x'.repeat(80) }).value.title.length, 80)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x'.repeat(81) }).error)
})

test('body: optional, line breaks kept, 500 characters at most', () => {
    const { m } = load()
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', body: '' }).value.body, null)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', body: '   ' }).value.body, null)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', body: ' a \r\nb\r\n\r\n\r\n\r\nc ' }).value.body, 'a\nb\n\nc')
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', body: 'y'.repeat(500) }).value.body.length, 500)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', body: 'y'.repeat(501) }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', body: ['a'] }).error)
})

test('markup in the text is kept as written, not stripped', () => {
    const { m } = load()
    const text = '<script>alert(1)</script> & "quotes"'
    const out = m.validateMessage({ kind: 'system', title: text, body: text }).value
    assert.strictEqual(out.title, text)
    assert.strictEqual(out.body, text)
})

test('link: http and https only', () => {
    const { m } = load()
    for (const linkUrl of ['http://example.com', 'https://example.com/a?b=1&c=2#d', 'HTTPS://EXAMPLE.COM']) {
        assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', linkUrl }).value.linkUrl, linkUrl)
    }
    for (const linkUrl of [
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        ' javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:x',
        'file:///etc/passwd',
        '//example.com',
        'example.com',
        'https://',
        'https://example.com/a b',
        'https://example.com/"onmouseover="x',
        'https://example.com/\nx',
        'https://example.com/' + 'a'.repeat(500),
        7,
    ]) {
        assert.ok(m.validateMessage({ kind: 'system', title: 'x', linkUrl }).error, String(linkUrl))
    }
})

test('a link label needs a link', () => {
    const { m } = load()
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', linkLabel: 'More' }).error)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', linkUrl: 'https://e.com', linkLabel: ' Status\npage ' }).value.linkLabel, 'Status page')
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', linkUrl: 'https://e.com', linkLabel: 'x'.repeat(61) }).error)
})

test('times: ISO 8601 or milliseconds, and the end after the start', () => {
    const { m } = load()
    const at = Date.UTC(2026, 2, 1, 22, 0, 0)

    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: '2026-03-01T22:00:00Z' }).value.startsAt, at)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: '2026-03-02T09:00:00+11:00' }).value.startsAt, at)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: at }).value.startsAt, at)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: String(at) }).value.startsAt, at)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: '' }).value.startsAt, null)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', endsAt: null }).value.endsAt, null)

    assert.ok(m.validateMessage({ kind: 'system', title: 'x', endsAt: 'tomorrow' }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', endsAt: true }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', endsAt: NaN }).error)
    // Seconds rather than milliseconds is the mistake a caller will make.
    assert.match(m.validateMessage({ kind: 'system', title: 'x', endsAt: Math.floor(at / 1000) }).error, /milliseconds/)

    assert.ok(m.validateMessage({ kind: 'system', title: 'x', startsAt: at, endsAt: at }).error)
    assert.ok(m.validateMessage({ kind: 'system', title: 'x', startsAt: at, endsAt: at - 1 }).error)
    assert.strictEqual(m.validateMessage({ kind: 'system', title: 'x', startsAt: at, endsAt: at + 1 }).value.endsAt, at + 1)
})

test('something that is not an object is refused', () => {
    const { m } = load()
    for (const input of [null, undefined, 'text', 7, [], [{ kind: 'system', title: 'x' }]]) {
        assert.ok(m.validateMessage(input).error)
    }
})

// ---------------------------------------------------------------------------
// When a message shows
// ---------------------------------------------------------------------------

const message = (over) => Object.assign({ id: 1, kind: 'system', color: 'blue', title: 't', body: null, linkUrl: null, linkLabel: null, startsAt: null, endsAt: null, revision: 1, source: 'admin', createdAt: 1000, updatedAt: 1000 }, over)

test('state at the boundaries', () => {
    const { m } = load()

    // No start of its own: it began when it was posted.
    assert.strictEqual(m.stateOf(message({}), 1000), 'active')
    assert.strictEqual(m.stateOf(message({}), 999999), 'active')

    // The start is inclusive.
    assert.strictEqual(m.stateOf(message({ startsAt: 5000 }), 4999), 'scheduled')
    assert.strictEqual(m.stateOf(message({ startsAt: 5000 }), 5000), 'active')

    // The end is exclusive.
    assert.strictEqual(m.stateOf(message({ endsAt: 9000 }), 8999), 'active')
    assert.strictEqual(m.stateOf(message({ endsAt: 9000 }), 9000), 'ended')

    // Ended before it ever started is ended, not scheduled.
    assert.strictEqual(m.stateOf(message({ startsAt: 5000, endsAt: 3000 }), 4000), 'ended')
})

test('listeners see system first, then maintenance, newest first in each', () => {
    const { m } = load()
    const list = [
        message({ id: 1, kind: 'maintenance', createdAt: 100 }),
        message({ id: 2, kind: 'system', createdAt: 200 }),
        message({ id: 3, kind: 'maintenance', startsAt: 900, createdAt: 50 }),
        message({ id: 4, kind: 'system', createdAt: 300 }),
        message({ id: 5, kind: 'system', createdAt: 300 }),
        message({ id: 6, kind: 'system', startsAt: 5000 }),
        message({ id: 7, kind: 'system', endsAt: 500 }),
    ]
    assert.deepStrictEqual(plain(m.activeMessages(list, 1000).map((x) => x.id)), [5, 4, 2, 3, 1])
})

test('what a listener is sent says nothing about who posted it', () => {
    const { m } = load()
    const wire = plain(m.toWire(message({ id: 9, revision: 3, source: 'secret key label', body: 'b', createdAt: 1234 })))
    assert.deepStrictEqual(wire, { id: 9, revision: 3, kind: 'system', color: 'blue', title: 't', body: 'b', linkUrl: '', linkLabel: '', startsAt: 1234, endsAt: null })
})

test('the API form carries ISO times and the state', () => {
    const { m } = load()
    const at = Date.UTC(2026, 2, 1, 22, 0, 0)
    const api = plain(m.toApi(message({ startsAt: at, endsAt: at + 60000, createdAt: at - 1000, updatedAt: at - 1000 }), at))
    assert.strictEqual(api.startsAt, '2026-03-01T22:00:00.000Z')
    assert.strictEqual(api.endsAt, '2026-03-01T22:01:00.000Z')
    assert.strictEqual(api.state, 'active')
    assert.strictEqual(plain(m.toApi(message({}), 2000)).startsAt, null)
})

test('a row from a driver that returns numbers as text is read correctly', () => {
    const { m } = load()
    const row = { id: '7', uid: 'u', kind: 'system', color: 'red', title: 't', body: null, linkUrl: '', linkLabel: null, startsAt: '1772402400000', endsAt: null, revision: '2', source: 'admin', createdAt: '1772402400000', updatedAt: '1772402400000' }
    const out = plain(m.fromRow(row))
    assert.strictEqual(out.id, 7)
    assert.strictEqual(out.startsAt, 1772402400000)
    assert.strictEqual(out.endsAt, null)
    assert.strictEqual(out.linkUrl, null)
    assert.strictEqual(out.revision, 2)
})

test('an id is a positive whole number and nothing else', () => {
    const { m } = load()
    assert.strictEqual(m.parseId('12'), 12)
    assert.strictEqual(m.parseId(12), 12)
    for (const id of ['', '0', '-1', '1.5', '1e3', ' 1', '1 or 1=1', 'abc', '01', '1234567890', null, undefined, {}]) {
        assert.strictEqual(m.parseId(id), null, String(id))
    }
})

test('the key is read from X-API-Key or from Authorization: Bearer', () => {
    const { m } = load()
    assert.strictEqual(m.presentedKey({ 'x-api-key': 'sm_a' }), 'sm_a')
    assert.strictEqual(m.presentedKey({ 'X-Api-Key': ' sm_a ' }), 'sm_a')
    assert.strictEqual(m.presentedKey({ authorization: 'Bearer sm_b' }), 'sm_b')
    assert.strictEqual(m.presentedKey({ Authorization: 'bearer   sm_b' }), 'sm_b')
    assert.strictEqual(m.presentedKey({ 'x-api-key': 'sm_a', authorization: 'Bearer sm_b' }), 'sm_a')
    assert.strictEqual(m.presentedKey({ authorization: 'sm_b' }), '')
    assert.strictEqual(m.presentedKey({ authorization: 'Basic abc' }), '')
    assert.strictEqual(m.presentedKey({}), '')

    // Both are offered, so a header a client library filled in with something
    // of its own does not hide the key in the other one.
    assert.deepStrictEqual(plain(m.presentedKeys({ 'x-api-key': 'sm_a', authorization: 'Bearer sm_b' })), ['sm_a', 'sm_b'])
    assert.deepStrictEqual(plain(m.presentedKeys({ 'x-api-key': 'sm_a', authorization: 'Bearer sm_a' })), ['sm_a'])
    assert.deepStrictEqual(plain(m.presentedKeys({})), [])
    assert.strictEqual(m.presentedKey(undefined), '')
})

// ---------------------------------------------------------------------------
// Routes and the contract
// ---------------------------------------------------------------------------

test('every route refuses a caller it does not know', async () => {
    const { m, registered } = load()

    for (const entry of plain(m.ROUTES)) {
        const handler = registered.find((r) => r.method === entry.method && r.path === entry.path).handler
        const res = await handler({ method: entry.method, headers: {}, query: {}, body: '' })

        if (entry.access === 'open') {
            assert.strictEqual(res.status, 200, `${entry.method} ${entry.path}`)
        } else {
            assert.strictEqual(res.status, 401, `${entry.method} ${entry.path}`)
        }
    }
})

test('an admin token does not open the key API, and a key does not open the admin routes', async () => {
    const { m, registered } = load()
    const find = (method, route) => registered.find((r) => r.method === method && r.path === route).handler

    const asAdmin = await find('GET', 'admin/messages')({ headers: { Authorization: 'good-token' }, query: {}, body: '' })
    assert.strictEqual(asAdmin.status, 200)

    const tokenAsKey = await find('GET', 'v1/messages')({ headers: { 'x-api-key': 'good-token', Authorization: 'good-token' }, query: {}, body: '' })
    assert.strictEqual(tokenAsKey.status, 401)

    const keyAsAdmin = await find('GET', 'admin/messages')({ headers: { 'x-api-key': 'sm_whatever', Authorization: 'Bearer sm_whatever' }, query: {}, body: '' })
    assert.strictEqual(keyAsAdmin.status, 401)

    assert.ok(plain(m.ROUTES).length > 0)
})

test('writes take turns, so a burst cannot all pass a limit before any has written', async () => {
    const { m, registered } = load()
    const create = registered.find((r) => r.method === 'POST' && r.path === 'v1/messages').handler

    // A database that takes a moment over each statement and really keeps rows.
    const rows = []
    const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 2))
    m.rdio.db.queryAsync = (sql) => later(sql.includes('`keys`') ? [{ id: 1, label: 'k', hash: m.hashKey('sm_k'), createdAt: 1, lastUsedAt: null }] : rows.slice().reverse())
    m.rdio.db.execAsync = (sql, args) => {
        if (sql.startsWith('insert into `messages`')) {
            return later().then(() => {
                rows.push({ id: rows.length + 1, uid: args[0], kind: args[1], color: args[2], title: args[3], body: null, linkUrl: null, linkLabel: null, startsAt: null, endsAt: null, revision: 1, source: args[10], createdAt: args[11], updatedAt: args[12] })
                return 1
            })
        }
        return later(1)
    }

    const post = (i) => create({ headers: { 'x-api-key': 'sm_k' }, query: {}, body: JSON.stringify({ kind: 'system', title: 'burst ' + i }) })
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => post(i)))

    const limit = plain(m.LIMITS).live
    assert.strictEqual(results.filter((r) => r.status === 201).length, limit)
    assert.strictEqual(results.filter((r) => r.status === 409).length, 30 - limit)
    assert.strictEqual(rows.length, limit)
})

test('a revoked key stops working even if reading the keys back fails', async () => {
    const { m, registered } = load()
    const find = (method, route) => registered.find((r) => r.method === method && r.path === route).handler

    let failReads = false
    m.rdio.db.queryAsync = (sql) => {
        if (failReads) return Promise.reject(new Error('connection lost'))
        return Promise.resolve(sql.includes('`keys`') ? [{ id: 1, label: 'k', hash: m.hashKey('sm_k'), createdAt: 1, lastUsedAt: null }] : [])
    }

    const key = { 'x-api-key': 'sm_k' }
    assert.strictEqual((await find('GET', 'v1/messages')({ headers: key, query: {}, body: '' })).status, 200)

    failReads = true
    const revoked = await find('POST', 'admin/keys/delete')({ headers: { Authorization: 'good-token' }, query: { id: '1' }, body: '' })
    assert.strictEqual(revoked.status, 500)

    assert.strictEqual((await find('GET', 'v1/messages')({ headers: key, query: {}, body: '' })).status, 401)
})

test('openapi.json describes exactly the v1 routes that exist', () => {
    const { m } = load()
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'))

    const inSpec = []
    for (const [route, item] of Object.entries(spec.paths)) {
        for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
            if (item[method]) inSpec.push(`${method.toUpperCase()} ${route.replace(/^\//, '')}`)
        }
    }

    const inCode = plain(m.ROUTES)
        .filter((r) => r.path.startsWith('v1/'))
        .map((r) => `${r.method} ${r.path}`)

    assert.deepStrictEqual(inSpec.sort(), inCode.sort())
})

test('openapi.json states the same limits and lists the code enforces', () => {
    const { m } = load()
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'))
    const schemas = spec.components.schemas
    const limits = plain(m.LIMITS)

    assert.deepStrictEqual(schemas.Kind.enum, plain(m.KINDS))
    assert.deepStrictEqual(schemas.SystemColor.enum, plain(m.COLORS).system)
    assert.deepStrictEqual(schemas.MaintenanceColor.enum, plain(m.COLORS).maintenance)

    // Every example in the document is a message the server would accept.
    const examples = []
    const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.kind && node.title && typeof node.kind === 'string') examples.push(node)
        Object.values(node).forEach(walk)
    }
    walk(spec.paths)
    assert.ok(examples.length >= 4)
    for (const example of examples) {
        const input = { kind: example.kind, color: example.color, title: example.title, body: example.body, linkUrl: example.linkUrl, linkLabel: example.linkLabel }
        assert.strictEqual(m.validateMessage(input).error, undefined, JSON.stringify(input))
    }
    assert.strictEqual(schemas.MessageInput.properties.title.maxLength, limits.title)
    assert.strictEqual(schemas.MessageInput.properties.body.maxLength, limits.body)
    assert.strictEqual(schemas.MessageInput.properties.linkUrl.maxLength, limits.linkUrl)
    assert.strictEqual(schemas.MessageInput.properties.linkLabel.maxLength, limits.linkLabel)
    assert.ok(spec.info.description.includes(`At most ${limits.live} messages`))
    assert.ok(spec.info.description.includes(`at most ${limits.stored} stored`))

    const times = schemas.TimeInput.oneOf.find((s) => s.type === 'integer')
    assert.strictEqual(times.minimum, m.EARLIEST)
    assert.strictEqual(times.exclusiveMaximum, m.LATEST)

    // Every operation says what a missing key gets, unless it needs none.
    for (const [route, item] of Object.entries(spec.paths)) {
        for (const method of ['get', 'post', 'put', 'delete']) {
            const op = item[method]
            if (!op) continue
            assert.ok(op.operationId && op.summary, `${method} ${route} needs an operationId and a summary`)
            const open = Array.isArray(op.security) && op.security.length === 0
            assert.strictEqual(!!op.responses['401'], !open, `${method} ${route}`)
        }
    }

    // Every $ref points at something.
    const refs = JSON.stringify(spec).match(/"#\/[^"]+"/g) || []
    for (const ref of refs) {
        let node = spec
        for (const part of JSON.parse(ref).slice(2).split('/')) node = node && node[part]
        assert.ok(node, `dangling ${ref}`)
    }
})

test('the manifest and the code agree on the version and the columns written', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'))
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'))
    const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')

    assert.strictEqual(spec.info.version, manifest.version)

    // A table name that is also a column name would be rewritten by the host
    // wherever it appears in backticks.
    const tables = manifest.tables.map((t) => t.name)
    for (const table of manifest.tables) {
        for (const column of table.columns) {
            assert.ok(!tables.includes(column.name), `column ${column.name} is also a table name`)
        }
    }

    const declared = new Set(manifest.tables.flatMap((t) => t.columns.map((c) => c.name)).concat(tables))
    for (const name of new Set((source.match(/`([A-Za-z]+)`/g) || []).map((s) => s.slice(1, -1)))) {
        assert.ok(declared.has(name), `main.js names \`${name}\`, which the manifest does not declare`)
    }
})

;(async () => {
    let failed = 0
    for (const { name, fn } of tests) {
        try {
            await fn()
            console.log('ok   ' + name)
        } catch (err) {
            failed++
            console.log('FAIL ' + name + '\n     ' + String(err && err.message).split('\n').join('\n     '))
        }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
})()
