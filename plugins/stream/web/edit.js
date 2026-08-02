/*
 * Stream overlay — edit mode.
 *
 * Moving, resizing, selecting and snapping. Ported from the original's gesture
 * handling, including the numbers: a 7px snap threshold, a 130px proximity
 * limit so a box does not snap to something across the screen, and a 5px bonus
 * for centre-to-centre alignment on text items, which sit vertically centred in
 * their box and so read as aligned by their middle rather than their edge.
 *
 * Gestures listen on the window rather than the item, so a fast drag that
 * outruns the pointer does not silently drop the item where it was.
 */

;(function (root) {
    'use strict'

    var L = root.RdioStreamLayout

    var SNAP_THRESHOLD = 7
    var SNAP_NEAR = 130
    var CENTER_BONUS = 5

    function Editor(canvas, store, renderer) {
        this.canvas = canvas
        this.store = store
        this.renderer = renderer

        this.selected = new Set()
        this.gesture = null

        this.guideX = null
        this.guideY = null

        this.boundMove = this.onMove.bind(this)
        this.boundUp = this.onUp.bind(this)
        this.boundKey = this.onKey.bind(this)
        this.boundDown = this.onCanvasDown.bind(this)
        this.boundContext = this.onContext.bind(this)
    }

    Editor.prototype.attach = function () {
        this.canvas.addEventListener('pointerdown', this.boundDown)
        this.canvas.addEventListener('contextmenu', this.boundContext)
        window.addEventListener('keydown', this.boundKey)

        this.guides = document.createElement('div')
        this.guides.className = 'rdio-stream-guides'
        this.canvas.appendChild(this.guides)

        this.badge = document.createElement('div')
        this.badge.className = 'rdio-stream-badge'
        this.badge.textContent = 'EDIT MODE — drag to move · corner to resize · right-click to edit · ' +
            'ctrl+click or ctrl+drag to multi-select · arrows to nudge · ctrl+E to leave'
        this.canvas.appendChild(this.badge)

        this.syncBadge()
        this.store.onChange(this.syncBadge.bind(this))

        return this
    }

    // The badge is the only thing telling someone the overlay is editable, and
    // it must never be on screen while broadcasting.
    Editor.prototype.syncBadge = function () {
        if (this.badge) this.badge.style.display = this.editing() ? '' : 'none'

        // Leaving edit mode must take the panel with it; it is chrome, and
        // chrome on air is the failure that matters for an overlay.
        if (!this.editing()) {
            this.closeMenu()
            if (this.props) this.props.close()
        } else {
            this.refreshProps()
        }
    }

    Editor.prototype.detach = function () {
        this.canvas.removeEventListener('pointerdown', this.boundDown)
        this.canvas.removeEventListener('contextmenu', this.boundContext)
        window.removeEventListener('keydown', this.boundKey)
        window.removeEventListener('pointermove', this.boundMove)
        window.removeEventListener('pointerup', this.boundUp)
        this.closeMenu()
        if (this.props) this.props.close()
    }

    Editor.prototype.editing = function () {
        return !!this.store.getLayout().moveMode
    }

    Editor.prototype.itemAt = function (target) {
        var el = target
        while (el && el !== this.canvas) {
            if (el.classList && el.classList.contains('rdio-stream-item')) {
                return el.getAttribute('data-id')
            }
            el = el.parentNode
        }
        return null
    }

    Editor.prototype.onCanvasDown = function (event) {
        if (!this.editing() || event.button !== 0) return

        this.closeMenu()

        var id = this.itemAt(event.target)

        if (!id) {
            // Empty canvas: start a rubber band, and clear the selection unless
            // the user is adding to it.
            if (!event.ctrlKey && !event.metaKey) this.setSelection([])
            this.startBand(event)
            return
        }

        // Ctrl or Cmd click toggles selection instead of dragging, so a
        // multi-selection can be built without moving anything.
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            event.stopPropagation()
            this.toggle(id)
            return
        }

        var resize = event.target.classList &&
            event.target.classList.contains('rdio-stream-resize')

        // Dragging an unselected item drops the selection first; dragging one
        // that is selected moves the whole selection together.
        if (!this.selected.has(id)) this.setSelection([id])

        this.begin(id, event, resize ? 'resize' : 'move')
    }

    Editor.prototype.begin = function (id, event, mode) {
        var item = this.find(id)
        if (!item) return

        event.preventDefault()
        event.stopPropagation()

        var layout = this.store.getLayout()

        var moving = (this.selected.has(id) && this.selected.size > 1)
            ? layout.items.filter(function (i) { return this.selected.has(i.id) }, this)
            : [item]

        this.gesture = {
            id: id,
            mode: mode,
            startX: event.clientX,
            startY: event.clientY,
            origW: item.w,
            origH: item.h,
            targets: moving.map(function (i) { return { id: i.id, x: i.x, y: i.y } }),
        }

        window.addEventListener('pointermove', this.boundMove)
        window.addEventListener('pointerup', this.boundUp)
    }

    Editor.prototype.onMove = function (event) {
        if (this.band) return this.updateBand(event)
        if (!this.gesture) return

        var layout = this.store.getLayout()
        var g = this.gesture
        var dx = event.clientX - g.startX
        var dy = event.clientY - g.startY

        function snap(n) {
            if (event.shiftKey && layout.gridSize > 0) {
                return Math.round(n / layout.gridSize) * layout.gridSize
            }
            return Math.round(n)
        }

        if (g.mode === 'move') {
            // A single item aligns to its neighbours' edges unless Shift is
            // held, which forces the grid instead.
            var elementSnap = g.targets.length === 1 && !event.shiftKey
            this.guideX = null
            this.guideY = null

            for (var i = 0; i < g.targets.length; i++) {
                var t = g.targets[i]
                var x = Math.max(0, snap(t.x + dx))
                var y = Math.max(0, snap(t.y + dy))

                if (elementSnap) {
                    var item = this.find(t.id)
                    if (item) {
                        var s = this.snapToElements(x, y, item.w, item.h, t.id, g.targets)
                        x = s.x
                        y = s.y
                        this.guideX = s.guideX
                        this.guideY = s.guideY
                    }
                }

                this.store.updateItem(t.id, { x: x, y: y })
            }

            this.drawGuides()
            return
        }

        var target = this.find(g.id)
        if (!target) return

        // The bottom-right edge snaps to the grid, matching how a move snaps the
        // top-left, so a resized edge lands on a grid line too.
        var w = Math.max(L.itemMinW(target.type), snap(target.x + g.origW + dx) - target.x)
        var h = Math.max(L.itemMinH(target.type), snap(target.y + g.origH + dy) - target.y)

        this.store.updateItem(g.id, { w: w, h: h })
    }

    Editor.prototype.onUp = function () {
        if (this.band) return this.endBand()

        this.gesture = null
        this.guideX = null
        this.guideY = null
        this.drawGuides()

        window.removeEventListener('pointermove', this.boundMove)
        window.removeEventListener('pointerup', this.boundUp)
    }

    Editor.prototype.find = function (id) {
        var items = this.store.getLayout().items
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) return items[i]
        }
        return null
    }

    // Alignment against other items, returning the guide lines to draw.
    Editor.prototype.snapToElements = function (x, y, w, h, id, targets) {
        var layout = this.store.getLayout()
        var dragged = this.find(id)

        // Text sits vertically centred in its box, so centre-to-centre reads as
        // aligned where an edge match would not. Borders have no such bias.
        var preferCenter = !!dragged && !L.isBorder(dragged.type)

        var moving = {}
        for (var m = 0; m < targets.length; m++) moving[targets[m].id] = true

        var bestX = Infinity
        var bestY = Infinity
        var snapX = x
        var snapY = y
        var guideX = null
        var guideY = null

        var myV = [x, x + w / 2, x + w]
        var myH = [y, y + h / 2, y + h]

        for (var i = 0; i < layout.items.length; i++) {
            var o = layout.items[i]
            if (o.id === id || moving[o.id]) continue

            // Separation in each axis, zero when the boxes overlap.
            var vSep = Math.max(0, o.y - (y + h), y - (o.y + o.h))
            var hSep = Math.max(0, o.x - (x + w), x - (o.x + o.w))

            if (vSep <= SNAP_NEAR) {
                var oV = [o.x, o.x + o.w / 2, o.x + o.w]
                for (var a = 0; a < 3; a++) {
                    for (var b = 0; b < 3; b++) {
                        var d = Math.abs(myV[a] - oV[b])
                        if (d > SNAP_THRESHOLD) continue
                        var score = d - (preferCenter && a === 1 && b === 1 ? CENTER_BONUS : 0)
                        if (score < bestX) {
                            bestX = score
                            snapX = x + (oV[b] - myV[a])
                            guideX = oV[b]
                        }
                    }
                }
            }

            if (hSep <= SNAP_NEAR) {
                var oH = [o.y, o.y + o.h / 2, o.y + o.h]
                for (var c = 0; c < 3; c++) {
                    for (var e = 0; e < 3; e++) {
                        var dh = Math.abs(myH[c] - oH[e])
                        if (dh > SNAP_THRESHOLD) continue
                        var scoreH = dh - (preferCenter && c === 1 && e === 1 ? CENTER_BONUS : 0)
                        if (scoreH < bestY) {
                            bestY = scoreH
                            snapY = y + (oH[e] - myH[c])
                            guideY = oH[e]
                        }
                    }
                }
            }
        }

        return { x: Math.max(0, snapX), y: Math.max(0, snapY), guideX: guideX, guideY: guideY }
    }

    Editor.prototype.drawGuides = function () {
        if (!this.guides) return
        this.guides.textContent = ''

        if (this.guideX !== null) {
            var v = document.createElement('div')
            v.className = 'rdio-stream-guide vertical'
            v.style.left = this.guideX + 'px'
            this.guides.appendChild(v)
        }

        if (this.guideY !== null) {
            var h = document.createElement('div')
            h.className = 'rdio-stream-guide horizontal'
            h.style.top = this.guideY + 'px'
            this.guides.appendChild(h)
        }
    }

    // --- selection ---------------------------------------------------------

    Editor.prototype.setSelection = function (ids) {
        this.selected = new Set(ids)
        this.paintSelection()
    }

    Editor.prototype.toggle = function (id) {
        if (this.selected.has(id)) this.selected.delete(id)
        else this.selected.add(id)
        this.paintSelection()
    }

    Editor.prototype.paintSelection = function () {
        var self = this
        var nodes = this.canvas.querySelectorAll('.rdio-stream-item')
        Array.prototype.forEach.call(nodes, function (el) {
            el.classList.toggle('selected', self.selected.has(el.getAttribute('data-id')))
        })
    }

    Editor.prototype.startBand = function (event) {
        var rect = this.canvas.getBoundingClientRect()

        this.band = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            additive: event.ctrlKey || event.metaKey,
            base: Array.from(this.selected),
        }

        this.bandEl = document.createElement('div')
        this.bandEl.className = 'rdio-stream-band'
        this.canvas.appendChild(this.bandEl)

        window.addEventListener('pointermove', this.boundMove)
        window.addEventListener('pointerup', this.boundUp)
    }

    Editor.prototype.updateBand = function (event) {
        var rect = this.canvas.getBoundingClientRect()
        var cx = event.clientX - rect.left
        var cy = event.clientY - rect.top

        var x = Math.min(this.band.x, cx)
        var y = Math.min(this.band.y, cy)
        var w = Math.abs(cx - this.band.x)
        var h = Math.abs(cy - this.band.y)

        this.bandEl.style.left = x + 'px'
        this.bandEl.style.top = y + 'px'
        this.bandEl.style.width = w + 'px'
        this.bandEl.style.height = h + 'px'

        var hits = this.store.getLayout().items.filter(function (i) {
            return i.x < x + w && i.x + i.w > x && i.y < y + h && i.y + i.h > y
        }).map(function (i) { return i.id })

        this.setSelection(this.band.additive ? this.band.base.concat(hits) : hits)
    }

    Editor.prototype.endBand = function () {
        if (this.bandEl && this.bandEl.parentNode) this.bandEl.parentNode.removeChild(this.bandEl)
        this.bandEl = null
        this.band = null

        window.removeEventListener('pointermove', this.boundMove)
        window.removeEventListener('pointerup', this.boundUp)
    }

    // --- keyboard ----------------------------------------------------------

    Editor.prototype.onKey = function (event) {
        // Never while typing into a field.
        var tag = event.target && event.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

        // The way in and out. The built-in overlay had no control of its own —
        // edit mode was switched on from the main scanner page and reached the
        // overlay over the layout channel. That page is not going to keep the
        // stream code, so the overlay needs a way in that does not depend on it.
        // A shortcut rather than a button, because anything drawn on the canvas
        // would end up in the broadcast.
        if ((event.ctrlKey || event.metaKey) && (event.key === 'e' || event.key === 'E')) {
            event.preventDefault()
            var layout = this.store.getLayout()
            this.store.update({ moveMode: !layout.moveMode })
            if (layout.moveMode) this.setSelection([])
            return
        }

        if (!this.editing()) return

        if (event.key === 'Escape') {
            this.closeMenu()
            this.setSelection([])
            return
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (!this.selected.size) return
            event.preventDefault()
            this.removeSelected()
            return
        }

        // Arrow keys nudge: one pixel, or one grid step with Shift.
        var deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        var delta = deltas[event.key]

        if (delta && this.selected.size) {
            event.preventDefault()
            var layout = this.store.getLayout()
            var step = event.shiftKey && layout.gridSize > 0 ? layout.gridSize : 1
            var self = this

            this.selected.forEach(function (id) {
                var item = self.find(id)
                if (!item) return
                self.store.updateItem(id, {
                    x: Math.max(0, item.x + delta[0] * step),
                    y: Math.max(0, item.y + delta[1] * step),
                })
            })
        }
    }

    Editor.prototype.removeSelected = function () {
        var gone = this.selected
        this.store.setItems(this.store.getLayout().items.filter(function (i) { return !gone.has(i.id) }))
        this.setSelection([])
    }

    // --- context menu ------------------------------------------------------

    Editor.prototype.onContext = function (event) {
        if (!this.editing()) return

        event.preventDefault()
        event.stopPropagation()

        var id = this.itemAt(event.target)

        // Right-clicking outside the current selection reduces it to that item;
        // right-clicking inside keeps it, so an edit applies to everything.
        if (id && !this.selected.has(id)) this.setSelection([id])
        if (!id) this.setSelection([])

        this.openMenu(event.clientX, event.clientY)
    }

    Editor.prototype.closeMenu = function () {
        if (this.menu && this.menu.parentNode) this.menu.parentNode.removeChild(this.menu)
        this.menu = null
    }

    Editor.prototype.openMenu = function (clientX, clientY) {
        this.closeMenu()

        var self = this
        var rect = this.canvas.getBoundingClientRect()

        var menu = document.createElement('div')
        menu.className = 'rdio-stream-menu'
        menu.style.left = (clientX - rect.left) + 'px'
        menu.style.top = (clientY - rect.top) + 'px'

        // Keep clicks inside the menu from reaching the canvas beneath it.
        menu.addEventListener('pointerdown', function (e) { e.stopPropagation() })
        menu.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation() })

        function section(label) {
            var el = document.createElement('div')
            el.className = 'menu-section'
            el.textContent = label
            menu.appendChild(el)
        }

        function action(label, fn) {
            var el = document.createElement('button')
            el.className = 'menu-item'
            el.type = 'button'
            el.textContent = label
            el.addEventListener('click', function () { fn(); self.closeMenu() })
            menu.appendChild(el)
            return el
        }

        if (this.selected.size) {
            section(this.selected.size === 1 ? L.itemLabel(this.find(Array.from(this.selected)[0]).type)
                : this.selected.size + ' selected')
            action('Properties…', function () { self.openProps(clientX - rect.left, clientY - rect.top) })
            action('Delete', function () { self.removeSelected() })
            action('Bring to front', function () { self.reorder(true) })
            action('Send to back', function () { self.reorder(false) })
        } else {
            section('Canvas')
            action('Canvas properties…', function () { self.openProps(clientX - rect.left, clientY - rect.top) })
        }

        section('Add')

        var counts = {}
        this.store.getLayout().items.forEach(function (i) { counts[i.type] = (counts[i.type] || 0) + 1 })

        L.ITEM_TYPES.forEach(function (type) {
            var n = counts[type.type] || 0
            var el = action(type.label + (n ? ' (' + n + ')' : ''), function () {
                self.addItem(type.type, clientX - rect.left, clientY - rect.top)
            })
            // Types with data behind them that are not on screen are worth
            // pointing at; decoration and custom text are not "missing".
            if (!n && type.type !== 'text' && !L.isBorder(type.type)) {
                el.classList.add('missing')
            }
        })

        section('Canvas')
        var layout = this.store.getLayout()
        action(layout.showGrid ? 'Hide grid' : 'Show grid', function () {
            self.store.update({ showGrid: !layout.showGrid })
        })
        action('Leave edit mode', function () { self.store.update({ moveMode: false }) })
        action('Reset to defaults', function () {
            if (window.confirm('Reset the overlay to its default layout? This cannot be undone.')) {
                self.store.reset()
                self.setSelection([])
            }
        })

        section('Layout file')
        action('Export…', function () { self.exportLayout() })
        action('Import…', function () { self.importLayout() })

        this.canvas.appendChild(menu)
        this.menu = menu

        // Nudge back inside the canvas if it would hang off an edge.
        var box = menu.getBoundingClientRect()
        if (box.right > rect.right) menu.style.left = (rect.width - box.width - 4) + 'px'
        if (box.bottom > rect.bottom) menu.style.top = (rect.height - box.height - 4) + 'px'
    }

    Editor.prototype.openProps = function (x, y) {
        if (!this.props) this.props = new root.RdioStreamProps(this.canvas, this.store)

        var self = this
        var items = this.store.getLayout().items.filter(function (i) { return self.selected.has(i.id) })

        this.props.open(items, x, y)
    }

    // The panel reads values from the layout when it opens, so a change made
    // elsewhere — a drag, another window over the layout channel — would leave
    // stale numbers in its boxes. Rebuilt on change, but only while it is open.
    Editor.prototype.refreshProps = function () {
        if (!this.props || !this.props.isOpen()) return

        var panel = this.props.panel
        var x = parseFloat(panel.style.left) || 0
        var y = parseFloat(panel.style.top) || 0

        // Never while someone is typing into it — reopening would move focus and
        // discard a half-entered value.
        if (panel.contains(document.activeElement)) return

        this.openProps(x, y)
    }

    Editor.prototype.reorder = function (toFront) {
        var gone = this.selected
        var items = this.store.getLayout().items
        var moving = items.filter(function (i) { return gone.has(i.id) })
        var rest = items.filter(function (i) { return !gone.has(i.id) })

        this.store.setItems(toFront ? rest.concat(moving) : moving.concat(rest))
    }

    Editor.prototype.addItem = function (type, x, y) {
        var def = L.typeDef(type)
        if (!def) return

        var layout = L.defaults()
        // Build from a default of the same type so every field is present and
        // matches what a fresh layout would have.
        var template = null
        for (var i = 0; i < layout.items.length; i++) {
            if (layout.items[i].type === type) { template = layout.items[i]; break }
        }

        var item = {}
        var source = template || layout.items[0]
        for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) item[k] = source[k]

        item.id = this.store.genId()
        item.type = type
        item.x = Math.max(0, Math.round(x))
        item.y = Math.max(0, Math.round(y))
        item.w = def.w
        item.h = def.h
        item.fontSize = def.fontSize
        item.titleFontSize = def.fontSize
        item.titleEnabled = def.titleOn
        item.historyCols = type === 'history' ? L.defaultHistoryCols() : []

        if (type === 'shape') {
            item.points = L.defaultShapePoints(def.w, def.h)
            item.dividers = []
        }

        this.store.setItems(this.store.getLayout().items.concat([item]))
        this.setSelection([item.id])
    }

    Editor.prototype.exportLayout = function () {
        var blob = new Blob([this.store.exportLayout()], { type: 'application/json' })
        var url = URL.createObjectURL(blob)

        var a = document.createElement('a')
        a.href = url
        a.download = 'rdio-scanner-stream-layout.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)

        // Revoked on a later turn so the download has certainly started.
        setTimeout(function () { URL.revokeObjectURL(url) }, 10000)
    }

    Editor.prototype.importLayout = function () {
        var self = this
        var input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json,.json'

        input.addEventListener('change', function () {
            var file = input.files && input.files[0]
            if (!file) return

            var reader = new FileReader()
            reader.onload = function () {
                var result = self.store.importLayout(String(reader.result))
                if (!result.success) {
                    window.alert('That file could not be imported: ' + result.error)
                    return
                }
                self.setSelection([])
            }
            reader.readAsText(file)
        })

        input.click()
    }

    root.RdioStreamEditor = Editor
})(window)
