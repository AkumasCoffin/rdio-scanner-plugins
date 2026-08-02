/*
 * Stream overlay — layout model.
 *
 * Ported verbatim from the built-in overlay's stream-layout.ts. Deliberately a
 * straight translation rather than a tidy-up: this file defines the shape of an
 * exported layout, and export/import is the only backup users have. A field
 * renamed while moving would silently invalidate every layout file already on
 * disk, and the failure would show up as "my import does nothing" long after the
 * change.
 *
 * Types are the one thing dropped, since they carry no runtime behaviour.
 */

;(function (root) {
    'use strict'

    var Layout = {}

    Layout.STORAGE_KEY = 'rdio-scanner-stream-layout'
    Layout.CHANNEL = 'rdio-scanner-stream-layout'

    Layout.DEFAULT_TEXT_COLOR = '#ffffff'
    Layout.DEFAULT_BORDER_COLOR = '#ffffff'
    Layout.DEFAULT_TITLE_COLOR = '#ffffff'

    Layout.HISTORY_COLS = [
        { key: 'time', title: 'Time' },
        { key: 'system', title: 'System' },
        { key: 'talkgroup', title: 'Talkgroup' },
        { key: 'name', title: 'Name' },
    ]

    // Catalog of addable item types: a human label + default box size + default
    // font size. `title` is the label shown before the value when titles are on
    // ('' = the type has no title option). `titleOn` is the per-type default.
    Layout.ITEM_TYPES = [
        { type: 'text', label: 'Custom Text', w: 200, h: 32, minW: 60, minH: 24, fontSize: 18, title: '', titleOn: false },
        { type: 'clock', label: 'Time', w: 140, h: 30, minW: 100, minH: 24, fontSize: 18, title: 'Time', titleOn: true },
        { type: 'callProgress', label: 'Call Time', w: 190, h: 30, minW: 120, minH: 24, fontSize: 18, title: 'Call Time', titleOn: true },
        { type: 'listeners', label: 'Listeners', w: 160, h: 30, minW: 110, minH: 24, fontSize: 18, title: 'Listeners', titleOn: true },
        { type: 'queue', label: 'Queue', w: 130, h: 30, minW: 90, minH: 24, fontSize: 18, title: 'Queue', titleOn: true },
        { type: 'delay', label: 'Delay', w: 160, h: 26, minW: 100, minH: 20, fontSize: 14, title: 'Delay', titleOn: true },
        { type: 'system', label: 'System', w: 280, h: 30, minW: 140, minH: 24, fontSize: 18, title: 'System', titleOn: false },
        { type: 'tag', label: 'Tag', w: 240, h: 30, minW: 120, minH: 24, fontSize: 18, title: 'Tag', titleOn: false },
        { type: 'talkgroup', label: 'Talkgroup', w: 280, h: 30, minW: 140, minH: 24, fontSize: 18, title: 'Talkgroup', titleOn: false },
        { type: 'callDate', label: 'Call Date', w: 110, h: 30, minW: 80, minH: 24, fontSize: 18, title: 'Date', titleOn: false },
        { type: 'talkgroupName', label: 'Talkgroup Name', w: 600, h: 44, minW: 200, minH: 30, fontSize: 26, title: 'Name', titleOn: false },
        { type: 'tgid', label: 'TGID', w: 180, h: 30, minW: 110, minH: 24, fontSize: 18, title: 'TGID', titleOn: true },
        { type: 'uid', label: 'UID', w: 320, h: 30, minW: 140, minH: 24, fontSize: 18, title: 'UID', titleOn: true },
        { type: 'tempAvoid', label: 'Avoid Timer', w: 110, h: 26, minW: 70, minH: 20, fontSize: 14, title: 'Avoid', titleOn: false },
        { type: 'avoid', label: 'Avoid Flag', w: 90, h: 26, minW: 60, minH: 20, fontSize: 14, title: '', titleOn: false },
        { type: 'patch', label: 'Patch Flag', w: 90, h: 26, minW: 60, minH: 20, fontSize: 14, title: '', titleOn: false },
        { type: 'transcript', label: 'Transcript', w: 600, h: 170, minW: 200, minH: 60, fontSize: 20, title: 'TRANSCRIPT', titleOn: true },
        { type: 'history', label: 'History Table', w: 600, h: 200, minW: 240, minH: 80, fontSize: 13, title: '', titleOn: false },
        { type: 'frame', label: 'Border Frame', w: 560, h: 240, minW: 40, minH: 30, fontSize: 18, title: '', titleOn: false },
        { type: 'shape', label: 'Shapable Border', w: 320, h: 200, minW: 40, minH: 30, fontSize: 18, title: '', titleOn: false },
    ]

    // Font choices offered in the context menu. '' = the page default (monospace).
    Layout.FONTS = [
        { value: '', label: 'Default (mono)' },
        { value: '"Orbitron", sans-serif', label: '★ Orbitron' },
        { value: '"Audiowide", sans-serif', label: '★ Audiowide' },
        { value: '"Share Tech Mono", monospace', label: '★ Share Tech Mono' },
        { value: '"VT323", monospace', label: '★ VT323 (CRT)' },
        { value: '"Wallpoet", sans-serif', label: '★ Wallpoet (LED)' },
        { value: '"Major Mono Display", monospace', label: '★ Major Mono' },
        { value: '"Chakra Petch", sans-serif', label: '★ Chakra Petch' },
        { value: '"Teko", sans-serif', label: '★ Teko' },
        { value: '"Bitcount Grid Double", monospace', label: '★ Bitcount Grid Double' },
        { value: '"Bitcount Single", monospace', label: '★ Bitcount Single' },
        { value: '"Pixelify Sans", sans-serif', label: '★ Pixelify Sans' },
        { value: '"Tourney", sans-serif', label: '★ Tourney' },
        { value: 'Roboto, sans-serif', label: 'Roboto' },
        { value: 'Arial, sans-serif', label: 'Arial' },
        { value: 'Verdana, sans-serif', label: 'Verdana' },
        { value: 'Tahoma, sans-serif', label: 'Tahoma' },
        { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet MS' },
        { value: 'Impact, sans-serif', label: 'Impact' },
        { value: 'Georgia, serif', label: 'Georgia' },
        { value: '"Times New Roman", serif', label: 'Times New Roman' },
        { value: '"Courier New", monospace', label: 'Courier New' },
        { value: 'Consolas, monospace', label: 'Consolas' },
    ]

    Layout.FONTS_HREF =
        'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Audiowide&family=Share+Tech+Mono&family=VT323&family=Wallpoet&family=Major+Mono+Display&family=Chakra+Petch:wght@400;700&family=Teko:wght@400;700&family=Bitcount+Grid+Double:wght@100..900&family=Bitcount+Single:wght@100..900&family=Pixelify+Sans:wght@400..700&family=Tourney:ital,wght@0,100..900;1,100..900&display=swap'

    Layout.typeDef = function (type) {
        for (var i = 0; i < Layout.ITEM_TYPES.length; i++) {
            if (Layout.ITEM_TYPES[i].type === type) return Layout.ITEM_TYPES[i]
        }
        return undefined
    }

    Layout.itemLabel = function (type) {
        var def = Layout.typeDef(type)
        return def ? def.label : type
    }

    Layout.itemTitle = function (type) {
        var def = Layout.typeDef(type)
        return def ? def.title : ''
    }

    Layout.itemMinW = function (type) {
        var def = Layout.typeDef(type)
        return def ? def.minW : 20
    }

    Layout.itemMinH = function (type) {
        var def = Layout.typeDef(type)
        return def ? def.minH : 16
    }

    // 'frame' is the rectangular CSS-rendered border box. 'shape' is the
    // editable polygon border, drawn as concentric SVG bands.
    Layout.isFrame = function (type) { return type === 'frame' }
    Layout.isShape = function (type) { return type === 'shape' }
    Layout.isBorder = function (type) { return type === 'frame' || type === 'shape' }

    Layout.defaultShapePoints = function (w, h) {
        return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    }

    Layout.defaultHistoryCols = function () {
        return Layout.HISTORY_COLS.map(function (c) {
            return {
                key: c.key,
                title: c.title,
                visible: true,
                color: Layout.DEFAULT_TEXT_COLOR,
                fontSize: 13,
                bold: false,
            }
        })
    }

    // Out-of-the-box layout: an LCD frame + transcript frame, with the readouts
    // arranged to mirror the main page's LCD. Stable ids so resets are
    // deterministic.
    Layout.defaults = function () {
        function frame(id, x, y, w, h) {
            return {
                id: id, type: 'frame', x: x, y: y, w: w, h: h, color: Layout.DEFAULT_BORDER_COLOR,
                fontSize: 18, fontFamily: '', bold: true, text: '',
                hideOnCall: false, hideOnIdle: false, titleHideOnCall: false, titleHideOnIdle: false,
                titleEnabled: false, titleColor: Layout.DEFAULT_TITLE_COLOR, titleBold: true,
                titleUseLed: false, titleFontSize: 18, titleFontFamily: '', titleText: '',
                useLedColor: false, align: 'left', autoScroll: true, historyCols: [],
                histRowLines: true, histColLines: false, histLineWidth: 1, histLineColor: '#888888',
                borderWidth: 2, innerWidth: 2, cornerRadius: 6, centerFill: false, centerColor: '#000000', centerUseLed: false,
                middleFill: false, middleWidth: 2, middleColor: '#888888', middleUseLed: false,
            }
        }

        function el(type, x, y, w, h) {
            var def = Layout.typeDef(type)
            return {
                id: 'default-' + type, type: type, x: x, y: y, w: w, h: h,
                color: Layout.DEFAULT_TEXT_COLOR,
                fontSize: def ? def.fontSize : 18,
                fontFamily: '',
                bold: true,
                text: '',
                hideOnCall: false,
                hideOnIdle: false,
                titleHideOnCall: false,
                titleHideOnIdle: false,
                titleEnabled: def ? def.titleOn : false,
                titleColor: Layout.DEFAULT_TITLE_COLOR,
                titleBold: true,
                titleUseLed: false,
                titleFontSize: def ? def.fontSize : 18,
                titleFontFamily: '',
                titleText: '',
                useLedColor: false,
                align: 'left',
                autoScroll: true,
                historyCols: [],
                histRowLines: true,
                histColLines: false,
                histLineWidth: 1,
                histLineColor: '#888888',
                borderWidth: 2,
                innerWidth: 2,
                cornerRadius: 6,
                centerFill: false,
                centerColor: '#000000',
                centerUseLed: false,
                middleFill: false,
                middleWidth: 2,
                middleColor: '#888888',
                middleUseLed: false,
            }
        }

        return {
            bgColor: '#000000',
            moveMode: false,
            gridSize: 20,
            showGrid: true,
            items: [
                // Frames first so they render behind the readouts.
                frame('default-lcd-frame', 12, 12, 628, 292),
                frame('default-transcript-frame', 12, 308, 628, 184),
                el('clock', 24, 24, 140, 30),
                el('listeners', 200, 24, 160, 30),
                el('queue', 384, 24, 130, 30),
                el('callProgress', 24, 58, 190, 30),
                el('delay', 384, 58, 160, 26),
                el('system', 24, 96, 280, 30),
                el('tag', 330, 96, 240, 30),
                el('talkgroup', 24, 132, 280, 30),
                el('callDate', 330, 132, 110, 30),
                el('talkgroupName', 24, 170, 600, 44),
                el('tgid', 24, 226, 180, 30),
                el('uid', 300, 226, 320, 30),
                el('tempAvoid', 24, 266, 110, 26),
                el('avoid', 150, 266, 90, 26),
                el('patch', 250, 266, 90, 26),
                el('transcript', 24, 316, 600, 168),
            ],
        }
    }

    root.RdioStreamLayout = Layout
})(window)
