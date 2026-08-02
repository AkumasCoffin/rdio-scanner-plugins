/*
 * Tests for reporting the overlay's current call back to the main page.
 *
 * This is the half of follower mode that is invisible until it is missing: the
 * main page stops running its own feed while the overlay is open, so if nothing
 * is mirrored its LCD simply stays blank and looks like the overlay broke the
 * scanner. It is also the path that would happily copy every call's audio
 * between windows if the buffer were left on.
 *
 * Run: node mirror.test.js
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

    vm.runInContext(fs.readFileSync(path.join(__dirname, 'mirror.js'), 'utf8'), context, { filename: 'mirror.js' })

    return win.RdioStreamMirror
}

const Mirror = load()

// Objects built inside the vm realm have that realm's Object prototype, which
// deepStrictEqual counts as a difference. Compare by value.
function sameShape(actual, expected, message) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message)
}

// A fake of the scanner service: an event stream the overlay subscribes to, and
// a record of everything mirrored back to the main page.
function fakeApp(options) {
    const opts = options || {}
    const sent = []
    let handler

    return {
        sent,
        emit(ev) { if (handler) handler(ev) },
        unsubscribed: false,
        event: opts.noEvent ? undefined : {
            subscribe(fn) {
                handler = fn
                const self = this
                return { unsubscribe() { self.owner.unsubscribed = true } }
            },
        },
        broadcastFollowerDisplay: opts.noBroadcast ? undefined : function (payload) {
            if (opts.throws) throw new Error('channel closed')
            sent.push(payload)
        },
    }
}

// --- what gets forwarded ----------------------------------------------------

{
    const payload = Mirror.displayPayload({
        call: { id: 7, talkgroup: 100 },
        time: 3.5,
        queue: 2,
        queueTime: 12,
        queueJumped: 4,
        transcriptReady: { id: 7, transcript: 'hello' },
    })

    sameShape(payload, {
        call: { id: 7, talkgroup: 100 },
        time: 3.5,
        queue: 2,
        queueTime: 12,
        queueJumped: 4,
        transcriptReady: { id: 7, transcript: 'hello' },
    }, 'every field the main LCD renders must be forwarded')
}

// An event with nothing displayable must not produce a message. Events arrive
// constantly; posting one per event would be a message storm for no benefit.
{
    assert.strictEqual(Mirror.displayPayload({ auth: true }), null)
    assert.strictEqual(Mirror.displayPayload({ listeners: 4 }), null)
    assert.strictEqual(Mirror.displayPayload({}), null)
    assert.strictEqual(Mirror.displayPayload(null), null)
    assert.strictEqual(Mirror.displayPayload('nope'), null)
}

// Clearing the call is news — it is how the main LCD goes back to idle. A
// truthiness check here would leave the last call on screen forever.
{
    const payload = Mirror.displayPayload({ call: undefined })
    assert.notStrictEqual(payload, null, 'a cleared call must still be forwarded')
    assert.ok('call' in payload)
    assert.strictEqual(payload.call, undefined)
}

// Zero is a real value for every one of these. A falsy test would drop the
// moment a call starts (time 0) and the moment the queue drains (queue 0).
{
    const payload = Mirror.displayPayload({ time: 0, queue: 0, queueTime: 0, queueJumped: 0 })
    sameShape(payload, { time: 0, queue: 0, queueTime: 0, queueJumped: 0 })
}

// --- audio ------------------------------------------------------------------

{
    const audio = [1, 2, 3]
    const call = { id: 9, talkgroup: 1, audio, audioName: 'x.m4a' }
    const payload = Mirror.displayPayload({ call })

    assert.strictEqual(payload.call.audio, undefined, 'audio must not cross the channel')
    assert.strictEqual(payload.call.audioName, 'x.m4a', 'the rest of the call must survive')
    assert.strictEqual(payload.call.id, 9)

    // The original must not be touched: the overlay is still playing this call.
    assert.strictEqual(call.audio, audio, 'stripping must not mutate the call being played')
}

// A call with no audio is passed straight through rather than copied.
{
    const call = { id: 4 }
    assert.strictEqual(Mirror.stripAudio(call), call)
    assert.strictEqual(Mirror.stripAudio(undefined), undefined)
}

// --- subscription lifecycle -------------------------------------------------

{
    const app = fakeApp()
    app.event.owner = app

    const mirror = new Mirror(app).start()

    app.emit({ call: { id: 1, audio: [1, 2] } })
    app.emit({ auth: true })
    app.emit({ time: 2 })

    assert.strictEqual(app.sent.length, 2, 'only displayable events are forwarded')
    assert.strictEqual(app.sent[0].call.audio, undefined)
    sameShape(app.sent[1], { time: 2 })

    mirror.stop()
    assert.strictEqual(app.unsubscribed, true, 'leaving the overlay must unsubscribe')
}

// An older webapp has no broadcastFollowerDisplay. The overlay must still run —
// it simply does not mirror, which is how it behaved before this existed.
{
    const app = fakeApp({ noBroadcast: true })
    app.event.owner = app

    const mirror = new Mirror(app).start()
    app.emit({ call: { id: 1 } })

    assert.strictEqual(app.sent.length, 0)
    mirror.stop()
}

{
    const mirror = new Mirror(undefined).start()
    mirror.stop()
}

// A failing channel must not take the overlay's event subscription down with
// it — the overlay keeps rendering even when the main page cannot be reached.
{
    const app = fakeApp({ throws: true })
    app.event.owner = app

    const mirror = new Mirror(app).start()
    const errors = []
    const realError = console.error
    console.error = (...args) => errors.push(args)

    try {
        app.emit({ call: { id: 1 } })
        app.emit({ time: 1 })
    } finally {
        console.error = realError
    }

    assert.strictEqual(errors.length, 2, 'a broken channel is reported, not swallowed')
    mirror.stop()
}

console.log('mirror.test.js: all assertions passed')
