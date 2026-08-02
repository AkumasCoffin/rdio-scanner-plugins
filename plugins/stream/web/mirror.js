/*
 * Stream overlay — reporting back to the main scanner page.
 *
 * Follower mode is two-way. The main page sends playback controls and live-feed
 * state down to the overlay, and the service applies those on its own. This is
 * the other direction: the overlay says what it is currently showing, so the
 * main page's LCD renders the same call.
 *
 * It matters because follower mode deliberately stops the main page running a
 * feed of its own — two feeds would play two sets of calls out of two windows.
 * Its display therefore has nothing of its own to show, and without this the
 * main page is a set of controls over a blank screen.
 *
 * Ported from the mirror block in stream.component.ts.
 */

;(function (root) {
    'use strict'

    // The fields the main page's LCD renders. Anything else on the event is the
    // overlay's own business and is not sent.
    var NUMBER_FIELDS = ['time', 'queue', 'queueTime', 'queueJumped']

    // Build the payload for one event, or null when the event carries nothing
    // the main page displays — an event with no display fields is not news, and
    // sending it would post a message per heartbeat for nothing.
    function displayPayload(ev) {
        if (!ev || typeof ev !== 'object') return null

        var out = {}
        var has = false

        if ('call' in ev) {
            out.call = stripAudio(ev.call)
            has = true
        }

        for (var i = 0; i < NUMBER_FIELDS.length; i++) {
            var key = NUMBER_FIELDS[i]
            if (typeof ev[key] === 'number') {
                out[key] = ev[key]
                has = true
            }
        }

        if (ev.transcriptReady) {
            out.transcriptReady = ev.transcriptReady
            has = true
        }

        return has ? out : null
    }

    // The main page draws the call, it never plays it. A BroadcastChannel
    // message is structured-cloned, so leaving the buffer on would copy every
    // call's audio between windows to be thrown away at the other end.
    function stripAudio(call) {
        if (!call || !call.audio) return call

        var copy = {}
        for (var k in call) if (Object.prototype.hasOwnProperty.call(call, k)) copy[k] = call[k]
        copy.audio = undefined
        return copy
    }

    function Mirror(app) {
        this.app = app
        this.subscription = undefined
    }

    Mirror.prototype.start = function () {
        var self = this
        var app = this.app

        // An older webapp has no such method. The overlay still works; the main
        // page just will not mirror, which is what it did before this existed.
        if (!app || !app.broadcastFollowerDisplay || !app.event || !app.event.subscribe) {
            return this
        }

        this.subscription = app.event.subscribe(function (ev) {
            var payload = displayPayload(ev)
            if (!payload) return

            try {
                app.broadcastFollowerDisplay(payload)
            } catch (err) {
                console.error('[stream] could not mirror the current call to the main page', err)
            }
        })

        return this
    }

    Mirror.prototype.stop = function () {
        try {
            if (this.subscription && this.subscription.unsubscribe) this.subscription.unsubscribe()
        } catch (err) {
            // Best effort — the page is going away regardless.
        }
        this.subscription = undefined
    }

    Mirror.displayPayload = displayPayload
    Mirror.stripAudio = stripAudio

    root.RdioStreamMirror = Mirror
})(window)
