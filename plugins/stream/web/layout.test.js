/*
 * Compatibility tests for the layout model and store.
 *
 * These exist because export/import is the only backup users have for a stream
 * layout. A field renamed or a default changed while porting would not fail
 * loudly — it would make files people already hold stop importing, and they
 * would find out the next time they needed one.
 *
 * Run: node layout.test.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// A browser just real enough for the two files under test.
function makeWindow() {
    const store = new Map()

    const win = {
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        console,
    }

    win.window = win
    return win
}

function load() {
    const win = makeWindow()
    const context = vm.createContext(win)

    for (const file of ['layout.js', 'store.js']) {
        const code = fs.readFileSync(path.join(__dirname, file), 'utf8')
        vm.runInContext(code, context, { filename: file })
    }

    return win
}

// Values built inside the vm context carry that realm's prototypes, so
// deepStrictEqual rejects them against host-realm literals even when the
// contents are identical. Round-tripping through JSON brings them home.
function plain(value) {
    return JSON.parse(JSON.stringify(value))
}

let failures = 0

function test(name, fn) {
    try {
        fn()
        console.log(`  ok   ${name}`)
    } catch (err) {
        failures++
        console.log(`  FAIL ${name}`)
        console.log(`       ${err.message}`)
    }
}

console.log('layout model')

test('the default layout is the one the built-in overlay shipped', () => {
    const { RdioStreamLayout: L } = load()
    const layout = L.defaults()

    assert.strictEqual(layout.bgColor, '#000000', 'background must stay black for chroma keying')
    assert.strictEqual(layout.gridSize, 20)
    assert.strictEqual(layout.showGrid, true)
    assert.strictEqual(layout.moveMode, false)
    assert.strictEqual(layout.items.length, 18, 'default item count changed')

    // Stable ids are what make a reset deterministic.
    assert.ok(layout.items.some((i) => i.id === 'default-lcd-frame'))
    assert.ok(layout.items.some((i) => i.id === 'default-transcript-frame'))
    assert.ok(layout.items.some((i) => i.id === 'default-transcript'))

    // Frames first, so they render behind the readouts.
    assert.strictEqual(layout.items[0].type, 'frame')
    assert.strictEqual(layout.items[1].type, 'frame')
})

test('every item type the built-in overlay offered still exists', () => {
    const { RdioStreamLayout: L } = load()

    const expected = [
        'text', 'clock', 'callProgress', 'listeners', 'queue', 'delay', 'system',
        'tag', 'talkgroup', 'callDate', 'talkgroupName', 'tgid', 'uid',
        'tempAvoid', 'avoid', 'patch', 'transcript', 'history', 'frame', 'shape',
    ]

    const actual = plain(L.ITEM_TYPES.map((t) => t.type))
    assert.deepStrictEqual(actual, expected, 'item types must match, in order')
})

console.log('store')

test('an exported layout round-trips unchanged', () => {
    const { RdioStreamStore } = load()

    const a = new RdioStreamStore()
    const exported = a.exportLayout()

    const b = new RdioStreamStore()
    const result = b.importLayout(exported)

    assert.strictEqual(result.success, true, result.error)
    assert.deepStrictEqual(
        JSON.parse(b.exportLayout()),
        JSON.parse(exported),
        'a layout exported and re-imported must be identical',
    )
})

test('a layout with the old frameLink type still loads', () => {
    const { RdioStreamStore } = load()
    const store = new RdioStreamStore()

    // frameLink was renamed to shape. Files exported before that still exist.
    const result = store.importLayout(JSON.stringify({
        bgColor: '#010203',
        items: [{ id: 'old', type: 'frameLink', x: 10, y: 20, w: 100, h: 50 }],
    }))

    assert.strictEqual(result.success, true, result.error)

    const items = store.getLayout().items
    assert.strictEqual(items.length, 1)
    assert.strictEqual(items[0].type, 'shape', 'frameLink must migrate to shape')
    assert.strictEqual(items[0].id, 'old', 'the id must be kept')
    assert.ok(Array.isArray(items[0].points) && items[0].points.length >= 3,
        'a shape needs points, defaulted from its box')
    assert.strictEqual(store.getLayout().bgColor, '#010203')
})

test('unknown item types are dropped rather than breaking the layout', () => {
    const { RdioStreamStore } = load()
    const store = new RdioStreamStore()

    store.importLayout(JSON.stringify({
        items: [
            { id: 'a', type: 'clock', x: 1, y: 2 },
            { id: 'b', type: 'something-from-the-future' },
            { id: 'c', type: 'transcript', x: 3, y: 4 },
        ],
    }))

    const types = plain(store.getLayout().items.map((i) => i.type))
    assert.deepStrictEqual(types, ['clock', 'transcript'])
})

test('a partial item is filled in from its type defaults', () => {
    const { RdioStreamStore, RdioStreamLayout: L } = load()
    const store = new RdioStreamStore()

    store.importLayout(JSON.stringify({ items: [{ type: 'tgid' }] }))

    const item = store.getLayout().items[0]
    const def = L.typeDef('tgid')

    assert.strictEqual(item.w, def.w)
    assert.strictEqual(item.h, def.h)
    assert.strictEqual(item.fontSize, def.fontSize)
    assert.strictEqual(item.titleEnabled, def.titleOn)
    assert.strictEqual(item.color, L.DEFAULT_TEXT_COLOR)
    assert.strictEqual(item.align, 'left')
    assert.ok(item.id, 'a missing id must be generated, not left empty')
})

test('history columns keep their order and merge saved settings', () => {
    const { RdioStreamStore } = load()
    const store = new RdioStreamStore()

    store.importLayout(JSON.stringify({
        items: [{
            type: 'history',
            historyCols: [{ key: 'talkgroup', title: 'TG', visible: false, fontSize: 20 }],
        }],
    }))

    const cols = store.getLayout().items[0].historyCols
    assert.deepStrictEqual(plain(cols.map((c) => c.key)), ['time', 'system', 'talkgroup', 'name'],
        'column order is fixed by the model, not by the file')

    const tg = cols.find((c) => c.key === 'talkgroup')
    assert.strictEqual(tg.title, 'TG')
    assert.strictEqual(tg.visible, false)
    assert.strictEqual(tg.fontSize, 20)

    // Untouched columns keep their defaults.
    assert.strictEqual(cols.find((c) => c.key === 'time').visible, true)
})

test('shape dividers are clamped into range', () => {
    const { RdioStreamStore } = load()
    const store = new RdioStreamStore()

    store.importLayout(JSON.stringify({
        items: [{
            type: 'shape',
            dividers: [
                { axis: 'h', pos: 0.5 },
                { axis: 'v', pos: 5 },
                { axis: 'v', pos: -2 },
                { axis: 'x', pos: 0.5 },
                { axis: 'h' },
            ],
        }],
    }))

    assert.deepStrictEqual(plain(store.getLayout().items[0].dividers), [
        { axis: 'h', pos: 0.5 },
        { axis: 'v', pos: 1 },
        { axis: 'v', pos: 0 },
    ])
})

test('rubbish falls back to defaults instead of throwing', () => {
    const { RdioStreamStore, RdioStreamLayout: L } = load()
    const store = new RdioStreamStore()

    assert.strictEqual(store.importLayout('not json').success, false)
    assert.strictEqual(store.importLayout('"a string"').success, false)

    store.importLayout(JSON.stringify({ items: 'not an array' }))
    assert.strictEqual(store.getLayout().items.length, L.defaults().items.length)
})

test('a stored layout is picked up on construction', () => {
    const win = load()
    const store = new win.RdioStreamStore()

    store.update({ bgColor: '#123456' })

    // Same origin, same key — this is why the port needs no migration.
    const raw = win.localStorage.getItem(win.RdioStreamLayout.STORAGE_KEY)
    assert.ok(raw, 'the layout must be written to the same key the built-in overlay used')
    assert.strictEqual(JSON.parse(raw).bgColor, '#123456')

    const reopened = new win.RdioStreamStore()
    assert.strictEqual(reopened.getLayout().bgColor, '#123456')
})

test('a failed save is reported rather than swallowed', () => {
    const win = load()

    win.localStorage.setItem = () => { throw new Error('QuotaExceededError') }

    const store = new win.RdioStreamStore()
    const errors = []
    const original = console.error
    console.error = (...args) => errors.push(args.join(' '))

    try {
        store.update({ bgColor: '#abcdef' })
    } finally {
        console.error = original
    }

    assert.strictEqual(store.saved, false, 'a failed write must be visible on the store')
    assert.ok(errors.some((e) => /could not save/i.test(e)),
        'a failed write must say so — silently losing a layout is how "reload resets it" happens')
})

console.log('')
if (failures) {
    console.log(`${failures} failing`)
    process.exit(1)
}
console.log('all passing')
