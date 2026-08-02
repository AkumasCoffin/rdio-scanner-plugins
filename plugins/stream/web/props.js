/*
 * Stream overlay — the properties panel.
 *
 * The original wired up thirty-seven separate setters, one per field, each
 * pushing the same shape of change through the same path. Here the fields are
 * described once and the controls are generated from that description, so
 * adding one is a line of data rather than a handler, a binding and a template
 * block that can disagree with each other.
 *
 * Every edit applies to the whole selection, which is what makes it possible to
 * restyle a dozen readouts at once — the thing the per-field approach made
 * tedious enough that the original did it item by item.
 */

;(function (root) {
    'use strict'

    var L = root.RdioStreamLayout

    // `when` decides whether a field applies to an item. Absent means always.
    function isText(i) { return i.type === 'text' }
    function isHistory(i) { return i.type === 'history' }
    function isBorder(i) { return L.isBorder(i.type) }
    function isFrame(i) { return L.isFrame(i.type) }
    function notBorder(i) { return !L.isBorder(i.type) }

    // A title is offered only for types that define one, plus the transcript,
    // which labels itself. Flags, frames and custom text have no title.
    function hasTitle(i) { return !L.isBorder(i.type) && !!L.itemTitle(i.type) }

    var FIELDS = [
        { group: 'Item', when: notBorder, key: 'color', label: 'Colour', type: 'color' },
        { group: 'Item', when: notBorder, key: 'useLedColor', label: 'Follow talkgroup colour', type: 'bool' },
        { group: 'Item', when: notBorder, key: 'fontSize', label: 'Text size', type: 'number', min: 6, max: 200 },
        { group: 'Item', when: notBorder, key: 'fontFamily', label: 'Font', type: 'font' },
        { group: 'Item', when: notBorder, key: 'bold', label: 'Bold', type: 'bool' },
        { group: 'Item', when: notBorder, key: 'align', label: 'Align', type: 'choice', choices: ['left', 'center', 'right'] },
        { group: 'Item', when: notBorder, key: 'autoScroll', label: 'Scroll when too long', type: 'bool' },
        { group: 'Item', when: isText, key: 'text', label: 'Text', type: 'multiline' },

        { group: 'Visibility', when: notBorder, key: 'hideOnCall', label: 'Hide during a call', type: 'bool' },
        { group: 'Visibility', when: notBorder, key: 'hideOnIdle', label: 'Hide when idle', type: 'bool' },

        { group: 'Title', when: hasTitle, key: 'titleEnabled', label: 'Show title', type: 'bool' },
        { group: 'Title', when: hasTitle, key: 'titleText', label: 'Title text', type: 'text', placeholder: 'default' },
        { group: 'Title', when: hasTitle, key: 'titleColor', label: 'Title colour', type: 'color' },
        { group: 'Title', when: hasTitle, key: 'titleUseLed', label: 'Title follows talkgroup colour', type: 'bool' },
        { group: 'Title', when: hasTitle, key: 'titleBold', label: 'Title bold', type: 'bool' },
        { group: 'Title', when: hasTitle, key: 'titleFontSize', label: 'Title size', type: 'number', min: 6, max: 200 },
        { group: 'Title', when: hasTitle, key: 'titleFontFamily', label: 'Title font', type: 'font' },
        { group: 'Title', when: hasTitle, key: 'titleHideOnCall', label: 'Hide title during a call', type: 'bool' },
        { group: 'Title', when: hasTitle, key: 'titleHideOnIdle', label: 'Hide title when idle', type: 'bool' },

        { group: 'Table', when: isHistory, key: 'histRowLines', label: 'Row lines', type: 'bool' },
        { group: 'Table', when: isHistory, key: 'histColLines', label: 'Column lines', type: 'bool' },
        { group: 'Table', when: isHistory, key: 'histLineWidth', label: 'Line width', type: 'number', min: 0, max: 20 },
        { group: 'Table', when: isHistory, key: 'histLineColor', label: 'Line colour', type: 'color' },

        { group: 'Border', when: isBorder, key: 'color', label: 'Outline colour', type: 'color' },
        { group: 'Border', when: isBorder, key: 'useLedColor', label: 'Outline follows talkgroup colour', type: 'bool' },
        { group: 'Border', when: isBorder, key: 'borderWidth', label: 'Outline width', type: 'number', min: 0, max: 60 },
        { group: 'Border', when: isFrame, key: 'cornerRadius', label: 'Corner radius', type: 'number', min: 0, max: 200 },
        { group: 'Border', when: isBorder, key: 'middleFill', label: 'Middle band', type: 'bool' },
        { group: 'Border', when: isBorder, key: 'middleWidth', label: 'Middle width', type: 'number', min: 0, max: 60 },
        { group: 'Border', when: isBorder, key: 'middleColor', label: 'Middle colour', type: 'color' },
        { group: 'Border', when: isBorder, key: 'middleUseLed', label: 'Middle follows talkgroup colour', type: 'bool' },
        { group: 'Border', when: isBorder, key: 'centerFill', label: 'Inner band', type: 'bool' },
        { group: 'Border', when: isBorder, key: 'innerWidth', label: 'Inner width', type: 'number', min: 0, max: 60 },
        { group: 'Border', when: isBorder, key: 'centerColor', label: 'Inner colour', type: 'color' },
        { group: 'Border', when: isBorder, key: 'centerUseLed', label: 'Inner follows talkgroup colour', type: 'bool' },

        { group: 'Box', key: 'x', label: 'X', type: 'number', min: 0, max: 10000 },
        { group: 'Box', key: 'y', label: 'Y', type: 'number', min: 0, max: 10000 },
        { group: 'Box', key: 'w', label: 'Width', type: 'number', min: 1, max: 10000 },
        { group: 'Box', key: 'h', label: 'Height', type: 'number', min: 1, max: 10000 },
    ]

    var CANVAS_FIELDS = [
        { key: 'bgColor', label: 'Background', type: 'color' },
        { key: 'gridSize', label: 'Grid size', type: 'number', min: 2, max: 400 },
        { key: 'showGrid', label: 'Show grid', type: 'bool' },
    ]

    function Props(canvas, store) {
        this.canvas = canvas
        this.store = store
        this.panel = null
    }

    Props.prototype.close = function () {
        if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel)
        this.panel = null

        // Shape handles are hidden while this panel is open so they cannot sit
        // on top of it, and nothing else redraws them until the layout next
        // changes. Without this they stayed gone after the panel was closed with
        // its × — the only route out that does not touch the layout.
        if (this.onClose) this.onClose()
    }

    Props.prototype.isOpen = function () {
        return !!this.panel
    }

    // items: the current selection, or [] for the canvas itself.
    Props.prototype.open = function (items, x, y) {
        this.close()

        var self = this
        var panel = document.createElement('div')
        panel.className = 'rdio-stream-props'
        panel.style.left = x + 'px'
        panel.style.top = y + 'px'

        panel.addEventListener('pointerdown', function (e) { e.stopPropagation() })
        panel.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation() })

        var head = document.createElement('div')
        head.className = 'props-head'
        head.textContent = items.length
            ? (items.length === 1 ? L.itemLabel(items[0].type) : items.length + ' items')
            : 'Canvas'

        var close = document.createElement('button')
        close.type = 'button'
        close.className = 'props-close'
        close.textContent = '×'
        close.addEventListener('click', function () { self.close() })
        head.appendChild(close)

        panel.appendChild(head)

        if (items.length) {
            this.buildItemFields(panel, items)
        } else {
            this.buildCanvasFields(panel)
        }

        this.canvas.appendChild(panel)
        this.panel = panel

        // Keep it on screen.
        var rect = this.canvas.getBoundingClientRect()
        var box = panel.getBoundingClientRect()
        if (box.right > rect.right) panel.style.left = Math.max(0, rect.width - box.width - 4) + 'px'
        if (box.bottom > rect.bottom) panel.style.top = Math.max(0, rect.height - box.height - 4) + 'px'
    }

    Props.prototype.buildItemFields = function (panel, items) {
        var self = this
        var shown = {}

        FIELDS.forEach(function (field) {
            // A field appears when it applies to every selected item, so a mixed
            // selection never offers a control that would silently no-op on half
            // of them.
            var applies = items.every(function (i) { return !field.when || field.when(i) })
            if (!applies) return

            if (!shown[field.group]) {
                shown[field.group] = true
                var s = document.createElement('div')
                s.className = 'props-group'
                s.textContent = field.group
                panel.appendChild(s)
            }

            panel.appendChild(self.control(field, items, function (value) {
                var patch = {}
                patch[field.key] = value
                items.forEach(function (i) { self.store.updateItem(i.id, patch) })
            }))
        })

        if (items.length === 1 && items[0].type === 'history') {
            this.buildHistoryColumns(panel, items[0])
        }
    }

    Props.prototype.buildCanvasFields = function (panel) {
        var self = this
        var layout = this.store.getLayout()

        CANVAS_FIELDS.forEach(function (field) {
            panel.appendChild(self.control(field, [layout], function (value) {
                var patch = {}
                patch[field.key] = value
                self.store.update(patch)
            }))
        })
    }

    Props.prototype.buildHistoryColumns = function (panel, item) {
        var self = this

        var s = document.createElement('div')
        s.className = 'props-group'
        s.textContent = 'Columns'
        panel.appendChild(s)

        item.historyCols.forEach(function (col, index) {
            var row = document.createElement('div')
            row.className = 'props-row props-col'

            function patchCol(patch) {
                var cols = item.historyCols.map(function (c, i) {
                    if (i !== index) return c
                    var merged = {}
                    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) merged[k] = c[k]
                    for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) merged[p] = patch[p]
                    return merged
                })
                self.store.updateItem(item.id, { historyCols: cols })
            }

            var visible = document.createElement('input')
            visible.type = 'checkbox'
            visible.checked = !!col.visible
            visible.addEventListener('change', function () { patchCol({ visible: visible.checked }) })

            var title = document.createElement('input')
            title.type = 'text'
            title.value = col.title
            title.className = 'props-coltitle'
            title.addEventListener('change', function () { patchCol({ title: title.value }) })

            var colour = document.createElement('input')
            colour.type = 'color'
            colour.value = normalizeColor(col.color)
            colour.addEventListener('input', function () { patchCol({ color: colour.value }) })

            var size = document.createElement('input')
            size.type = 'number'
            size.min = '6'
            size.max = '200'
            size.value = String(col.fontSize)
            size.className = 'props-colsize'
            size.addEventListener('change', function () {
                var n = Number(size.value)
                if (isFinite(n)) patchCol({ fontSize: Math.max(6, Math.min(200, n)) })
            })

            var bold = document.createElement('input')
            bold.type = 'checkbox'
            bold.checked = !!col.bold
            bold.title = 'Bold'
            bold.addEventListener('change', function () { patchCol({ bold: bold.checked }) })

            row.appendChild(visible)
            row.appendChild(title)
            row.appendChild(colour)
            row.appendChild(size)
            row.appendChild(bold)
            panel.appendChild(row)
        })
    }

    // A colour input only accepts #rrggbb. Anything else — a named colour, or
    // rgba() from an older layout — would silently reset the swatch to black
    // and write that back the moment it was touched.
    function normalizeColor(value) {
        return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#ffffff'
    }

    Props.prototype.control = function (field, items, apply) {
        var row = document.createElement('label')
        row.className = 'props-row'

        var label = document.createElement('span')
        label.className = 'props-label'
        label.textContent = field.label
        row.appendChild(label)

        var first = items[0]
        var value = first[field.key]

        // A mixed selection shows the first item's value; changing it sets all.
        var mixed = items.some(function (i) { return i[field.key] !== value })
        if (mixed) row.classList.add('mixed')

        var input

        switch (field.type) {
            case 'bool':
                input = document.createElement('input')
                input.type = 'checkbox'
                input.checked = !!value
                input.addEventListener('change', function () { apply(input.checked) })
                break

            case 'number':
                input = document.createElement('input')
                input.type = 'number'
                input.min = String(field.min)
                input.max = String(field.max)
                input.value = String(value)
                input.addEventListener('change', function () {
                    var n = Number(input.value)
                    if (!isFinite(n)) return
                    apply(Math.max(field.min, Math.min(field.max, Math.round(n))))
                })
                break

            case 'color':
                input = document.createElement('input')
                input.type = 'color'
                input.value = normalizeColor(value)
                input.addEventListener('input', function () { apply(input.value) })
                break

            case 'font':
                input = document.createElement('select')
                L.FONTS.forEach(function (font) {
                    var option = document.createElement('option')
                    option.value = font.value
                    option.textContent = font.label
                    if (font.value === value) option.selected = true
                    input.appendChild(option)
                })
                input.addEventListener('change', function () { apply(input.value) })
                break

            case 'choice':
                input = document.createElement('select')
                field.choices.forEach(function (choice) {
                    var option = document.createElement('option')
                    option.value = choice
                    option.textContent = choice
                    if (choice === value) option.selected = true
                    input.appendChild(option)
                })
                input.addEventListener('change', function () { apply(input.value) })
                break

            case 'multiline':
                input = document.createElement('textarea')
                input.rows = 3
                input.value = String(value || '')
                input.addEventListener('change', function () { apply(input.value) })
                break

            default:
                input = document.createElement('input')
                input.type = 'text'
                input.value = String(value || '')
                if (field.placeholder) input.placeholder = field.placeholder
                input.addEventListener('change', function () { apply(input.value) })
        }

        input.className = 'props-input'
        row.appendChild(input)

        return row
    }

    Props.FIELDS = FIELDS
    Props.CANVAS_FIELDS = CANVAS_FIELDS
    Props.normalizeColor = normalizeColor

    root.RdioStreamProps = Props
})(window)
