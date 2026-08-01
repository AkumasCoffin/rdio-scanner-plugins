# Hello World

Reference plugin for Rdio Scanner. It exists to demonstrate the plugin API end to end and to give you
something known-good to copy when starting your own.

It counts how many calls each talkgroup has produced and shows the running count under the LCD.

## What it demonstrates

| Feature | Where |
|---|---|
| Config schema rendered by the admin panel | `plugin.json` → `config` |
| A plugin-owned table | `plugin.json` → `tables` |
| Reacting to calls | `main.js` → `rdio.on('call.stored', …)` |
| Reading and writing plugin tables | `main.js` → `rdio.db` |
| A custom websocket command, both directions | `main.js` → `rdio.ws`, `web/plugin.js` → `ctx.ws` |
| An HTTP endpoint | `main.js` → `rdio.routes.register` |
| Passing values to the webapp | `main.js` → `rdio.config.expose` |
| Rendering into a slot | `web/plugin.js` → `ctx.slots.mount('lcd-below', …)` |
| Rendering **anywhere** on the page | `web/plugin.js` → `ctx.dom.attach('[data-rdio="history-row"] …')` |
| A whole screen of its own | `web/plugin.js` → `ctx.views.register({ … })` |

## Configuration

| Setting | Default | Description |
|---|---|---|
| Show call counter | on | Whether to display the counter at all |
| Counter label | `Calls seen` | Text shown before the number |

## HTTP endpoint

```
GET /api/plugin/hello-world/counts
```

Returns the top 100 talkgroups by call count.

## Notes

Counts are stored in `plugin_hello_world_counts` and survive uninstalling the plugin. Use the admin
panel's purge action if you want them gone.
