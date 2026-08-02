# Writing a plugin

A plugin is a folder with a `plugin.json` and some JavaScript. There is no build
step, no toolchain, and no compilation — the server runs your code directly, and
the same folder works on every platform Rdio Scanner supports.

This page is the mental model. For the exact surface — every extension point,
every function, every argument — see the
[API reference](api-reference.md), which the server generates from its own source
so it cannot drift from what actually runs.

## The smallest plugin that does something

Two files.

```
my-plugin/
  plugin.json
  main.js
```

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Logs every call that arrives.",
  "main": "main.js"
}
```

```js
rdio.on('call.stored', function (call) {
    rdio.log('info', 'call ' + call.id + ' on talkgroup ' + call.talkgroup)
})
```

Drop the folder in `plugins/` next to the server binary, restart, and enable it
in the admin panel. That is the whole loop.

## The one idea worth understanding

Rdio Scanner calls out to plugins at named moments — **extension points**. A
point is a string like `call.receive` or `access.check`. You register against a
point with one of **four verbs**, and which verb you pick decides what you are
allowed to do:

```js
rdio.on('call.stored', fn)       // watch. Cannot change anything.
rdio.filter('call.store', fn)    // change what passes through, or refuse it.
rdio.override('call.convert', fn) // replace what the server would have done.
rdio.provide('access.check', fn) // supply something the server does not have.
```

Everything else follows from this. Dropping a call is `filter` on an ingest
point. An external login system is `provide` on `access.check`. Replacing audio
conversion is `override` on `call.convert`.

### The failure rule

A handler that throws, times out, or returns something unusable is treated as
having done nothing, and the value passes through unchanged. **A plugin may
degrade the server; it must not be able to lose a call.**

`override` is the one exception. Replacing behaviour means owning its failures —
there is no original behaviour left to fall back to.

### Returning from a filter

```js
rdio.filter('call.receive', function (call) {
    if (isSilent(call)) return { drop: true }   // refuse it
    return { talkgroup: 999 }                    // change these fields
    return null                                  // no opinion, carry on
})
```

Naming one field changes one field. A partial result is never read as "clear the
rest" — otherwise every filter would be responsible for echoing the whole object
back correctly, and the first one to forget a field would corrupt it.

## Blocking, and why it matters

`on` is asynchronous and can never slow the server down. The other three block
the code path they sit in until your handler returns, because a veto that
arrived after the fact would not be a veto.

That has a real cost on the ingest path, which is a single goroutine: while your
filter runs, no other call is being written. Every point is bounded by a timeout,
and points that run per listener are bounded tightly. If you need to do something
slow — call an API, run ffmpeg — do it from `on` and write the result to your own
table, rather than holding up ingest inside a `filter`.

## Do slow work declaratively

Some things run per call, per row, or per listener. Doing those in JavaScript
would be far too slow, so the server does them natively and you just register
the data:

```js
// Publish a column from your table onto every call, as if it were a core field.
rdio.calls.extendField({
    field: 'transcript',
    table: 'calls',
    keyColumn: 'callId',
    valueColumn: 'transcript',
})

// Make that column searchable through the normal call search.
rdio.search.extend({ table: 'calls', keyColumn: 'callId', valueColumn: 'transcript' })
```

Your JavaScript runs when the value is *written*. The server does the lookup on
every read, in the same SQL it was already running. This is how the transcripts
plugin puts transcripts on calls without being in the read path at all.

## Storage

Declare tables in `plugin.json` and the server creates them, namespaced to your
plugin so names cannot collide:

```json
"tables": [
  { "name": "notes", "columns": [
    { "name": "callId", "type": "int", "primaryKey": true },
    { "name": "note", "type": "text" }
  ]}
]
```

```js
rdio.db.exec('insert into `notes` (`callId`, `note`) values (?, ?)', [id, text])
```

You write `notes`; the server maps it to the real name. SQL works against any
table in the database, core's included — the mapping is for your own tables, not
a fence around them.

Two other places to put things:

- **`rdio.config`** — settings declared in the manifest, which the admin panel
  renders a form for. **Kept when the plugin is uninstalled**, so removing and
  reinstalling does not lose someone's configuration.
- **`rdio.plugin.dataDir`** — a folder that survives updates. `rdio.plugin.dir`
  does not: installing wipes and rewrites it.

## The frontend

A plugin can ship browser code too, declared as `"web": "web/plugin.js"`. It is
plain JavaScript loaded at runtime — not Angular, and it does not require
rebuilding the webapp.

```js
window.rdioScanner.plugins.register('my-plugin', {
    init: function (ctx) {
        ctx.slots.mount('lcd-below', function (el, call) {
            el.textContent = 'call ' + (call && call.id)
        })
    },
})
```

`ctx` gives you the running scanner (`ctx.app`), the theme, named slots,
arbitrary DOM attachment, whole pages at their own URL, and a channel back to
your server side. See the [frontend API](frontend-api.md).

## Talking to other plugins

Plugins can call and be called, without either knowing the other exists:

```js
rdio.plugins.handle('get', function (args) { return lookup(args.id) })

rdio.plugins.call('transcripts', 'has', { id: 42 }).then(function (r) { ... })

rdio.plugins.publish('transcript', { id: 42, text: '...' })
rdio.plugins.subscribe('transcript', function (ev) { ... })
```

Ask what else is running from `plugins.ready`, not `startup` — `startup` fires
per plugin in load order, so from there the answer depends on who loaded first.

## Versioning

Declare `"apiVersion": 1`. The server refuses a plugin written against a newer
API than it implements, and supports one version back — so a plugin keeps working
across server updates without being rebuilt. The generated reference *is* the
contract.

There are no permissions. Every capability is available to every plugin, and the
decision about whether to trust one happens once, at install, where a person is
present. See [the manifest reference](manifest.md#permissions) for why.

## Where to look next

| | |
|---|---|
| [`api-reference.md`](api-reference.md) | Every point and capability. Generated — always current. |
| [`frontend-api.md`](frontend-api.md) | Browser side: slots, views, pages, `ctx.app`, theming. |
| [`manifest.md`](manifest.md) | `plugin.json` in full: config, tables, migrations. |
| [`theme-contract.md`](theme-contract.md) | The CSS custom properties a theme sets. |
| [`../plugins/hello-world`](../plugins/hello-world) | ~200 lines. Small enough to read in one sitting — start here. |
| [`../plugins/transcripts`](../plugins/transcripts) | ~800 lines. External API with key rotation and retries, its own tables, a server-to-server protocol, and a declarative field published onto every call. |
| [`../plugins/stream`](../plugins/stream) | ~3400 lines. A whole page at its own URL, rendering without Angular: live state off `ctx.app`, SVG geometry, an editor, and a theme-aware stylesheet. |

All three are real, installable plugins. The difference is size: hello-world is
the one to learn from, and the other two are what the API looks like carrying an
actual feature.
