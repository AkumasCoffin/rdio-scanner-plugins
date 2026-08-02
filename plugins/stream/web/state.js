/*
 * Stream overlay — display state.
 *
 * The built-in overlay got this by extending RdioScannerMainComponent, which
 * meant inheriting 749 lines for the dozen values it actually renders — auth,
 * presets, the keypad, search, none of which an overlay has any use for.
 *
 * A plugin renders plain DOM rather than an Angular template, so it needs the
 * data, not the bindings. This derives exactly the fields the overlay draws,
 * from the service and its event stream, using the same rules the main
 * component uses so a readout says the same thing on both screens.
 */

;(function (root) {
    'use strict'

    function State(app) {
        this.app = app

        this.call = undefined
        this.callPrevious = undefined
        this.displayCall = undefined

        this.clock = new Date()
        this.callProgress = new Date(0)
        this.listeners = 0
        this.callQueue = 0

        this.callSystem = ''
        this.callTag = ''
        this.callTalkgroup = ''
        this.callTalkgroupName = ''
        this.callTalkgroupId = ''
        this.callUnit = ''
        this.callDate = undefined

        this.tempAvoid = 0
        this.avoided = false
        this.patched = false

        this.callHistory = []

        this.listenersFns = []
    }

    State.prototype.onChange = function (fn) {
        this.listenersFns.push(fn)
        return this
    }

    State.prototype.changed = function () {
        for (var i = 0; i < this.listenersFns.length; i++) {
            try {
                this.listenersFns[i](this)
            } catch (err) {
                console.error('[stream] state listener failed', err)
            }
        }
    }

    State.prototype.start = function () {
        var self = this

        this.subscription = this.app.event.subscribe(function (ev) { self.apply(ev) })

        // The clock and the call timer are the only things that move on their
        // own; everything else changes because an event arrived.
        this.timer = setInterval(function () {
            self.clock = new Date()
            self.tick()
            self.changed()
        }, 500)

        return this
    }

    State.prototype.stop = function () {
        try {
            if (this.subscription && this.subscription.unsubscribe) this.subscription.unsubscribe()
        } catch (err) {
            // Best effort.
        }
        if (this.timer) clearInterval(this.timer)
        this.listenersFns = []
    }

    State.prototype.apply = function (ev) {
        if (!ev || typeof ev !== 'object') return

        if (ev.config) this.config = ev.config
        if (typeof ev.listeners === 'number') this.listeners = ev.listeners
        if (typeof ev.queue === 'number') this.callQueue = ev.queue

        if ('call' in ev) {
            if (this.call) this.callPrevious = this.call
            this.call = ev.call || undefined

            if (this.call) {
                this.pushHistory(this.call)
                this.derive()
            }
        }

        // A transcript can arrive after the call it belongs to, which is the
        // whole point of the transcripts plugin being asynchronous. Patch it in
        // rather than waiting for the next call to redraw.
        if (ev.transcriptReady && this.displayCall &&
            Number(this.displayCall.id) === Number(ev.transcriptReady.id)) {
            this.displayCall.transcript = ev.transcriptReady.transcript
        }

        this.changed()
    }

    // Mirrors the main component: the LCD keeps showing the last call once one
    // ends, so an overlay does not blank between transmissions.
    State.prototype.derive = function () {
        var call = this.call
        this.displayCall = call || this.callPrevious

        if (!call) return

        var system = call.systemData || {}
        var talkgroup = call.talkgroupData || {}

        this.callSystem = system.label || String(call.system)
        this.callTag = talkgroup.tag || ''
        this.callTalkgroup = talkgroup.label || String(call.talkgroup)
        this.callTalkgroupName = talkgroup.name || this.formatFrequency(call.frequency)
        this.callTalkgroupId = String(call.talkgroup)
        this.callDate = call.dateTime ? new Date(call.dateTime) : undefined

        this.callUnit = this.unitFor(call, 0)

        this.callProgress = new Date(0)
    }

    // The unit talking at `time` seconds in. Sources are timestamped, so the
    // readout follows the conversation rather than showing only whoever keyed up
    // first.
    State.prototype.unitFor = function (call, time) {
        var units = (call.systemData && call.systemData.units) || []

        function label(id) {
            for (var i = 0; i < units.length; i++) {
                if (units[i].id === id) return units[i].label
            }
            return id === undefined || id === null ? '' : String(id)
        }

        if (Array.isArray(call.sources) && call.sources.length) {
            var source = {}
            for (var i = 0; i < call.sources.length; i++) {
                if ((call.sources[i].pos || 0) <= time) source = call.sources[i]
            }
            if (typeof source.src === 'number') return label(source.src)
            return typeof call.source === 'number' ? String(call.source) : ''
        }

        return label(call.source)
    }

    // Per-tick work: the call timer, the moving unit readout, and the avoid and
    // patch flags, which the service owns.
    State.prototype.tick = function () {
        var call = this.call || this.callPrevious
        if (!call) return

        if (this.call) {
            var elapsed = this.app.getCallDuration ? this.app.getCallDuration(this.call.id) : undefined
            if (typeof elapsed === 'number') {
                this.callProgress = new Date(elapsed * 1000)
            }
            this.callUnit = this.unitFor(this.call, this.callProgress.getTime() / 1000)
        }

        try {
            this.tempAvoid = this.app.isAvoidedTimer(call) || 0
            // Separate flags, not mutually exclusive — the LCD lights each on
            // its own merits and the overlay must match.
            this.avoided = !!this.app.isAvoided(call)
            this.patched = !!this.app.isPatched(call)
        } catch (err) {
            // The service is authoritative; if it cannot answer, show nothing
            // rather than a stale flag.
            this.tempAvoid = 0
            this.avoided = false
            this.patched = false
        }
    }

    State.prototype.pushHistory = function (call) {
        this.callHistory.unshift(call)
        if (this.callHistory.length > 6) this.callHistory.pop()
    }

    State.prototype.formatFrequency = function (frequency) {
        if (typeof frequency !== 'number') return ''
        return (frequency / 1e6).toFixed(6) + ' MHz'
    }

    root.RdioStreamState = State
})(window)
