/*
 * Tests for the parts of rendering that decide *what* is shown, as opposed to
 * how it looks. Those rules came from the built-in overlay and have to agree
 * with the LCD: an overlay that disagreed about when a flag is lit would be
 * worse than one that never showed it.
 *
 * Run: node render.test.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function load() {
    const win = {
        console,
        localStorage: {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
        },
    }
    win.window = win

    const context = vm.createContext(win)

    for (const file of ['layout.js', 'store.js', 'state.js', 'render.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file })
    }

    return win
}

// A renderer with no DOM: the constructor touches nothing, and every rule under
// test is a pure function of state and item.
function rendererWith(win, state) {
    const store = { getLayout: () => win.RdioStreamLayout.defaults() }
    return new win.RdioStreamRenderer(null, store, state)
}

function item(overrides) {
    const base = {
        type: 'clock', hideOnCall: false, hideOnIdle: false,
        titleHideOnCall: false, titleHideOnIdle: false,
        titleEnabled: true, titleText: '', titleColor: '#fff', titleUseLed: false,
        color: '#fff', useLedColor: false, text: '',
    }
    return Object.assign(base, overrides)
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

console.log('formatting')

test('the call timer is built from UTC, not local time', () => {
    const win = load()
    const { RdioStreamRenderer: R } = win

    // Hours and minutes, matching the LCD — no seconds. Built from UTC parts
    // because this is an elapsed duration: reading local hours off one shows
    // the timezone offset instead of zero, which is what the built-in overlay
    // does and is correct only where local time happens to be UTC.
    assert.strictEqual(R.formatDuration(new Date(65 * 1000)), '00:01')
    assert.strictEqual(R.formatDuration(new Date(0)), '00:00')
    assert.strictEqual(R.formatDuration(new Date(3661 * 1000)), '01:01')
})

test('an invalid date renders as empty rather than NaN', () => {
    const { RdioStreamRenderer: R } = load()

    assert.strictEqual(R.formatTime(new Date('nonsense'), 'HH:mm'), '')
    assert.strictEqual(R.formatDate(new Date('nonsense')), '')
    assert.strictEqual(R.formatDuration(new Date('nonsense')), '00:00')
})

test('dates and times are zero padded', () => {
    const { RdioStreamRenderer: R } = load()

    assert.strictEqual(R.formatDate(new Date(2026, 0, 5)), '01/05')
    assert.strictEqual(R.formatTime(new Date(2026, 0, 5, 9, 8, 7), 'HH:mm'), '09:08')

    // 12-hour, when the server is configured that way.
    assert.strictEqual(R.formatTime(new Date(2026, 0, 5, 9, 8), 'h:mm a'), '9:08 AM')
    assert.strictEqual(R.formatTime(new Date(2026, 0, 5, 13, 8), 'h:mm a'), '1:08 PM')
    assert.strictEqual(R.formatTime(new Date(2026, 0, 5, 0, 8), 'h:mm a'), '12:08 AM')
    assert.strictEqual(R.formatTime(new Date(2026, 0, 5, 12, 8), 'h:mm a'), '12:08 PM')
})

console.log('visibility')

test('hide-on-call and hide-on-idle are independent', () => {
    const win = load()

    const playing = rendererWith(win, { call: { id: 1 } })
    const idle = rendererWith(win, { call: undefined })

    const hideOnCall = item({ hideOnCall: true })
    assert.strictEqual(playing.dataVisible(hideOnCall), false, 'hidden while a call plays')
    assert.strictEqual(idle.dataVisible(hideOnCall), true, 'shown when idle')

    const hideOnIdle = item({ hideOnIdle: true })
    assert.strictEqual(playing.dataVisible(hideOnIdle), true)
    assert.strictEqual(idle.dataVisible(hideOnIdle), false)

    // Both off means always shown — the default for every item.
    assert.strictEqual(playing.dataVisible(item({})), true)
    assert.strictEqual(idle.dataVisible(item({})), true)
})

test('a title can be hidden independently of its value', () => {
    const win = load()
    const playing = rendererWith(win, { call: { id: 1 } })

    const it = item({ titleHideOnCall: true })
    assert.strictEqual(playing.titleVisible(it), false)
    assert.strictEqual(playing.dataVisible(it), true, 'the value must not follow the title')
})

test('a title is not left standing alone with nothing after it', () => {
    const win = load()

    const withUnit = rendererWith(win, { callUnit: 'MEDIC 1', tempAvoid: 0 })
    const without = rendererWith(win, { callUnit: '', tempAvoid: 0 })

    assert.strictEqual(withUnit.hasContent(item({ type: 'uid' })), true)
    assert.strictEqual(without.hasContent(item({ type: 'uid' })), false)

    const avoiding = rendererWith(win, { tempAvoid: 5 })
    assert.strictEqual(avoiding.hasContent(item({ type: 'tempAvoid' })), true)
    assert.strictEqual(without.hasContent(item({ type: 'tempAvoid' })), false)

    // Everything else always has something to show.
    assert.strictEqual(without.hasContent(item({ type: 'clock' })), true)
})

console.log('colour')

test('an item follows the talkgroup LED only when asked', () => {
    const win = load()
    const r = rendererWith(win, {
        displayCall: { talkgroupData: { led: '#00ff00' } },
    })

    assert.strictEqual(r.colorOf(item({ color: '#ff0000', useLedColor: false })), '#ff0000')
    assert.strictEqual(r.colorOf(item({ color: '#ff0000', useLedColor: true })), '#00ff00')
    assert.strictEqual(r.titleColorOf(item({ titleColor: '#0000ff', titleUseLed: true })), '#00ff00')
})

test('an item set to follow the LED falls back to its own colour when there is none', () => {
    const win = load()
    const r = rendererWith(win, { displayCall: undefined })

    // Between calls, or on a talkgroup with no LED configured. Falling through
    // to undefined would render the text invisible against the background.
    assert.strictEqual(r.colorOf(item({ color: '#ff0000', useLedColor: true })), '#ff0000')
})

console.log('values')

test('each readout renders the field it names', () => {
    const win = load()
    const r = rendererWith(win, {
        clock: new Date(2026, 0, 2, 3, 4, 5),
        timeFormat: 'HH:mm',
        callProgress: new Date(12 * 1000),
        listeners: 7,
        callQueue: 3,
        callSystem: 'Countywide',
        callTag: 'Fire',
        callTalkgroup: 'Dispatch',
        callTalkgroupName: 'Fire Dispatch',
        callTalkgroupId: '1201',
        callUnit: 'ENGINE 41',
        callDate: new Date(2026, 7, 2),
        tempAvoid: 0,
        avoided: false,
        patched: false,
    })

    assert.strictEqual(r.valueOf(item({ type: 'clock' })), '03:04')
    assert.strictEqual(r.valueOf(item({ type: 'callProgress' })), '00:00')
    assert.strictEqual(r.valueOf(item({ type: 'listeners' })), '7')
    assert.strictEqual(r.valueOf(item({ type: 'queue' })), '3')
    assert.strictEqual(r.valueOf(item({ type: 'system' })), 'Countywide')
    assert.strictEqual(r.valueOf(item({ type: 'tag' })), 'Fire')
    assert.strictEqual(r.valueOf(item({ type: 'talkgroup' })), 'Dispatch')
    assert.strictEqual(r.valueOf(item({ type: 'talkgroupName' })), 'Fire Dispatch')
    assert.strictEqual(r.valueOf(item({ type: 'tgid' })), '1201')
    assert.strictEqual(r.valueOf(item({ type: 'uid' })), 'ENGINE 41')
    assert.strictEqual(r.valueOf(item({ type: 'callDate' })), '08/02')
    assert.strictEqual(r.valueOf(item({ type: 'text', text: 'ON AIR' })), 'ON AIR')
})

test('the avoid and patch flags light independently', () => {
    const win = load()

    // The LCD treats these as separate conditions, not alternatives; a
    // talkgroup can be both avoided and patched at once.
    const both = rendererWith(win, { avoided: true, patched: true })
    assert.strictEqual(both.valueOf(item({ type: 'avoid' })), 'AVOID')
    assert.strictEqual(both.valueOf(item({ type: 'patch' })), 'PATCH')

    const neither = rendererWith(win, { avoided: false, patched: false })
    assert.strictEqual(neither.valueOf(item({ type: 'avoid' })), '')
    assert.strictEqual(neither.valueOf(item({ type: 'patch' })), '')
})

test('the avoid timer shows only while one is running', () => {
    const win = load()

    assert.strictEqual(rendererWith(win, { tempAvoid: 0 }).valueOf(item({ type: 'tempAvoid' })), '')
    assert.ok(/5M/.test(rendererWith(win, { tempAvoid: 5 }).valueOf(item({ type: 'tempAvoid' }))))
})

test('a title falls back to the type default, and a custom one wins', () => {
    const win = load()
    const r = rendererWith(win, {})

    assert.strictEqual(r.titleTextOf(item({ type: 'tgid', titleText: '' })), 'TGID')
    assert.strictEqual(r.titleTextOf(item({ type: 'tgid', titleText: 'Talkgroup ID' })), 'Talkgroup ID')
})

console.log('history')

test('history cells read the same fields the table names', () => {
    const win = load()
    const r = rendererWith(win, { timeFormat: 'HH:mm' })

    const call = {
        dateTime: new Date(2026, 0, 2, 3, 4, 5).toISOString(),
        system: 1,
        talkgroup: 1201,
        systemData: { label: 'Countywide' },
        talkgroupData: { label: 'Dispatch', name: 'Fire Dispatch' },
    }

    assert.strictEqual(r.historyCell(call, 'system'), 'Countywide')
    assert.strictEqual(r.historyCell(call, 'talkgroup'), 'Dispatch')
    assert.strictEqual(r.historyCell(call, 'name'), 'Fire Dispatch')
    assert.ok(/^\d{2}:\d{2}$/.test(r.historyCell(call, 'time')), 'history times match the LCD format')
})

test('history falls back to ids when a call has no metadata', () => {
    const win = load()
    const r = rendererWith(win, {})

    const bare = { system: 9, talkgroup: 42 }
    assert.strictEqual(r.historyCell(bare, 'system'), '9')
    assert.strictEqual(r.historyCell(bare, 'talkgroup'), '42')
    assert.strictEqual(r.historyCell(bare, 'name'), '')
})

console.log('state')

test('the last call stays on screen once it ends', () => {
    const win = load()
    const state = new win.RdioStreamState({ event: { subscribe: () => ({}) } })

    state.apply({ call: { id: 1, system: 1, talkgroup: 2, systemData: { label: 'A' }, talkgroupData: { label: 'B' } } })
    assert.strictEqual(state.callSystem, 'A')

    // Between transmissions the LCD keeps the last call rather than blanking,
    // and an overlay that went empty between calls would look broken on air.
    state.apply({ call: undefined })
    assert.ok(state.displayCall, 'the previous call must remain as the display call')
    assert.strictEqual(state.callSystem, 'A')
})

test('a transcript arriving late is patched into the call on screen', () => {
    const win = load()
    const state = new win.RdioStreamState({ event: { subscribe: () => ({}) } })

    state.apply({ call: { id: 7, system: 1, talkgroup: 2 } })
    state.apply({ transcriptReady: { id: 7, transcript: 'engine 41 responding' } })

    assert.strictEqual(state.displayCall.transcript, 'engine 41 responding')

    // A transcript for some other call must not overwrite it.
    state.apply({ transcriptReady: { id: 999, transcript: 'not this one' } })
    assert.strictEqual(state.displayCall.transcript, 'engine 41 responding')
})

test('the unit readout follows the conversation', () => {
    const win = load()
    const state = new win.RdioStreamState({ event: { subscribe: () => ({}) } })

    const call = {
        id: 1, system: 1, talkgroup: 2,
        sources: [{ src: 100, pos: 0 }, { src: 200, pos: 5 }],
        systemData: { units: [{ id: 100, label: 'ENGINE 41' }, { id: 200, label: 'MEDIC 7' }] },
    }

    assert.strictEqual(state.unitFor(call, 0), 'ENGINE 41')
    assert.strictEqual(state.unitFor(call, 4.9), 'ENGINE 41')
    assert.strictEqual(state.unitFor(call, 5), 'MEDIC 7', 'the readout must move on at the timestamp')
    assert.strictEqual(state.unitFor(call, 30), 'MEDIC 7')
})

test('an unknown unit id shows the id rather than nothing', () => {
    const win = load()
    const state = new win.RdioStreamState({ event: { subscribe: () => ({}) } })

    const call = { sources: [{ src: 555, pos: 0 }], systemData: { units: [] } }
    assert.strictEqual(state.unitFor(call, 0), '555')
})

test('history keeps the most recent calls, newest first', () => {
    const win = load()
    const state = new win.RdioStreamState({ event: { subscribe: () => ({}) } })

    for (let i = 1; i <= 9; i++) {
        state.apply({ call: { id: i, system: 1, talkgroup: 2 } })
    }

    assert.strictEqual(state.callHistory.length, 6, 'the table is bounded')
    assert.strictEqual(state.callHistory[0].id, 9, 'newest first')
})

console.log('')
if (failures) {
    console.log(`${failures} failing`)
    process.exit(1)
}
console.log('all passing')
