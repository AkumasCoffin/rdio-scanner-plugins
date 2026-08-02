/*
 * Stream overlay — rendering.
 *
 * Draws the layout as plain DOM. The built-in overlay was an Angular template
 * with bindings re-evaluated on every change detection pass; here each item is
 * built once and only its text is rewritten on update, because this repaints
 * twice a second for as long as a broadcast runs.
 *
 * Visibility, colour and title rules are copied from the original rather than
 * reinvented — an overlay that disagreed with the LCD about when to show a flag
 * would be worse than one that did not show it at all.
 */

;(function (root) {
    'use strict'

    var L = root.RdioStreamLayout

    function Renderer(container, store, state) {
        this.container = container
        this.store = store
        this.state = state
        this.nodes = new Map()
        this.signature = ''
    }

    Renderer.prototype.mount = function () {
        this.canvas = document.createElement('div')
        this.canvas.className = 'rdio-stream-root'

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        this.svg.setAttribute('class', 'rdio-stream-shapes')
        this.canvas.appendChild(this.svg)

        this.container.appendChild(this.canvas)

        this.build()
        return this
    }

    Renderer.prototype.destroy = function () {
        this.nodes.clear()
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas)
        }
    }

    // Item identity for reuse. Rebuilding only when the set of items or their
    // geometry changes keeps the twice-a-second update to text writes.
    Renderer.prototype.layoutSignature = function (layout) {
        return layout.items.map(function (i) {
            return [i.id, i.type, i.x, i.y, i.w, i.h, i.fontSize, i.fontFamily, i.bold,
                i.align, i.titleEnabled, i.titleText, i.titleFontSize, i.titleFontFamily,
                i.titleBold, i.borderWidth, i.innerWidth, i.cornerRadius, i.centerFill,
                i.middleFill, i.middleWidth, i.text].join(':')
        }).join('|') + '#' + layout.bgColor + ':' + layout.gridSize + ':' + layout.showGrid
    }

    Renderer.prototype.build = function () {
        var layout = this.store.getLayout()

        this.canvas.style.backgroundColor = layout.bgColor
        this.canvas.style.setProperty('--stream-grid', layout.gridSize + 'px')
        this.canvas.classList.toggle('show-grid', !!layout.showGrid)
        this.canvas.classList.toggle('move-mode', !!layout.moveMode)

        // Drop nodes for items that are gone.
        var seen = {}
        for (var i = 0; i < layout.items.length; i++) seen[layout.items[i].id] = true

        var self = this
        Array.from(this.nodes.keys()).forEach(function (id) {
            if (!seen[id]) {
                var node = self.nodes.get(id)
                if (node && node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el)
                self.nodes.delete(id)
            }
        })

        for (var j = 0; j < layout.items.length; j++) {
            this.buildItem(layout.items[j])
        }

        this.signature = this.layoutSignature(layout)
        this.update()
    }

    Renderer.prototype.buildItem = function (item) {
        var existing = this.nodes.get(item.id)
        if (existing && existing.el.parentNode) {
            this.styleItem(existing, item)
            return
        }

        var el = document.createElement('div')
        el.className = 'rdio-stream-item'
        el.setAttribute('data-type', item.type)
        // The editor finds an item from a pointer event by walking up to this.
        el.setAttribute('data-id', item.id)
        el.setAttribute('data-autoscroll', item.autoScroll ? '1' : '0')

        var content = document.createElement('div')
        content.className = 'item-content'
        el.appendChild(content)

        var node = { el: el, content: content, item: item }

        // Resize grip. Present always, shown only while editing — creating it on
        // demand would mean rebuilding every item each time edit mode is
        // toggled, which would also drop the current selection.
        if (!L.isShape(item.type)) {
            node.grip = document.createElement('span')
            node.grip.className = 'rdio-stream-resize'
            node.grip.title = 'Drag to resize'
            el.appendChild(node.grip)
        }

        if (item.type === 'history') {
            node.table = document.createElement('table')
            node.table.className = 'hist-table'
            node.thead = document.createElement('thead')
            node.tbody = document.createElement('tbody')
            node.table.appendChild(node.thead)
            node.table.appendChild(node.tbody)
            content.appendChild(node.table)

        } else if (item.type === 'transcript') {
            node.title = document.createElement('div')
            node.title.className = 'transcript-label'
            node.value = document.createElement('div')
            node.value.className = 'transcript-text'
            content.appendChild(node.title)
            content.appendChild(node.value)

        } else if (!L.isBorder(item.type)) {
            node.title = document.createElement('span')
            node.title.className = 'item-title'
            node.value = document.createElement('span')
            node.value.className = 'item-value'
            content.appendChild(node.title)
            content.appendChild(node.value)
        }

        this.styleItem(node, item)
        this.canvas.appendChild(el)
        this.nodes.set(item.id, node)
    }

    Renderer.prototype.styleItem = function (node, item) {
        var el = node.el
        node.item = item

        el.style.left = item.x + 'px'
        el.style.top = item.y + 'px'
        el.style.width = item.w + 'px'
        el.style.height = item.h + 'px'
        el.style.fontSize = item.fontSize + 'px'
        el.style.fontFamily = item.fontFamily || ''
        el.style.fontWeight = item.bold ? '700' : '400'

        el.classList.toggle('frame', L.isFrame(item.type))
        el.classList.toggle('shape', L.isShape(item.type))
        el.classList.toggle('big', item.type === 'talkgroupName')
        el.classList.toggle('flag', item.type === 'avoid' || item.type === 'patch')
        el.classList.toggle('small', item.type === 'delay' || item.type === 'tempAvoid' ||
            item.type === 'avoid' || item.type === 'patch')
        el.classList.toggle('transcript', item.type === 'transcript')
        el.classList.toggle('history', item.type === 'history')
        el.classList.toggle('textbox', item.type === 'text')

        el.setAttribute('data-autoscroll', item.autoScroll ? '1' : '0')
        node.content.style.textAlign = item.align

        if (L.isFrame(item.type)) {
            el.style.borderStyle = 'solid'
            el.style.borderWidth = item.borderWidth + 'px'
            el.style.borderRadius = item.cornerRadius + 'px'
        }

        if (node.title) {
            node.title.style.fontSize = item.titleFontSize + 'px'
            node.title.style.fontFamily = item.titleFontFamily || ''
            node.title.style.fontWeight = item.titleBold ? '700' : '400'
        }
    }

    // The playing talkgroup's LCD colour, for items that follow it.
    Renderer.prototype.ledColor = function () {
        var call = this.state.displayCall
        var led = call && call.talkgroupData && call.talkgroupData.led
        return led || undefined
    }

    Renderer.prototype.colorOf = function (item) {
        return item.useLedColor ? (this.ledColor() || item.color) : item.color
    }

    Renderer.prototype.titleColorOf = function (item) {
        return item.titleUseLed ? (this.ledColor() || item.titleColor) : item.titleColor
    }

    // Idle means nothing is playing. Both toggles off = always shown.
    Renderer.prototype.dataVisible = function (item) {
        var idle = !this.state.call
        if (item.hideOnCall && !idle) return false
        if (item.hideOnIdle && idle) return false
        return true
    }

    Renderer.prototype.titleVisible = function (item) {
        var idle = !this.state.call
        if (item.titleHideOnCall && !idle) return false
        if (item.titleHideOnIdle && idle) return false
        return true
    }

    // Whether a conditionally-empty element has a value, so its title is not
    // left standing alone with nothing after it.
    Renderer.prototype.hasContent = function (item) {
        if (item.type === 'uid') return !!this.state.callUnit
        if (item.type === 'tempAvoid') return this.state.tempAvoid > 0
        return true
    }

    Renderer.prototype.titleTextOf = function (item) {
        return item.titleText || L.itemTitle(item.type)
    }

    Renderer.prototype.update = function () {
        var layout = this.store.getLayout()

        // Geometry changed under us — rebuild before writing values.
        if (this.layoutSignature(layout) !== this.signature) {
            this.build()
            return
        }

        for (var i = 0; i < layout.items.length; i++) {
            var item = layout.items[i]
            var node = this.nodes.get(item.id)
            if (node) this.updateItem(node, item)
        }
    }

    Renderer.prototype.updateItem = function (node, item) {
        var color = this.colorOf(item)
        node.el.style.color = color
        if (L.isFrame(item.type)) node.el.style.borderColor = color

        if (L.isBorder(item.type)) return

        var showData = this.dataVisible(item)

        if (item.type === 'history') {
            node.table.style.display = showData ? '' : 'none'
            if (showData) this.updateHistory(node, item)
            return
        }

        if (item.type === 'transcript') {
            node.el.style.display = showData ? '' : 'none'
            var showTitle = item.titleEnabled && this.titleVisible(item)
            node.title.style.display = showTitle ? '' : 'none'
            setText(node, 'title', this.titleTextOf(item))
            node.title.style.color = this.titleColorOf(item)

            var transcript = this.state.displayCall && this.state.displayCall.transcript

            // Same reason as below: the transcript scrolls in time with the call,
            // and rewriting it unchanged would reset that every tick.
            setText(node, 'value', transcript || '—')
            node.value.classList.toggle('placeholder', !transcript)
            return
        }

        var value = this.valueOf(item)

        node.value.style.display = showData ? '' : 'none'
        setText(node, 'value', value)

        var titleWanted = item.titleEnabled && L.itemTitle(item.type) &&
            this.hasContent(item) && this.titleVisible(item)

        node.title.style.display = titleWanted ? '' : 'none'
        if (titleWanted) {
            setText(node, 'title', this.titleTextOf(item) + ': ')
            node.title.style.color = this.titleColorOf(item)
        }
    }

    // Writes text only when it changed.
    //
    // Not an optimisation — a correctness fix. Assigning textContent replaces
    // the text node, and the browser resets the container's scroll position when
    // it does. Rewriting an unchanged value twice a second therefore pinned
    // every marquee at zero: the scroller moved it, the next render put it back,
    // and nothing ever scrolled. Found by measuring scrollTop in a browser after
    // the marquee's opening pause and getting 0.
    function setText(node, which, text) {
        var key = which + 'Text'
        if (node[key] === text) return
        node[key] = text
        node[which].textContent = text
    }

    Renderer.prototype.updateHistory = function (node, item) {
        var cols = item.historyCols.filter(function (c) { return c.visible })

        function styleCell(cell, col) {
            cell.style.color = col.color
            cell.style.fontSize = col.fontSize + 'px'
            cell.style.fontWeight = col.bold ? '700' : '400'
        }

        node.table.classList.toggle('row-lines', !!item.histRowLines)
        node.table.classList.toggle('col-lines', !!item.histColLines)
        node.table.style.setProperty('--hist-line', item.histLineColor)
        node.table.style.setProperty('--hist-lw', item.histLineWidth + 'px')

        // Header is rebuilt only when the visible columns change.
        // Includes the styling, not just the identity: the header was keyed on
        // key and title alone, so recolouring a column restyled its cells and
        // left the heading above them unchanged.
        var headerKey = cols.map(function (c) {
            return [c.key, c.title, c.color, c.fontSize, c.bold].join(':')
        }).join('|')
        if (node.headerKey !== headerKey) {
            node.thead.textContent = ''
            var tr = document.createElement('tr')
            cols.forEach(function (col) {
                var th = document.createElement('th')
                th.textContent = col.title
                styleCell(th, col)
                tr.appendChild(th)
            })
            node.thead.appendChild(tr)
            node.headerKey = headerKey
        }

        node.tbody.textContent = ''

        var self = this
        this.state.callHistory.forEach(function (call) {
            if (!call) return
            var row = document.createElement('tr')
            cols.forEach(function (col) {
                var td = document.createElement('td')
                td.textContent = self.historyCell(call, col.key)
                styleCell(td, col)
                row.appendChild(td)
            })
            node.tbody.appendChild(row)
        })
    }

    Renderer.prototype.historyCell = function (call, key) {
        switch (key) {
            case 'time':
                return call.dateTime ? formatTime(new Date(call.dateTime), this.state.timeFormat) : ''
            case 'system':
                return (call.systemData && call.systemData.label) || String(call.system || '')
            case 'talkgroup':
                return (call.talkgroupData && call.talkgroupData.label) || String(call.talkgroup || '')
            case 'name':
                return (call.talkgroupData && call.talkgroupData.name) || ''
            default:
                return ''
        }
    }

    Renderer.prototype.valueOf = function (item) {
        var s = this.state

        switch (item.type) {
            case 'text': return item.text
            case 'clock': return formatTime(s.clock, s.timeFormat)
            case 'callProgress': return formatTime(s.callProgress, s.timeFormat)
            case 'listeners': return String(s.listeners)
            case 'queue': return String(s.callQueue)
            case 'delay': {
                var delay = s.formatDelay(s.queueTime) || '0:00'
                // The amount an auto-jump just shed, shown beside the delay for
                // a few seconds exactly as the LCD does.
                var shed = s.delayRemoved > 0 ? s.formatDelay(s.delayRemoved) : ''
                return shed ? delay + ' -' + shed : delay
            }
            case 'system': return s.callSystem
            case 'tag': return s.callTag
            case 'talkgroup': return s.callTalkgroup
            case 'callDate': return s.callDate ? formatDate(s.callDate) : ''
            case 'talkgroupName': return s.callTalkgroupName
            case 'tgid': return s.callTalkgroupId || '0'
            case 'uid': return s.callUnit || ''
            case 'tempAvoid': return s.tempAvoid > 0 ? '⏲︎ ' + s.tempAvoid + 'M' : ''
            case 'avoid': return s.avoided ? 'AVOID' : ''
            case 'patch': return s.patched ? 'PATCH' : ''
            default: return ''
        }
    }

    function pad(n) { return n < 10 ? '0' + n : String(n) }

    // Hours and minutes, no seconds, matching the LCD — which formats these with
    // Angular's date pipe and a 'HH:mm' pattern, or 'h:mm a' when the server is
    // set to 12-hour time. Showing seconds here made the clock wider than its
    // box and pushed its own title out of view.
    function formatTime(date, format) {
        if (!date || isNaN(date.getTime())) return ''

        var hours = date.getHours()
        var minutes = pad(date.getMinutes())

        if (format === 'h:mm a') {
            var suffix = hours < 12 ? 'AM' : 'PM'
            var twelve = hours % 12
            if (twelve === 0) twelve = 12
            return twelve + ':' + minutes + ' ' + suffix
        }

        return pad(hours) + ':' + minutes
    }

    function formatDate(date) {
        if (!date || isNaN(date.getTime())) return ''
        return pad(date.getMonth() + 1) + '/' + pad(date.getDate())
    }

    Renderer.formatTime = formatTime
    Renderer.formatDate = formatDate

    root.RdioStreamRenderer = Renderer
})(window)
