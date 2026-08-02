// Hello World — reference plugin for Rdio Scanner.
//
// Demonstrates the whole plugin surface end to end: config, tables, call hooks,
// an HTTP endpoint, a websocket command, and a value exposed to the webapp.

rdio.on('startup', function () {
    rdio.log('info', 'hello-world started, version ' + rdio.plugin.version)

    // Let the frontend know whether it should render at all, and with what label.
    rdio.config.expose('helloWorldEnabled', rdio.config.get('enabled'))
    rdio.config.expose('helloWorldLabel', rdio.config.get('label'))
})

rdio.on('config.changed', function () {
    rdio.config.expose('helloWorldEnabled', rdio.config.get('enabled'))
    rdio.config.expose('helloWorldLabel', rdio.config.get('label'))
})

// Bump the counter for every stored call, then tell any listening client.
rdio.on('call.stored', function (call) {
    if (!rdio.config.get('enabled')) return

    var rows = rdio.db.query(
        'select `count` from `counts` where `system` = ? and `talkgroup` = ?',
        [call.system, call.talkgroup]
    )

    var count
    if (rows.length === 0) {
        count = 1
        rdio.db.exec(
            'insert into `counts` (`system`, `talkgroup`, `count`, `lastSeen`) values (?, ?, ?, ?)',
            [call.system, call.talkgroup, count, call.dateTime]
        )
    } else {
        count = rows[0].count + 1
        rdio.db.exec(
            'update `counts` set `count` = ?, `lastSeen` = ? where `system` = ? and `talkgroup` = ?',
            [count, call.dateTime, call.system, call.talkgroup]
        )
    }

    // Best effort — the server drops messages to clients that have fallen behind.
    rdio.ws.emit(
        { system: call.system, talkgroup: call.talkgroup },
        'HLO',
        { system: call.system, talkgroup: call.talkgroup, count: count }
    )
})

// Answer an explicit request for the current count, so a client that just
// connected can populate itself without waiting for the next call.
rdio.ws.on('HLO', function (client, payload) {
    var rows = rdio.db.query(
        'select `count` from `counts` where `system` = ? and `talkgroup` = ?',
        [payload.system, payload.talkgroup]
    )

    rdio.ws.emit({ client: client }, 'HLO', {
        system: payload.system,
        talkgroup: payload.talkgroup,
        count: rows.length ? rows[0].count : 0
    })
})

// A plain HTTP endpoint, served at /api/plugin/hello-world/counts
rdio.routes.register('GET', 'counts', function (req) {
    var rows = rdio.db.query('select * from `counts` order by `count` desc limit 100')
    return { status: 200, body: { counts: rows } }
})

// ---------------------------------------------------------------------------
// Changing something, rather than only watching
// ---------------------------------------------------------------------------
//
// Everything above uses `on`, which observes and can affect nothing. `filter`
// is the verb that changes what passes through — the same shape is how a plugin
// drops a call, rewrites its talkgroup, or replaces its audio.
//
// This one is deliberately harmless: it tags each call with the count this
// plugin has been keeping, which then travels with the call like any other
// field. Returning null means "no opinion, carry on"; returning { drop: true }
// here would refuse the call outright.
//
// It runs on the ingest path and blocks it, so a filter must be quick. Anything
// slow — an API call, ffmpeg — belongs in `on`, writing its result to your own
// table for a declarative extension to pick up.
rdio.filter('call.store', function (call) {
    if (!rdio.config.get('enabled')) return null

    var rows = rdio.db.query(
        'select `count` from `counts` where `system` = ? and `talkgroup` = ?',
        [call.system, call.talkgroup]
    )

    if (!rows.length) return null

    return { meta: { helloWorldCount: String(rows[0].count) } }
})
