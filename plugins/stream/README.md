# Stream Overlay

The OBS overlay: a configurable canvas of readouts, borders and the transcript,
served at `/stream` with no application chrome around it. Point a browser source
at it and it fills the frame.

This was part of the Rdio Scanner webapp until 6.14. It is a plugin now, and
renders the same — layouts made before the move are picked up untouched.

## Using it

Open `/stream`. Press **Ctrl+E** to edit, and Ctrl+E again to leave.

Nothing that belongs to editing is drawn unless edit mode is on, so a broadcast
never shows a handle, a guide or the hint badge.

| | |
|---|---|
| Move | drag. Hold **Shift** to snap to the grid |
| Resize | drag the corner grip |
| Multi-select | **Ctrl+click**, or **Ctrl+drag** a box |
| Nudge | arrow keys, or **Shift+arrow** for a whole grid step |
| Edit | right-click for the menu, then Properties |
| Delete | **Delete**, or the menu |
| Add | right-click empty canvas |

A readout that is not on the canvas is flagged in the Add menu, so it is obvious
what is available. Decoration and custom text are never flagged — they are absent
because nobody added them, not because something is missing.

Dragging a single item aligns it to its neighbours' edges and centres, with a
guide line showing what it caught. Holding Shift switches to grid snapping
instead.

### Shapable borders

A shapable border is a polygon rather than a rectangle. Drag a corner to move it,
drag the smaller dot on an edge to add a bend, and double-click either to remove
it. Corners snap to the grid unless Shift is held — the opposite of moving an
item, because a bend that misses the grid by a pixel is what makes a shape look
wrong.

Dividers are internal lines added from the right-click menu, drawn the full
thickness of the border so they read as part of it.

## Layouts

Layouts are stored in the browser, per browser, and shared live between windows —
so an overlay open in a second window follows edits made in the first.

**They are not stored on the server.** Use Export in the right-click menu to keep
a copy, and Import to restore one or move it to another machine. Clearing your
browser's site data clears your layout with it.

Layout files exported from the built-in overlay import unchanged; the format did
not move with the code.

If the overlay ever says it could not save, the browser refused the write —
usually storage that is full or partitioned. Changes stay on screen but will be
gone on reload, so export before doing anything else.

## Settings

`path` — where the overlay lives, relative to the server root. Leave it as
`stream` unless you have a reason to move it: existing browser sources point
there. A change takes effect when the page is next loaded.

## How it behaves

The overlay is a display, not a listener. It says so when it connects, so it is
not counted in the listener total, and it follows the main page rather than
driving playback itself — open it alongside the scanner and it mirrors what is
playing.

The transcript scrolls in time with the call. Values too long for their box
marquee out, pause, and come back, so both ends are readable.

## Development

Plain JavaScript, no build step. `web/plugin.js` loads the rest.

| | |
|---|---|
| `layout.js` | the layout model, item types and defaults |
| `store.js` | persistence, cross-window sync, import and export |
| `state.js` | display state derived from the scanner |
| `render.js` | drawing |
| `shapes.js` | shapable-border geometry |
| `scroll.js` | the marquee and transcript scrolling |
| `props.js` | the properties panel |
| `edit.js` | selection, gestures, the context menu |

Tests run under Node with no dependencies:

```
node web/layout.test.js
node web/render.test.js
node web/shapes.test.js
node web/scroll.test.js
```

`layout.js` is a straight translation of the original model and should stay that
way. Its field names are the export format, and export is the only backup anyone
has — renaming a field while tidying would silently invalidate every layout file
already on disk.
