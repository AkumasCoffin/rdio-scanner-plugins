# Backend API reference

Backend plugin code lives in `main.js` and runs inside the Rdio Scanner server. It is evaluated once
at startup, and should register handlers rather than doing work at the top level.

Everything is reached through the global `rdio` object.

## Runtime

The interpreter supports ES5.1 plus most of ES6. There is **no module system** — no `import`, no
`require`. `main.js` is a single file.

Each plugin gets its own isolated interpreter and its own event loop. Handlers are dispatched on a
bounded worker pool with a per-invocation timeout, so a slow plugin cannot stall call ingest. Blocking
operations (HTTP, database) return promises and resolve back onto your event loop.

`console.log` / `.warn` / `.error` are available and route to the Rdio Scanner log.

## `rdio.plugin`

```js
rdio.plugin.id       // "hello-world"
rdio.plugin.version  // "1.0.0"
rdio.plugin.dir      // where this plugin's own files live
rdio.plugin.dataDir  // where to keep anything that must survive an update
```

Write to `dataDir`, never to `dir`. Updating a plugin removes and rewrites its
file directory, so anything stored beside the plugin's own code is lost. The
data directory is untouched by both update and uninstall — only the admin
panel's explicit purge clears it.

## `rdio.log(level, message)`

Writes to the Rdio Scanner log, visible in the admin panel under Logs. Level is `"info"`, `"warn"` or
`"error"`.

```js
rdio.log('info', 'plugin started')
```

## `rdio.config`

Reads and writes the plugin's own configuration, as declared in `plugin.json`.

```js
rdio.config.get('greeting')        // -> "hello"
rdio.config.getAll()               // -> { greeting: "hello" }
rdio.config.set('greeting', 'hi')  // persists immediately
```

`rdio.config.expose(key, value)` (requires the `config-expose` permission) merges a key into the
config payload every webapp client receives, so the webapp can react to plugin state:

```js
rdio.config.expose('myFeatureEnabled', true)
```

## `rdio.on(event, handler)`

| Event | Payload | Notes |
|---|---|---|
| `startup` | — | After the plugin is loaded and its tables exist |
| `shutdown` | — | Server is stopping; best effort |
| `call.ingested` | `call` | The call has arrived and is about to be written. **Observational only** — see below. |
| `call.stored` | `call` | After the call has an id. The usual place to start work. |
| `call.emitted` | `call` | After the call has been sent to listeners |
| `config.changed` | — | An admin saved configuration |
| `tick` | — | Hourly, alongside the built-in maintenance run |

> **`call.ingested` cannot change the call.** Every ingest path in Rdio Scanner
> funnels through a single goroutine, so a handler that ran synchronously there
> would throttle the whole server for every listener. Handlers are dispatched
> asynchronously instead, which means the call is very likely already written by
> the time yours runs — mutating the object you receive changes nothing.
>
> Use `call.stored` and `rdio.calls.update` if you need to alter a call.

```js
rdio.on('call.stored', function (call) {
  rdio.log('info', 'call ' + call.id + ' on talkgroup ' + call.talkgroup)
})
```

The `call` object exposes `id`, `system`, `talkgroup`, `dateTime`, `frequency`, `source`, `sources`,
`frequencies`, `patches`, `audioName`, `audioType`, and `audioSize`. Audio bytes are **not** included
by default — fetch them explicitly with `rdio.calls.get`.

## `rdio.schedule(intervalMs, handler)`

Runs a handler on an interval. Cleared automatically when the plugin is disabled.

```js
rdio.schedule(60000, function () { /* every minute */ })
```

## `rdio.db`

Queries against the plugin's own tables. Table names are rewritten to the plugin's prefix, so write
the declared name:

```js
rdio.db.exec('insert into `seen` (`callId`, `seenAt`) values (?, ?)', [call.id, new Date()])
var rows = rdio.db.query('select * from `seen` where `callId` = ?', [call.id])
```

Use backtick identifiers and `?` placeholders; Rdio Scanner rewrites them for the active database
backend. Attempting to reference a table outside your prefix is an error, as is DDL — declare tables
in the manifest instead. A single `query` will not return more than 50,000 rows.

