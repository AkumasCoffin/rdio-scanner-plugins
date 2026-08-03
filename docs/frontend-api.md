# Frontend API reference

Frontend plugin code lives in `web/plugin.js` and is loaded by the Rdio Scanner webapp at runtime. It
is ordinary browser JavaScript — not Angular — and does not require rebuilding the webapp.

Only enabled plugins are served. Disabling a plugin stops its frontend code from loading.

## Registering

```js
window.rdioScanner.plugins.register('hello-world', {
  init: function (ctx) {
    // called once, after the webapp is ready
  }
})
```

The `ctx` passed to `init` is the same API described below, pre-bound to your plugin id.

## Events

```js
ctx.on('call', function (call) { /* a call was displayed */ })
ctx.on('config', function (config) { /* config payload arrived or changed */ })
ctx.on('livefeed', function (enabled) { /* livefeed toggled */ })
```

Anything a plugin exposed server-side with `rdio.config.expose` appears on the `config` payload.

## Where a plugin can render

There are three levels, and they are genuinely open-ended — plugin code runs in the page with full
privileges, so nothing here is a boundary. Pick the least effort that works:

1. **Slots** — regions the webapp reserves and promises to keep. Least code, most stable.
2. **Views** — a whole screen of your own, with a navigation entry.
3. **Direct attachment** — mount into *any* element on the page by selector.

## UI slots

Slots are regions the webapp reserves for plugins. Mount a DOM node into one:

```js
ctx.slots.mount('lcd-below', function (el, data) {
  el.textContent = 'hello'
})
```

| Slot | Where |
|---|---|
| `lcd-below` | Under the main LCD panel |
| `lcd-sidebar` | Beside the main LCD panel |
| `call-row-extra` | Appended to each call history row; `data` is the call |
| `search-row-extra` | Appended to each search result row; `data` is the call |
| `admin-panel` | The admin panel, above Logout. Build your own `<mat-expansion-panel>` markup, or anything else. |

The factory is called with a container element you own. It is re-invoked when `data` changes and torn
down when the plugin is disabled.

Slot content is styled by the plugin. The webapp's own component styles are scoped and will not apply
to nodes you create, so ship whatever CSS you need — `ctx.injectCss(cssText)` adds a stylesheet
scoped to your plugin's containers.

## Full views

Slots are for adding to existing screens. For anything larger — a map, a dashboard, a whole new
screen — register a **view**. It gets its own entry in the navigation and a full-size container:

```js
ctx.views.register({
  id: 'map',
  label: 'Map',
  icon: 'map',                 // Material icon name
  mount: function (el) {
    // el is a full-size container. Do whatever you like with it.
    var map = new SomeMapLibrary(el)
    ctx.on('call', function (call) { map.addMarker(call) })
    return function () { map.destroy() }   // optional teardown
  }
})
```

`mount` may return a teardown function, called when the view is left or the plugin is disabled.

## Attaching anywhere

Slots cover the common cases. When you need somewhere else, attach by selector:

```js
ctx.dom.attach('[data-rdio="history-row"]', function (el) {
  el.textContent = '★'
})

// First match only — for a single overlay, banner or floating panel.
ctx.dom.attachOnce('body', function (el) {
  el.className = 'my-plugin-overlay'
})
```

`el` is a fresh element mounted **inside** each match, not the match itself — so the
`attachOnce` above styles a div inside `<body>`, not `<body>`. That is deliberate: your
markup is yours to own, and nothing you do to it can disturb the element the scanner is
rendering. Reach the match itself through `el.parentElement` if you need it.

Only a **slot** factory receives a second argument. A `dom` factory is called with the
element and nothing else.

`attach` mounts into every current match **and every future one**. Call history rows and search
results are created and destroyed constantly as calls arrive; a plain `querySelectorAll` at startup
would miss all of them. Attachments are also removed automatically when the plugin is disabled, which
hand-rolled DOM code would not be.

### Stable anchors

Class names are styling and change freely between releases. `data-rdio` attributes are anchors and
do not:

| Anchor | Element |
|---|---|
| `[data-rdio="status"]` | The status bar above the LCD |
| `[data-rdio="lcd"]` | The LCD panel |
| `[data-rdio="history"]` | The call history table |
| `[data-rdio="history-row"]` | One call history row; `data-rdio-call` holds the call id |
| `[data-rdio="admin"]` | The admin panel accordion |

The OBS stream overlay has no slot of its own. Its item types are a fixed set the component owns, so
there is nothing to register into — reach it with `ctx.dom.attach('.stream-item', ...)` and style it
through the [theme contract](theme-contract.md). If you want plugin-defined overlay items, say so and
it becomes a registration point rather than a slot.

Target these rather than class names, and your plugin keeps working across upgrades.

If you need something none of the above expresses, `ctx.dom.document()` hands you the raw document.
Plugin code always had this — it runs in the page — but going through the helpers means your content
gets re-applied and cleaned up properly instead of silently breaking the first time Angular re-renders.

## Shipping assets

Everything under your plugin's `web/` directory is served at `/plugins/<your-id>/web/`. Bundle
libraries, stylesheets, images or fonts alongside `plugin.js` and load them with helpers that resolve
relative to your plugin:

```js
ctx.assets.url('leaflet.css')                 // -> /plugins/<id>/web/leaflet.css
ctx.assets.loadScript('leaflet.js')           // -> Promise, resolves once loaded
ctx.assets.loadStyle('leaflet.css')           // -> Promise
```

