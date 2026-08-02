/*
 * Stream overlay — layout store.
 *
 * Ported from stream-layout.service.ts. Same localStorage key and the same
 * BroadcastChannel, so an existing layout is picked up by the plugin with no
 * migration: same origin, same storage, same shape.
 *
 * normalize() is the part that must not drift. It is what makes an exported file
 * load — including files exported years ago — and it carries the frameLink to
 * shape rename that older layouts still rely on. Every default here matches the
 * original exactly.
 *
 * Angular's EventEmitter is replaced by a plain listener list; nothing else
 * changes.
 */

;(function (root) {
    'use strict'

    var L = root.RdioStreamLayout

    function Store() {
        this.listeners = []
        this.idSeq = 0
        this.channel = undefined
        this.layout = this.load()

        try {
            if (typeof BroadcastChannel !== 'undefined') {
                this.channel = new BroadcastChannel(L.CHANNEL)
                var self = this
                this.channel.onmessage = function (e) { self.onRemote(e && e.data) }
            }
        } catch (err) {
            // BroadcastChannel unavailable — degrade to localStorage only.
        }
    }

    Store.prototype.onChange = function (fn) {
        this.listeners.push(fn)
        return this
    }

    Store.prototype.emit = function () {
        for (var i = 0; i < this.listeners.length; i++) {
            try {
                this.listeners[i](this.layout)
            } catch (err) {
                console.error('[stream] layout listener failed', err)
            }
        }
    }

    Store.prototype.getLayout = function () {
        return this.layout
    }

    Store.prototype.update = function (partial) {
        var next = {}
        for (var k in this.layout) if (Object.prototype.hasOwnProperty.call(this.layout, k)) next[k] = this.layout[k]
        for (var p in partial) if (Object.prototype.hasOwnProperty.call(partial, p)) next[p] = partial[p]
        next.items = this.layout.items
        this.layout = next
        this.commit(true)
    }

    Store.prototype.setItems = function (items) {
        var next = {}
        for (var k in this.layout) if (Object.prototype.hasOwnProperty.call(this.layout, k)) next[k] = this.layout[k]
        next.items = items
        this.layout = next
        this.commit(true)
    }

    Store.prototype.updateItem = function (id, partial) {
        this.setItems(this.layout.items.map(function (i) {
            if (i.id !== id) return i
            var merged = {}
            for (var k in i) if (Object.prototype.hasOwnProperty.call(i, k)) merged[k] = i[k]
            for (var p in partial) if (Object.prototype.hasOwnProperty.call(partial, p)) merged[p] = partial[p]
            return merged
        }))
    }

    Store.prototype.reset = function () {
        this.layout = L.defaults()
        this.commit(true)
    }

    Store.prototype.exportLayout = function () {
        return JSON.stringify(this.layout, null, 2)
    }

    // Load a layout from an exported JSON string. Returns a result so the UI can
    // report success or failure. Unknown and older shapes are normalized.
    Store.prototype.importLayout = function (json) {
        var parsed
        try {
            parsed = JSON.parse(json)
        } catch (err) {
            return { success: false, error: 'Not valid JSON.' }
        }

        if (!parsed || typeof parsed !== 'object') {
            return { success: false, error: 'Not a valid stream layout.' }
        }

        this.layout = this.normalize(parsed)
        this.commit(true)
        return { success: true }
    }

    Store.prototype.genId = function () {
        this.idSeq += 1
        return 'i' + Date.now().toString(36) + '-' + this.idSeq.toString(36) +
            '-' + Math.floor(Math.random() * 1e6).toString(36)
    }

    Store.prototype.onRemote = function (data) {
        if (!data || typeof data !== 'object') return
        this.layout = this.normalize(data)
        // Apply and persist locally, but do not re-broadcast (avoids ping-pong).
        this.commit(false)
    }

    Store.prototype.commit = function (broadcast) {
        var saved = true

        try {
            window.localStorage.setItem(L.STORAGE_KEY, JSON.stringify(this.layout))
        } catch (err) {
            // The original swallowed this silently, which makes a failed write
            // indistinguishable from a successful one: the overlay updates, the
            // next reload shows the old layout, and nothing ever said why.
            // Storage being full or partitioned is exactly when a user most
            // needs to know their work is not being kept.
            saved = false
            console.error('[stream] could not save the layout to browser storage — ' +
                'changes will be lost on reload. Export it to keep a copy.', err)
        }

        if (broadcast) {
            try {
                if (this.channel) this.channel.postMessage(this.layout)
            } catch (err) {
                // Best effort.
            }
        }

        this.saved = saved
        this.emit()
    }

    Store.prototype.load = function () {
        try {
            var raw = window.localStorage.getItem(L.STORAGE_KEY)
            if (raw) return this.normalize(JSON.parse(raw))
        } catch (err) {
            // Fall through to defaults.
        }
        return L.defaults()
    }

    // Coerce arbitrary stored or received data into a valid layout. Falls back to
    // defaults for anything missing or malformed; drops items of unknown type.
    Store.prototype.normalize = function (input) {
        var base = L.defaults()
        if (!input || typeof input !== 'object') return base

        var self = this
        var items = base.items

        if (Array.isArray(input.items)) {
            items = []
            for (var i = 0; i < input.items.length; i++) {
                var item = self.normalizeItem(input.items[i])
                if (item) items.push(item)
            }
        }

        return {
            bgColor: typeof input.bgColor === 'string' ? input.bgColor : base.bgColor,
            moveMode: typeof input.moveMode === 'boolean' ? input.moveMode : base.moveMode,
            gridSize: typeof input.gridSize === 'number' ? input.gridSize : base.gridSize,
            showGrid: typeof input.showGrid === 'boolean' ? input.showGrid : base.showGrid,
            items: items,
        }
    }

    Store.prototype.normalizeItem = function (raw) {
        if (!raw || typeof raw !== 'object') return null

        var r = raw
        // Migrate the old linked-frame element to the shapable border. Layouts
        // exported before that rename still contain it.
        var rawType = r.type === 'frameLink' ? 'shape' : r.type
        var def = typeof rawType === 'string' ? L.typeDef(rawType) : undefined
        if (!def) return null

        var isBorder = L.isBorder(def.type)
        var w = typeof r.w === 'number' ? r.w : def.w
        var h = typeof r.h === 'number' ? r.h : def.h

        var out = {
            id: typeof r.id === 'string' && r.id ? r.id : this.genId(),
            type: def.type,
            x: typeof r.x === 'number' ? r.x : 40,
            y: typeof r.y === 'number' ? r.y : 40,
            w: w,
            h: h,
            color: typeof r.color === 'string'
                ? r.color
                : (isBorder ? L.DEFAULT_BORDER_COLOR : L.DEFAULT_TEXT_COLOR),
            fontSize: typeof r.fontSize === 'number' ? r.fontSize : def.fontSize,
            fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily : '',
            bold: typeof r.bold === 'boolean' ? r.bold : true,
            text: typeof r.text === 'string' ? r.text : '',
            hideOnCall: typeof r.hideOnCall === 'boolean' ? r.hideOnCall : false,
            hideOnIdle: typeof r.hideOnIdle === 'boolean' ? r.hideOnIdle : false,
            titleHideOnCall: typeof r.titleHideOnCall === 'boolean' ? r.titleHideOnCall : false,
            titleHideOnIdle: typeof r.titleHideOnIdle === 'boolean' ? r.titleHideOnIdle : false,
            titleEnabled: typeof r.titleEnabled === 'boolean' ? r.titleEnabled : def.titleOn,
            titleColor: typeof r.titleColor === 'string' ? r.titleColor : L.DEFAULT_TITLE_COLOR,
            titleBold: typeof r.titleBold === 'boolean' ? r.titleBold : true,
            titleUseLed: typeof r.titleUseLed === 'boolean' ? r.titleUseLed : false,
            titleFontSize: typeof r.titleFontSize === 'number' ? r.titleFontSize : def.fontSize,
            titleFontFamily: typeof r.titleFontFamily === 'string' ? r.titleFontFamily : '',
            titleText: typeof r.titleText === 'string' ? r.titleText : '',
            useLedColor: typeof r.useLedColor === 'boolean' ? r.useLedColor : false,
            align: (r.align === 'center' || r.align === 'right') ? r.align : 'left',
            autoScroll: typeof r.autoScroll === 'boolean' ? r.autoScroll : true,
            historyCols: def.type === 'history' ? this.normalizeHistoryCols(r.historyCols) : [],
            histRowLines: typeof r.histRowLines === 'boolean' ? r.histRowLines : true,
            histColLines: typeof r.histColLines === 'boolean' ? r.histColLines : false,
            histLineWidth: typeof r.histLineWidth === 'number' ? r.histLineWidth : 1,
            histLineColor: typeof r.histLineColor === 'string' ? r.histLineColor : '#888888',
            borderWidth: typeof r.borderWidth === 'number' ? r.borderWidth : 2,
            innerWidth: typeof r.innerWidth === 'number' ? r.innerWidth : 2,
            cornerRadius: typeof r.cornerRadius === 'number' ? r.cornerRadius : 6,
            centerFill: typeof r.centerFill === 'boolean' ? r.centerFill : false,
            centerColor: typeof r.centerColor === 'string' ? r.centerColor : '#000000',
            centerUseLed: typeof r.centerUseLed === 'boolean' ? r.centerUseLed : false,
            middleFill: typeof r.middleFill === 'boolean' ? r.middleFill : false,
            middleWidth: typeof r.middleWidth === 'number' ? r.middleWidth : 2,
            middleColor: typeof r.middleColor === 'string' ? r.middleColor : '#888888',
            middleUseLed: typeof r.middleUseLed === 'boolean' ? r.middleUseLed : false,
        }

        if (def.type === 'shape') {
            out.points = this.normalizeShapePoints(r.points, w, h)
            out.dividers = this.normalizeDividers(r.dividers)
        }

        return out
    }

    Store.prototype.normalizeShapePoints = function (raw, w, h) {
        if (Array.isArray(raw)) {
            var pts = []
            for (var i = 0; i < raw.length; i++) {
                var p = raw[i]
                if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                    pts.push({ x: p.x, y: p.y })
                }
            }
            if (pts.length >= 3) return pts
        }
        return L.defaultShapePoints(w, h)
    }

    Store.prototype.normalizeDividers = function (raw) {
        if (!Array.isArray(raw)) return []

        var out = []
        for (var i = 0; i < raw.length; i++) {
            var d = raw[i]
            if (d && (d.axis === 'h' || d.axis === 'v') && typeof d.pos === 'number') {
                out.push({ axis: d.axis, pos: Math.max(0, Math.min(1, d.pos)) })
            }
        }
        return out
    }

    Store.prototype.normalizeHistoryCols = function (input) {
        var base = L.defaultHistoryCols()
        if (!Array.isArray(input)) return base

        return base.map(function (bc) {
            var found = null
            for (var i = 0; i < input.length; i++) {
                if (input[i] && input[i].key === bc.key) { found = input[i]; break }
            }
            if (!found) return bc

            return {
                key: bc.key,
                title: typeof found.title === 'string' ? found.title : bc.title,
                visible: typeof found.visible === 'boolean' ? found.visible : bc.visible,
                color: typeof found.color === 'string' ? found.color : bc.color,
                fontSize: typeof found.fontSize === 'number' ? found.fontSize : bc.fontSize,
                bold: typeof found.bold === 'boolean' ? found.bold : bc.bold,
            }
        })
    }

    Store.prototype.destroy = function () {
        try {
            if (this.channel) this.channel.close()
        } catch (err) {
            // Best effort.
        }
        this.listeners = []
    }

    root.RdioStreamStore = Store
})(window)
