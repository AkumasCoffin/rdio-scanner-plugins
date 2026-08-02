# Rdio Scanner Plugins

Official plugin repository for [Rdio Scanner](https://github.com/AkumasCoffin/rdio-scanner).

Plugins extend Rdio Scanner without being compiled into it. They are browsed and installed from the
admin panel, stored alongside the server, and take effect after a restart.

## Installing a plugin

1. Open the Rdio Scanner admin panel
2. Go to **Plugins → Available**
3. Pick a repository and branch, then click **Install** on the plugin you want
4. Restart Rdio Scanner
5. Configure the plugin under **Plugins → Installed**

Plugins can be enabled and disabled without uninstalling them. Uninstalling a plugin **keeps its
settings and data** — reinstall it later and everything comes back. Removing the data is a separate,
explicit "purge" action.

> **Branches:** the admin panel lists every branch in this repository, not just `main`. Branches
> other than `main` may contain untested or in-progress work. Install from them at your own risk.

## Available plugins

| Plugin | Description |
|---|---|
| [transcripts](plugins/transcripts) | Transcribes call audio with Whisper and shows it in the scanner. Part of the server until 6.14; renders identically. Announces transcripts to other plugins. |
| [stream](plugins/stream) | The OBS overlay at `/stream` — a configurable canvas of readouts, borders and the transcript, with no application chrome around it. Also part of the server until 6.14. |
| [hello-world](plugins/hello-world) | Reference plugin. Small enough to read in one sitting; demonstrates config, a table, watching calls, changing one, a websocket command, an HTTP endpoint and a frontend. |

## Repository layout

```
plugins/
  <plugin-id>/
    plugin.json      manifest — id, version, config schema, tables
    main.js          backend entry point, runs inside Rdio Scanner
    web/plugin.js    frontend entry point, loaded by the webapp at runtime
    README.md        plugin documentation
docs/
  writing-a-plugin.md   start here
  api-reference.md      every extension point and capability (generated)
  frontend-api.md       browser side: slots, pages, ctx.app, theming
  manifest.md           plugin.json in full
  theme-contract.md     CSS custom properties a theme sets (generated)
```

## Writing a plugin

**Start with [`docs/writing-a-plugin.md`](docs/writing-a-plugin.md)** — the mental model, and a
working plugin in two files. In short:

- **Backend** code is JavaScript, run in-process by an embedded interpreter. One artifact works on
  every platform Rdio Scanner supports — there is nothing to compile and no per-platform builds.
- **Frontend** code is plain JavaScript loaded by the webapp at runtime. It is not Angular, and it
  does not require rebuilding the webapp.
- Rdio Scanner calls out to plugins at named **extension points**, and you register against one with
  one of four verbs — watch it, change it, replace it, or supply something the server lacks.
- Each plugin gets **its own database tables**, created on install and namespaced to the plugin.
  Settings survive uninstalling.
- Plugins declare their configuration; the admin panel renders the form for you.
- There are **no permissions**. Every capability is available to every plugin; trust is decided once,
  at install.

[`plugins/hello-world`](plugins/hello-world) is a small complete plugin worth reading before your
first one.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for submitting a plugin to this repository.

## Third-party repositories

Rdio Scanner can install plugins from any repository, not just this one. Installing a plugin means
downloading code and running it on your server, so add the repositories you trust. The admin panel
says which repository a plugin is coming from when it isn't this one.

## Licence

GPL-3.0, matching Rdio Scanner itself. See [`LICENSE`](LICENSE).
