/*
 * Tests for shapable-border geometry.
 *
 * The corner rounding is the part worth testing: it clamps the cut-back to half
 * of each adjoining edge so a tight corner cannot eat the edge next to it, and
 * it skips rounding on a straight run. Both are the kind of thing that looks
 * fine on a rectangle and falls apart on the first bent edge someone draws.
 *
 * Run: node shapes.test.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function load() {
    const win = {
        console,
        localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        // shapes.js only touches document inside paint(), which these tests do
        // not reach — the geometry is what matters and it is pure.
        document: {},
    }
    win.window = win

    const context = vm.createContext(win)

    for (const file of ['layout.js', 'store.js', 'render.js', 'shapes.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file })
    }

    return win
}

// Values built inside the vm carry that realm's prototypes, so deepStrictEqual
// rejects them against host-realm literals even when the contents match.
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

const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]

console.log('rounded path')

test('a polygon needs at least three points', () => {
    const { RdioStreamShapes: S } = load()

    assert.strictEqual(S.roundedPath([], 5), '')
    assert.strictEqual(S.roundedPath([{ x: 0, y: 0 }], 5), '')
    assert.strictEqual(S.roundedPath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 5), '')
})

test('a path is closed', () => {
    const { RdioStreamShapes: S } = load()

    const d = S.roundedPath(square, 0)
    assert.ok(d.startsWith('M '), 'must start with a move')
    assert.ok(d.trim().endsWith('Z'), 'must be closed, or the stroke leaves a gap at the start')
})

test('a zero radius produces no arcs', () => {
    const { RdioStreamShapes: S } = load()

    const d = S.roundedPath(square, 0)
    assert.ok(!/[A]/.test(d), `expected no arc commands: ${d}`)
})

test('a radius produces one arc per corner', () => {
    const { RdioStreamShapes: S } = load()

    const d = S.roundedPath(square, 10)
    const arcs = (d.match(/ A /g) || []).length
    assert.strictEqual(arcs, 4, `a square has four corners, got ${arcs}: ${d}`)
})

test('a corner cannot eat more than half an edge', () => {
    const { RdioStreamShapes: S } = load()

    // A radius far larger than the shape. Unclamped, the cut-back would run
    // past the next corner and the path would fold over itself.
    const d = S.roundedPath(square, 10000)

    const coords = d.match(/-?\d+\.\d+/g).map(Number)
    coords.forEach((n) => {
        assert.ok(n >= -0.01 && n <= 100.01, `coordinate ${n} escaped the 100x100 shape`)
    })
})

test('a straight run is not rounded', () => {
    const { RdioStreamShapes: S } = load()

    // A collinear midpoint along the top edge. Rounding it would put an arc in
    // the middle of a flat edge, and emitting a zero-length segment there makes
    // a round line-join draw a stray disc.
    const withMidpoint = [
        { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 },
        { x: 100, y: 100 }, { x: 0, y: 100 },
    ]

    const arcs = (S.roundedPath(withMidpoint, 10).match(/ A /g) || []).length
    assert.strictEqual(arcs, 4, `only the four real corners should round, got ${arcs}`)
})

test('a reflex corner still rounds, and inward', () => {
    const { RdioStreamShapes: S } = load()

    // An L shape: one corner turns the other way. Offsetting a polygon spikes
    // here, which is why the bands are stroked and clipped instead.
    const ell = [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
        { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 },
    ]

    const d = S.roundedPath(ell, 8)
    const arcs = (d.match(/ A /g) || []).length
    assert.strictEqual(arcs, 6, `every corner of the L should round, got ${arcs}`)

    // Sweep flags differ: a reflex corner curves the opposite way, and getting
    // that wrong produces a corner that bulges outward instead of cutting in.
    const sweeps = new Set((d.match(/ 0 0 ([01]) /g) || []).map((s) => s.trim().split(' ').pop()))
    assert.strictEqual(sweeps.size, 2, 'an L has corners turning both ways')
})

console.log('bands')

test('bands are widest first so narrower ones paint over them', () => {
    const win = load()
    const store = new win.RdioStreamStore()
    const renderer = new win.RdioStreamRenderer(null, store, { call: undefined, displayCall: undefined })
    const shapes = new win.RdioStreamShapes(null, store, renderer)

    const item = {
        id: 's', type: 'shape', x: 0, y: 0, w: 100, h: 100,
        points: square, dividers: [],
        color: '#ff0000', useLedColor: false, cornerRadius: 0,
        borderWidth: 4,
        middleFill: true, middleWidth: 3, middleColor: '#00ff00', middleUseLed: false,
        centerFill: true, innerWidth: 2, centerColor: '#0000ff', centerUseLed: false,
        hideOnCall: false, hideOnIdle: false,
    }

    const render = shapes.build(item)

    assert.strictEqual(render.bands.length, 3)
    // Each stroke is centred on the outline and clipped to the interior, so a
    // band `n` wide is stroked at 2n.
    assert.deepStrictEqual(plain(render.bands.map((b) => b.width)), [18, 10, 4])
    assert.deepStrictEqual(plain(render.bands.map((b) => b.color)), ['#ff0000', '#00ff00', '#0000ff'])

    for (let i = 1; i < render.bands.length; i++) {
        assert.ok(render.bands[i].width < render.bands[i - 1].width,
            'a later band must be narrower, or it would hide the one before it')
    }
})

test('a border with no width draws nothing', () => {
    const win = load()
    const store = new win.RdioStreamStore()
    const renderer = new win.RdioStreamRenderer(null, store, { call: undefined, displayCall: undefined })
    const shapes = new win.RdioStreamShapes(null, store, renderer)

    const render = shapes.build({
        id: 's', type: 'shape', x: 0, y: 0, w: 100, h: 100,
        points: square, dividers: [], color: '#fff', useLedColor: false, cornerRadius: 0,
        borderWidth: 0, middleFill: false, middleWidth: 3, centerFill: false, innerWidth: 2,
        hideOnCall: false, hideOnIdle: false,
    })

    assert.strictEqual(render, null)
})

test('a divider gradient mirrors around its centre', () => {
    const win = load()
    const store = new win.RdioStreamStore()
    const renderer = new win.RdioStreamRenderer(null, store, { call: undefined, displayCall: undefined })
    const shapes = new win.RdioStreamShapes(null, store, renderer)

    const render = shapes.build({
        id: 's', type: 'shape', x: 0, y: 0, w: 100, h: 100,
        points: square, dividers: [{ axis: 'v', pos: 0.5 }],
        color: '#ff0000', useLedColor: false, cornerRadius: 0, borderWidth: 4,
        middleFill: true, middleWidth: 3, middleColor: '#00ff00', middleUseLed: false,
        centerFill: true, innerWidth: 2, centerColor: '#0000ff', centerUseLed: false,
        hideOnCall: false, hideOnIdle: false,
    })

    assert.strictEqual(render.dividers.length, 1)

    // inner, middle, outer, middle, inner — so the line meets the bands on both
    // sides as a blend rather than as two hard edges that do not line up.
    const colors = plain(render.dividers[0].stops.map((s) => s.color))
    assert.deepStrictEqual(colors, ['#0000ff', '#00ff00', '#ff0000', '#00ff00', '#0000ff'])

    const offsets = plain(render.dividers[0].stops.map((s) => s.off))
    assert.deepStrictEqual(offsets, [0, 0.25, 0.5, 0.75, 1])

    // The line is the full thickness of the border.
    assert.strictEqual(render.dividers[0].width, 9)
})

test('a hidden shape is not drawn', () => {
    const win = load()
    const store = new win.RdioStreamStore()

    // hideOnIdle, with nothing playing.
    const renderer = new win.RdioStreamRenderer(null, store, { call: undefined, displayCall: undefined })
    const shapes = new win.RdioStreamShapes(null, store, renderer)

    const item = {
        id: 's', type: 'shape', x: 0, y: 0, w: 100, h: 100, points: square, dividers: [],
        color: '#fff', useLedColor: false, cornerRadius: 0, borderWidth: 4,
        middleFill: false, centerFill: false, middleWidth: 0, innerWidth: 0,
        hideOnCall: false, hideOnIdle: true,
    }

    assert.strictEqual(renderer.dataVisible(item), false,
        'a shape follows the same visibility rules as every other item')
})

console.log('')
if (failures) {
    console.log(`${failures} failing`)
    process.exit(1)
}
console.log('all passing')
