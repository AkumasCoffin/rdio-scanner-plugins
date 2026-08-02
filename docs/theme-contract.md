# Theme contract

<!-- Generated from client/src/styles.scss by scripts/extract-theme-contract.mjs.
     Do not edit by hand; change the stylesheet and regenerate. -->

Version **1** — 70 properties.

These CSS custom properties are the supported surface for restyling Rdio
Scanner. Set them on `:root` and the interface follows. Nothing in the
application hardcodes a colour that a theme would want to change, so a theme
never has to out-specify component styles with `!important`.

From a plugin:

```js
ctx.theme.apply({ accent: '#38bdf8', 'accent-strong': '#0ea5e9' })

ctx.theme.get('accent')      // current value
ctx.theme.version()          // contract version, check before applying
ctx.theme.reset()            // drop every override
```

Names may be written with or without the leading `--`.

The `-rgb` triplets exist because several surfaces are translucent gradients.
`rgba()` cannot take a hex custom property, so anything needing its own alpha
uses the channels: `rgba(var(--accent-rgb), 0.3)`.

## Stability

The names are a promise. A theme written today keeps working after an rdio
update — that is the point of publishing a contract rather than leaving themes
to fight component styles. Adding a property is a minor change; renaming or
removing one bumps `--theme-contract`, which `ctx.theme.version()` reports.

## General

| Property | Default |
| --- | --- |
| `--theme-contract` | `1` |

## Surfaces, darkest to lightest

| Property | Default |
| --- | --- |
| `--surface-deep` | `#020617` |
| `--surface-deep-rgb` | `2, 6, 23` |
| `--surface-deep-alt` | `#111827` |
| `--surface-panel` | `#0f172a` |
| `--surface-panel-rgb` | `15, 23, 42` |
| `--surface-raised` | `#1e293b` |
| `--surface-raised-rgb` | `30, 41, 59` |
| `--bg` | `#05070b` |
| `--bg-elevated` | `#10131b` |
| `--bg-elevated-soft` | `#151925` |

## The page backdrop, as a whole, so a theme can replace the gradient rather than only its stops

| Property | Default |
| --- | --- |
| `--app-background` | `radial-gradient(circle at top left, var(--surface-deep-alt) 0, var(--surface-deep) 52%), radial-gradient(circle at bottom right, var(--surface-deep) 0, var(--surface-deep) 65%)` |

## Accent

| Property | Default |
| --- | --- |
| `--accent` | `#f97316` |
| `--accent-rgb` | `249, 115, 22` |
| `--accent-strong` | `#ea580c` |
| `--accent-soft` | `rgba(var(--accent-rgb), 0.18)` |
| `--border-accent` | `var(--accent)` |

## Lines and overlays

| Property | Default |
| --- | --- |
| `--line-rgb` | `148, 163, 184` |
| `--border-subtle` | `rgba(var(--line-rgb), 0.35)` |
| `--border-faint` | `rgba(var(--line-rgb), 0.18)` |
| `--hover-overlay` | `rgba(255, 255, 255, 0.08)` |
| `--hover-overlay-strong` | `rgba(255, 255, 255, 0.12)` |

## Text, strongest to faintest

| Property | Default |
| --- | --- |
| `--text-strong` | `#ffffff` |
| `--text-main` | `#f9fafb` |
| `--text-bright` | `#e5e7eb` |
| `--text-pale` | `#e2e8f0` |
| `--text-pale-rgb` | `226, 232, 240` |
| `--text-slate` | `#94a3b8` |
| `--text-dim` | `#cbd5e1` |
| `--text-muted` | `#a1a5b6` |
| `--text-soft` | `#6b7280` |
| `--text-faint` | `#9ca3af` |

## State colours, used by pills, badges and anything reporting a condition

| Property | Default |
| --- | --- |
| `--state-danger` | `#ef4444` |
| `--state-danger-rgb` | `239, 68, 68` |
| `--state-danger-text` | `#fee2e2` |
| `--state-danger-text-dim` | `#fca5a5` |
| `--state-info` | `#3b82f6` |
| `--state-info-rgb` | `59, 130, 246` |
| `--state-info-text` | `#dbeafe` |
| `--state-info-text-dim` | `#93c5fd` |
| `--state-success` | `#22c55e` |
| `--state-success-rgb` | `34, 197, 94` |
| `--state-success-text` | `#bbf7d0` |
| `--state-success-text-strong` | `#dcfce7` |
| `--state-warn` | `#eab308` |
| `--state-warn-rgb` | `234, 179, 8` |
| `--state-warn-text` | `#fef9c3` |
| `--state-accent-text` | `#ffedd5` |
| `--accent-text-dim` | `#fdba74` |

## Statistics and charts

| Property | Default |
| --- | --- |
| `--stats-surface` | `#1a1a1a` |
| `--stats-surface-raised` | `#2d2d2d` |
| `--stats-text` | `#e0e0e0` |
| `--stats-text-muted` | `#a0a0a0` |
| `--stats-text-faint` | `#888888` |
| `--stats-text-dim` | `#666666` |
| `--chart-purple` | `#9c27b0` |
| `--chart-purple-rgb` | `156, 39, 176` |
| `--chart-orange` | `#ff9800` |
| `--chart-orange-rgb` | `255, 152, 0` |
| `--chart-cyan` | `#00bcd4` |
| `--chart-cyan-rgb` | `0, 188, 212` |
| `--chart-sky` | `#38bdf8` |
| `--chart-sky-rgb` | `56, 189, 248` |
| `--chart-red` | `#f44336` |
| `--chart-red-rgb` | `244, 67, 54` |

## Shape

| Property | Default |
| --- | --- |
| `--radius-lg` | `18px` |
| `--radius-md` | `12px` |
| `--radius-pill` | `999px` |
| `--shadow-soft` | `0 18px 40px rgba(0, 0, 0, 0.65)` |
| `--sidebar-width` | `260px` |