`query` and `exec` are **synchronous, and run on your plugin's event loop**, so a slow statement
stalls everything else your plugin is doing. That is the right trade for the small keyed reads and
writes most plugins do. For anything that scans a large table, use the promise-returning variants,
which run the statement off the loop:

```js
rdio.db.queryAsync('select * from `seen` where `seenAt` < ?', [cutoff])
    .then(function (rows) { /* ... */ })
```

## `rdio.calls`

Requires `calls-read` (and `calls-write` for updates).

```js
var call = rdio.calls.get(id, { audio: true })   // call.audio is a byte array
var results = rdio.calls.search({ system: 1, talkgroup: 42, limit: 50 })
```

Audio is omitted unless you ask for it — a call blob is typically 50–200 KB and most plugins never
touch it. `call.audioSize` is always present, so you can decide whether to fetch.

`rdio.calls.update(id, fields)` (requires `calls-write`) changes core call metadata. It accepts a
deliberately narrow set of fields: your own data belongs in your own tables, and a plugin rewriting
arbitrary columns would make a call record's provenance impossible to reason about.

### `rdio.calls.extendField(spec)`

Adds a field to every call sent to clients, populated from one of your tables. This is **declarative**
— the lookup happens in native code, not in JavaScript, so it costs nothing per call.

```js
rdio.calls.extendField({
  field: 'transcript',      // property name in the call payload
  table: 'calls',           // your table (plugin_<id>_calls)
  keyColumn: 'callId',      // column holding the core call id
  valueColumn: 'transcript' // column holding the value
})
```

## `rdio.search.extend(spec)`

Makes one of your text columns searchable through the normal call search, so the existing search box
and the public API `?q=` parameter cover your data too.

```js
rdio.search.extend({
  table: 'calls',
  keyColumn: 'callId',
  textColumn: 'transcript',
  resultField: 'transcript'  // optional; also returned in search results
})
```

## `rdio.http`

Requires the `http` permission. Both methods return promises.

```js
rdio.http.request({
  method: 'POST',
  url: 'https://example.com/api',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hello: 'world' }),
  timeoutMs: 30000
}).then(function (res) {
  // res.status, res.headers, res.body
})
```

`rdio.http.multipart` builds a multipart form, which is how you upload audio:

```js
rdio.http.multipart({
  url: 'https://example.com/upload',
  headers: { Authorization: 'Bearer ' + key },
  fields: { model: 'whisper-1' },
  files: [{ field: 'file', filename: 'call.m4a', data: call.audio }]
}).then(function (res) { /* ... */ })
```

Responses are size-capped and requests are subject to a timeout.

## `rdio.routes`

Requires the `routes` permission.

```js
rdio.routes.register('GET', 'status', function (req) {
  return { status: 200, body: { ok: true } }
})
```

That endpoint is served at `/api/plugin/<your-id>/status`.

`rdio.routes.registerAbsolute(path, handler)` requires the `routes-absolute` permission and mounts at
an arbitrary path. Use it only for protocol compatibility — for example a plugin that implements an
endpoint other servers expect to find at a fixed location.

The `req` object has `method`, `path`, `query`, `headers`, and `body`. Return `{ status, headers,
body }`; an object body is serialised as JSON.

## `rdio.ws`

Requires the `ws` permission. Lets a plugin add its own websocket commands, using the same connection
the webapp already has open.

```js
rdio.ws.on('MYC', function (client, payload) {
  rdio.ws.emit({ client: client }, 'MYC', { reply: true })
})

// broadcast to everyone who can see this call
rdio.ws.emit({ system: call.system, talkgroup: call.talkgroup }, 'MYC', payload)
```

Emit filters respect each listener's access permissions. Delivery is best effort — the server drops
messages to clients that have fallen behind, so never rely on a websocket message arriving.

## `rdio.capabilities.advertise(name)`

Adds a feature name to the server's advertised capabilities, so peer servers can detect support.

```js
rdio.capabilities.advertise('my-feature')
```
