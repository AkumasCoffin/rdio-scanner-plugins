# Documentation

Start here if you want to write a plugin:

**[Writing a plugin](writing-a-plugin.md)** — the mental model, and a working
plugin in two files. Read this first; the rest are references you come back to.

## References

| | |
|---|---|
| [API reference](api-reference.md) | Every extension point and every `rdio.*` capability, backend. |
| [Frontend API](frontend-api.md) | Browser side: slots, whole pages, `ctx.app`, theming. |
| [Manifest](manifest.md) | `plugin.json` in full — config, tables, migrations, versioning. |
| [Theme contract](theme-contract.md) | The CSS custom properties a theme sets. |

## Generated files

`api-reference.md` and `theme-contract.md` are **generated**, and say so at the
top. Do not edit them by hand — the change would be overwritten, and in the
meantime the file would be describing something the code does not do.

Regenerate them with:

```
rdio-scanner -plugin_docs docs/api-reference.md
node client/scripts/extract-theme-contract.mjs docs/theme-contract.md
```

They are generated for a reason. A hand-written backend reference used to live
here alongside them; by the time it was removed it still documented a permission
system that no longer existed and was missing the four verbs, the plugin bus,
filesystem and audio access — most of what makes the API worth using. Two lists
maintained by hand always end up disagreeing, and the one people read is the one
that is wrong.
