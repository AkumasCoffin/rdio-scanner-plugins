/*
 * Tests for the marquee cycle.
 *
 * A marquee that never pauses is unreadable at both ends, which is the reason
 * for the pause-out-pause-back shape rather than a continuous slide. The timing
 * is easy to get subtly wrong and impossible to notice in a screenshot.
 *
 * Run: node scroll.test.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function load() {
    const win = { console }
    win.window = win
    const context = vm.createContext(win)

    for (const file of ['layout.js', 'scroll.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file })
    }

    return win
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

console.log('marquee')

test('it starts held at the beginning', () => {
    const { RdioStreamScroller: S } = load()

    // Held still first, so the start of a value can be read before it moves.
    assert.strictEqual(S.marqueePos(0, 100), 0)
    assert.strictEqual(S.marqueePos(S.PAUSE_MS - 1, 100), 0)
})

test('it travels the full distance and no further', () => {
    const { RdioStreamScroller: S } = load()

    const max = 90
    const travel = (max / S.PX_PER_SEC) * 1000

    assert.strictEqual(S.marqueePos(S.PAUSE_MS, max), 0)
    assert.ok(Math.abs(S.marqueePos(S.PAUSE_MS + travel / 2, max) - max / 2) < 0.001,
        'halfway through the travel it should be halfway along')

    // Every sample across a whole cycle must stay within the scrollable range;
    // overshooting would snap the text back with a visible jolt.
    const cycle = (travel + S.PAUSE_MS) * 2
    for (let t = 0; t < cycle; t += 17) {
        const pos = S.marqueePos(t, max)
        assert.ok(pos >= -0.001 && pos <= max + 0.001, `position ${pos} outside 0..${max} at ${t}ms`)
    }
})

test('it holds at the far end before coming back', () => {
    const { RdioStreamScroller: S } = load()

    const max = 90
    const travel = (max / S.PX_PER_SEC) * 1000

    // The end of a long value is the part most worth reading, so it waits there
    // as long as it waited at the start.
    assert.ok(Math.abs(S.marqueePos(S.PAUSE_MS + travel + 10, max) - max) < 0.001)
    assert.ok(Math.abs(S.marqueePos(S.PAUSE_MS * 2 + travel - 10, max) - max) < 0.001)
})

test('it returns to the beginning and repeats', () => {
    const { RdioStreamScroller: S } = load()

    const max = 90
    const travel = (max / S.PX_PER_SEC) * 1000
    const cycle = (travel + S.PAUSE_MS) * 2

    // Back at the start by the end of the cycle, and the next cycle matches the
    // first — driven by the clock, so a dropped frame cannot leave it behind.
    assert.ok(S.marqueePos(cycle - 1, max) < 1)
    assert.ok(Math.abs(S.marqueePos(cycle + 500, max) - S.marqueePos(500, max)) < 0.001)
})

test('the travel time scales with the distance', () => {
    const { RdioStreamScroller: S } = load()

    // A fixed speed rather than a fixed duration: a long value should take
    // longer to cross, not move faster to keep up.
    const short = S.marqueePos(S.PAUSE_MS + 500, 45)
    const long = S.marqueePos(S.PAUSE_MS + 500, 450)

    assert.ok(Math.abs(short - 22.5) < 0.001, `expected ~22.5px after 500ms, got ${short}`)
    assert.ok(Math.abs(long - 22.5) < 0.001, `the same speed regardless of distance, got ${long}`)
})

console.log('')
if (failures) {
    console.log(`${failures} failing`)
    process.exit(1)
}
console.log('all passing')
