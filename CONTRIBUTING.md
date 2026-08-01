# Contributing

## Submitting a plugin

1. Fork this repository.
2. Create `plugins/<your-plugin-id>/` containing at minimum `plugin.json`, `main.js`, and
   `README.md`. Add `web/plugin.js` if the plugin has a user interface.
3. Test it against a real Rdio Scanner install — see *Testing locally* below.
4. Open a pull request against `main`.

Work-in-progress plugins can live on a branch. The admin panel lists every branch, so users can
install from them deliberately, with the understanding that non-`main` branches are untested.

## Plugin ID rules

The plugin `id` is used for the install directory, the HTTP route prefix, and the database table
prefix, so it is constrained:

- Must match `^[a-z][a-z0-9-]{1,31}$` — lowercase letters, digits and hyphens, starting with a letter
- Must be unique within the repository
- Must match the directory name under `plugins/`

Database tables are created as `plugin_<id with hyphens replaced by underscores>_<table>`.

## Requirements

- **Licence:** GPL-3.0, matching this repository and Rdio Scanner. Do not submit plugins under an
  incompatible licence.
- **No bundled binaries.** Plugins are source only.
- **No obfuscated or minified code.** Plugin code runs with full server and page privileges and must
  be reviewable.
- **Declare your permissions** honestly in `plugin.json`. Users are shown what a plugin is asking for.
- **Declare `minServerVersion`** so the admin panel can hide the plugin from incompatible servers.
- **Stay inside your own tables.** The host enforces the `plugin_<id>_` prefix; do not try to work
  around it.
- **Do not block.** Backend hooks run on a bounded worker pool with a timeout. Use the async HTTP
  helpers rather than busy-waiting.

## JavaScript support

The backend interpreter supports ES5.1 plus most of ES6. There is **no** module system — no `import`,
no `require`. `main.js` is a single file, evaluated once at startup. `console.log` is available and
routes to the Rdio Scanner log.

Frontend code is ordinary browser JavaScript, subject only to the browsers you choose to support.

## Testing locally

You do not need to publish anything to test a plugin:

1. Build or download Rdio Scanner.
2. Create a `plugins/` directory next to the server binary (or in your `-base_dir` if you use one).
3. Copy `plugins/<your-plugin-id>/` into it.
4. Restart the server. The plugin appears under **Plugins → Installed** and can be enabled there.

To test the install flow end to end, push your branch to a fork and add the fork as a repository in
**Plugins → Repos**.

## Style

- Match the surrounding code.
- Comment *why*, not *what*.
- Keep `plugin.json` descriptions short — they are rendered in the admin panel.
