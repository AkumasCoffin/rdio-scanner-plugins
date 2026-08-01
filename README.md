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
| [hello-world](plugins/hello-world) | Reference plugin. Counts calls per talkgroup and shows the count under the LCD. |

## Repository layout

```
plugins/
  <plugin-id>/
    plugin.json      manifest — id, version, config schema, tables, permissions
    main.js          backend entry point, runs inside Rdio Scanner
    web/plugin.js    frontend entry point, loaded by the webapp at runtime
    README.md        plugin documentation
docs/
  manifest.md        plugin.json reference
  plugin-api.md      backend (server-side) API reference
  frontend-api.md    frontend (webapp) API reference
```

## Writing a plugin

Start with [`docs/manifest.md`](docs/manifest.md), then the API references. In short:

- **Backend** code is JavaScript, run in-process by an embedded interpreter. One artifact works on
  every platform Rdio Scanner supports — there is nothing to compile and no per-platform builds.
- **Frontend** code is plain JavaScript loaded by the webapp at runtime. It is not Angular, and it
  does not require rebuilding the webapp.
- Each plugin gets **its own database tables**, created on install and namespaced to the plugin.
- Plugins declare their configuration; the admin panel renders the form for you.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for submitting a plugin to this repository.

## Third-party repositories

Rdio Scanner can install plugins from any repository, not just this one. Plugins run with full access
to the server and the webapp — **only add repositories you trust.** The admin panel shows a warning
before installing from a repository other than the official one.

## Licence

GPL-3.0, matching Rdio Scanner itself. See [`LICENSE`](LICENSE).
