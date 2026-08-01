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
| `admin-tab` | A tab in the admin panel |
| `stream-item:<type>` | Registers a new item type for the OBS stream overlay |

The factory is called with a container element you own. It is re-invoked when `data` changes and torn
down when the plugin is disabled.

Slot content is styled by the plugin. The webapp's own component styles are scoped and will not apply
to nodes you create, so ship whatever CSS you need — `ctx.injectCss(cssText)` adds a stylesheet
scoped to your plugin's containers.

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

## Notes

- Plugin frontend code runs with full page privileges. There is no sandbox — this is what makes
  arbitrary webapp integration possible, and it is why you should only install plugins you trust.
- Do not assume load order between plugins.
- The API is versioned; `window.rdioScanner.plugins.apiVersion` tells you what you are running
  against.
