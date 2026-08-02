# `plugin.json` reference

Every plugin has a `plugin.json` at the root of its directory. It is the only file Rdio Scanner reads
before deciding whether a plugin can be installed.

## Example

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "Logs a line for every call received.",
  "author": "Your Name",
  "license": "GPL-3.0",
  "homepage": "https://github.com/AkumasCoffin/rdio-scanner-plugins",
  "minServerVersion": "6.14.0",
  "main": "main.js",
  "web": "web/plugin.js",
  "permissions": ["http", "routes"],
  "config": [
    {
      "key": "greeting",
      "type": "text",
      "label": "Greeting",
      "help": "Text to prefix each log line with.",
      "default": "hello"
    }
  ],
  "tables": [
    {
      "name": "seen",
      "columns": [
        { "name": "callId", "type": "int", "primaryKey": true },
        { "name": "seenAt", "type": "datetime" }
      ]
    }
  ]
}
```

## Fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Must match `^[a-z][a-z0-9-]{1,31}$` and the directory name. Used for the install path, route prefix and table prefix. |
| `name` | yes | Display name in the admin panel. |
| `version` | yes | Semantic version. Drives update detection. |
| `description` | yes | One line, shown on the plugin card. |
| `author` | no | Display only. |
| `license` | no | Display only. GPL-3.0 is required for this repository. |
| `homepage` | no | Link shown on the plugin card. |
| `minServerVersion` | no | Plugins requiring a newer server are shown as incompatible and cannot be installed. |
| `maxServerVersion` | no | Same, for an upper bound. |
| `main` | no | Backend entry point. Defaults to `main.js`. Omit for frontend-only plugins. |
| `web` | no | Frontend entry point. Omit for backend-only plugins. |
| `permissions` | no | See below. Shown to the admin at install time. |
| `config` | no | Configuration schema. The admin panel renders a form from this. |
| `tables` | no | Database tables to create on install. |

## Permissions

There are none, and there is no `permissions` field to declare.

Every capability in the API is available to every plugin: the filesystem, running programs, SQL
against any table, outbound requests, arbitrary HTTP routes, and full access to the webapp. A
manifest that still carries a `permissions` array is accepted and the field ignored, so plugins
written against the earlier scheme keep loading.

The gates were removed because they never protected anything. A plugin runs in the server process
with the server's privileges, so any plugin that wanted a capability it had not declared could
simply declare it — the list described intent, not a boundary, while reading like a boundary. What
actually matters is the same judgement as for any other software you install: whether you trust the
repository you are installing from. The admin panel asks that question instead.

## API version

Declared in `apiVersion`. The current version is `1`; a manifest without the field is treated as
version 1. Loading refuses a plugin built against a newer API than the server implements, rather
than letting it fail later in a way that looks like a bug in the plugin.

## Config schema

Each entry in `config` becomes one field in the admin form.

| Property | Description |
|---|---|
| `key` | Storage key. Required. |
| `type` | One of `text`, `password`, `number`, `boolean`, `select`, `textarea`, `system`, `talkgroup`. Required. |
| `label` | Field label. Required. |
| `help` | Caption shown under the label. |
| `default` | Initial value on install. |
| `options` | For `select`: array of `{ "value": ..., "label": ... }`. |
| `min`, `max` | For `number`. |
| `maxLength` | For `text` and `textarea`; renders a character counter. |
| `required` | Blocks saving when empty. |
| `placeholder` | Input placeholder. |

`password` fields are write-only in the admin panel — stored values are never sent back to the
browser.

Values are read at runtime with `rdio.config.get(key)`. Configuration lives in the plugin's own table
and **survives uninstall**.

## Tables

Each entry in `tables` creates one table named `plugin_<id>_<name>`, with hyphens in the plugin id
replaced by underscores. Table names must match `^[a-z][a-z0-9_]{1,31}$`.

Column types are dialect-neutral and translated for SQLite, MySQL/MariaDB and PostgreSQL:

| Type | Notes |
|---|---|
| `int` | 32-bit integer |
| `bigint` | 64-bit integer |
| `text` | Unbounded text |
| `varchar` | Requires `length` |
| `boolean` | Stored as the backend's native boolean or a 0/1 integer |
| `datetime` | Timestamp |
| `float` | Double precision |
| `blob` | Binary |

Column properties: `name`, `type`, `length`, `primaryKey`, `autoIncrement`, `nullable` (default
`true`), `default`, `index`.

To link rows to core records, store the core id and declare an index:

```json
{ "name": "callId", "type": "int", "index": true }
```

Rdio Scanner does not create foreign keys across the plugin boundary — plugin tables outlive
uninstalls, and rows are cleaned up by the plugin itself.

## Versioning and migrations

When a plugin's `version` changes and the new manifest declares new tables or columns, they are
created on next start. Existing columns are never altered or dropped automatically; do that from
`main.js` on the `startup` event if you need it.
