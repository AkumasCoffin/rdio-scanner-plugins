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
rdio.plugin.dataDir  // absolute path to this plugin's private directory
```

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
| `call.ingested` | `call` | Before the call is written. Mutating the call affects what is stored. |
| `call.stored` | `call` | After the call has an id. The usual place to start work. |
| `call.emitted` | `call` | After the call has been sent to listeners |
| `config.changed` | — | An admin saved configuration |
| `tick` | — | Hourly, alongside the built-in maintenance run |

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
backend. Attempting to reference a table outside your prefix is an error.

## `rdio.calls`

Requires `calls-read` (and `calls-write` for updates).

```js
var call = rdio.calls.get(id, { audio: true })   // call.audio is a byte array
var results = rdio.calls.search({ system: 1, talkgroup: 42, limit: 50 })
```

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