Load third-party libraries this way rather than from a CDN — it keeps the plugin working on isolated
networks, which is common for scanner installs.

## Talking to other services

Browser code can call any origin your users' browsers can reach, subject to that service's CORS
policy. When a service does not allow cross-origin browser requests, or the request needs a secret,
proxy it through your backend half instead:

```js
// web/plugin.js — ctx.api parses JSON, so point an <img> at the route for
// anything that is not. The route is served from the page's own origin.
img.src = 'api/plugin/my-plugin/tiles?z=10&x=5&y=3'

// main.js — keeps the API key server-side
rdio.routes.register('GET', 'tiles', function (req) {
  return rdio.http.request({
    url: 'https://tiles.example.com/' + req.query.z + '/' + req.query.x + '/' + req.query.y,
    headers: { Authorization: 'Bearer ' + rdio.config.get('apiKey') },
    // Without this the image comes back through a JavaScript string, which is
    // UTF-8 — roughly half of all byte values do not survive the trip.
    binary: true
  }).then(function (res) {
    return { status: res.status, headers: { 'Content-Type': 'image/png' }, body: res.body }
  })
})
```

`ctx.api.get` and `ctx.api.post` parse the response as JSON. They are for talking to your
own backend half, not for fetching binary — there is no variant that returns a blob.

Never put credentials in frontend code — `web/` is served to every client.

## Server communication

```js
ctx.api.get('status').then(function (res) { /* GET /api/plugin/<id>/status */ })
ctx.api.post('action', { some: 'payload' })
```

Websocket commands registered server-side with `rdio.ws.on` are reachable directly, reusing the
webapp's existing connection:

```js
ctx.ws.on('MYC', function (payload) { /* pushed from the server */ })
ctx.ws.send('MYC', { hello: true })
```

## Configuration

```js
ctx.config.get()   // keys this plugin exposed with rdio.config.expose
```

Secrets are never sent to the browser. Anything a plugin wants the frontend to see must be exposed
explicitly server-side.

## Whole pages

A plugin can own a top-level URL, rendered with no application chrome around it —
the scanner's peer rather than something inside it.

```js
ctx.routes.register({
    path: 'overlay',
    mount(container, { params, query }) {
        container.innerHTML = '<h1>my page</h1>'
        return () => { /* optional teardown when the user navigates away */ }
    },
})
```

Now `/overlay` is the plugin's. The container is empty and yours; it renders
outside Angular's change detection, so listeners you attach cost nothing.

This is what a feature the size of the `/stream` overlay needs to exist as a
plugin — its own address, rendering nothing but itself. A [view](#full-views)
cannot do it, because a view is always inside the scanner.

Two rules. A path already claimed by another plugin is refused, with the conflict
named in the console. And built-in routes win: plugin pages are matched last, so
claiming `admin` or `stream` while the application still owns them does nothing.
When a built-in feature moves out to a plugin, its route leaves core at the same
time and the path becomes claimable.

## The scanner itself

`ctx.app` is the live `RdioScannerService` — the same object the application's own components use,
not a copy or a curated subset.

```js
ctx.app.play(call)
ctx.app.pause()
ctx.app.livefeed()
ctx.app.avoid({ call, status: true })
ctx.app.holdTalkgroup()
ctx.app.searchCalls({ system: 1, talkgroup: 101, limit: 50 })
ctx.app.setVolume(0.5)
ctx.app.getConfig()
ctx.app.getLivefeedMap()
ctx.app.getPresets()
```

Including its event stream, which carries far more than the `ctx.on` events do — livefeed state,
playback, holds, queue changes, config:

```js
const subscription = ctx.app.event.subscribe((ev) => {
    if (ev.call) { /* ... */ }
    if (ev.livefeedMode !== undefined) { /* ... */ }
})

// Unsubscribe when your view or page is torn down.
```

Exposed whole, deliberately. A curated wrapper would be a second list to keep in step with the
first, and the moment it fell behind, a plugin would be waiting on an rdio release for a method that
already existed. Anything a component can ask the scanner to do, a plugin can too.

The trade is that these are internal method names rather than a frozen API. They are stable in
practice — they are what the app is built on — but they are not covered by the `apiVersion` promise
the way the documented surface is.

## Theming

`ctx.theme` reads and writes the [theme contract](theme-contract.md): the CSS custom properties
declared on `:root`.

```js
if (ctx.theme.version() >= 1) {
    ctx.theme.apply({
        accent: '#38bdf8',
        'accent-strong': '#0ea5e9',
        'surface-deep': '#0b1120',
    })
}

ctx.theme.get('accent')            // current computed value
ctx.theme.set('accent', '#f43f5e')
ctx.theme.reset(['accent'])        // back to the stylesheet's value
ctx.theme.reset()                  // drop every override
```

Names work with or without the leading `--`.

Values are set on the document root, where the contract is defined, so they win over the stylesheet
without a theme having to out-specify component styles. That is the point of publishing a contract:
the application no longer hardcodes a colour anywhere that a theme would want to change, so a themes
plugin sets around seventy properties and is done, rather than fighting selectors with `!important`
and breaking on the next release.

## Notes

- Plugin frontend code runs with full page privileges. There is no sandbox, which is what makes
  arbitrary webapp integration possible.
- Do not assume load order between plugins.
- The API is versioned; `window.rdioScanner.plugins.apiVersion` tells you what you are running
  against.
