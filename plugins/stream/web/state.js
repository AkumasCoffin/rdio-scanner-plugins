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

    function State(app, version) {
        this.app = app

        this.call = undefined
        this.callPrevious = undefined
        this.displayCall = undefined

        this.clock = new Date()
        // Local midnight, not the Unix epoch. callProgress is formatted with
        // local parts, so new Date(0) idles at the timezone offset — "10:00" in
        // UTC+10 — until the first call arrives.
        this.callProgress = new Date(0, 0, 0, 0, 0, 0)
        this.listeners = 0
        this.callQueue = 0

        // Playback position within the current call, and how far the live feed
        // is running behind.
        this.callTime = 0
        this.queueTime = 0
        this.delayRemoved = 0

        // Idle placeholders, matching the LCD. The built-in overlay showed these
        // between calls rather than going blank, and an overlay that empties
        // itself the moment a call ends looks broken on air. The version string
        // comes from the server rather than a bundled package.json, since a
        // plugin is not rebuilt when rdio is.
        this.callSystem = 'System'
        this.callTag = 'Tag'
        this.callTalkgroup = 'Talkgroup'
        this.callTalkgroupName = version ? 'Rdio Scanner v' + version : 'Rdio Scanner'
        this.callTalkgroupId = '0'
        this.callUnit = '0'
        this.callDate = undefined

        // 24-hour unless the server says otherwise, which is what the LCD does.
        this.timeFormat = 'HH:mm'

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
        if (this.jumpTimer) clearTimeout(this.jumpTimer)
        this.listenersFns = []
    }

    State.prototype.apply = function (ev) {
        if (!ev || typeof ev !== 'object') return

        if (ev.config) {
            this.config = ev.config
            this.timeFormat = ev.config.time12hFormat ? 'h:mm a' : 'HH:mm'

            // Only before anything has played. Guarding on `!this.call` alone
            // was also true while idling on the last call, so a config push
            // replaced that call's talkgroup name with the version string and
            // left its system and tag beside it — a display half from one call
            // and half from nowhere.
            if (ev.config.version && !this.displayCall) {
                this.callTalkgroupName = 'Rdio Scanner v' + ev.config.version
            }
        }

        // The server sends its version separately from the config payload.
        if (ev.version && !this.displayCall) {
            this.callTalkgroupName = 'Rdio Scanner v' + ev.version
        }

        if (typeof ev.auth === 'boolean') this.auth = ev.auth
        if (typeof ev.listeners === 'number') this.listeners = ev.listeners
        if (typeof ev.queue === 'number') this.callQueue = ev.queue

        // How far into the current call playback has reached, in seconds. This
        // is the position; getCallDuration is the total.
        if (typeof ev.time === 'number') this.callTime = ev.time

        // Seconds the live feed is running behind.
        if (typeof ev.queueTime === 'number') this.queueTime = ev.queueTime

        // An auto-jump just shed some delay. The event is queueJumped — reading
        // a field named delayRemoved, which nothing emits, meant the "-m:ss"
        // flash the LCD shows could never appear at all.
        if (typeof ev.queueJumped === 'number' && ev.queueJumped > 0) {
            this.delayRemoved += ev.queueJumped
            this.flashJump()
        }

        if ('call' in ev) {
            var previous = this.call

            this.call = ev.call || undefined

            // The call that just finished becomes the one still on screen.
            // Covers a call ending as well as one replacing another — without
            // the ending case the overlay went blank the moment playback
            // stopped, which is exactly what it must not do on air.
            if (previous && (!this.call || previous.id !== this.call.id)) {
                this.callPrevious = previous

                // History holds the calls *before* the current one, once each.
                // The service emits the same call several times as it decodes
                // and starts playing it, so pushing on every emit filled the
                // table with duplicates of a single call.
                this.pushHistory(previous)
            }

            // A new call resets the position; its first `time` may not have
            // arrived yet.
            if (this.call && (!previous || previous.id !== this.call.id)) {
                this.callTime = 0
            }
        }

        this.updateDisplay()

        // A transcript can arrive after the call it belongs to, which is the
        // whole point of the transcripts plugin being asynchronous. Patch it in
        // rather than waiting for the next call to redraw.
        if (ev.transcriptReady && this.displayCall &&
            Number(this.displayCall.id) === Number(ev.transcriptReady.id)) {
            this.displayCall.transcript = ev.transcriptReady.transcript
        }

        this.changed()
    }

    // Mirrors the main component's updateDisplay: everything derived from the
    // current call plus the current playback position.
    //
    // The LCD keeps showing the last call once one ends, so an overlay does not
    // blank between transmissions.
    State.prototype.updateDisplay = function () {
        var call = this.call
        this.displayCall = call || this.callPrevious

        if (!call) return

        var system = call.systemData || {}
        var talkgroup = call.talkgroupData || {}

        // Not an elapsed duration: the moment within the call that is playing,
        // as a wall-clock time. That is why the LCD formats it the same way as
        // the clock, and why it is built in local time rather than UTC.
        this.callProgress = new Date(call.dateTime)
        this.callProgress.setSeconds(this.callProgress.getSeconds() + (this.callTime || 0))

        // The date is shown only for a call more than a day old, so a live feed
        // is not cluttered with today's date on every transmission.
        this.callDate = (Date.now() - this.callProgress.getTime() >= 86400000)
            ? new Date(call.dateTime)
            : undefined

        this.callSystem = system.label || String(call.system)
        this.callTag = talkgroup.tag || ''
        this.callTalkgroup = talkgroup.label || String(call.talkgroup)
        this.callTalkgroupName = talkgroup.name || this.formatFrequency(call.frequency)
        this.callTalkgroupId = String(call.talkgroup)

        // Follows the conversation, using the position rather than the total.
        this.callUnit = this.unitFor(call, this.callTime || 0)
    }

    // Clears the shed-delay figure after a few seconds, so it reads as a flash
    // beside the delay rather than a number that sticks around looking current.
    State.prototype.flashJump = function () {
        var self = this

        if (this.jumpTimer) clearTimeout(this.jumpTimer)

        this.jumpTimer = setTimeout(function () {
            self.jumpTimer = undefined
            self.delayRemoved = 0
            self.changed()
        }, 4000)
    }

    // "m:ss", or "h:mm:ss" past an hour. Empty at or below zero, so the readout
    // shows nothing rather than a meaningless 0:00 when there is no delay.
    State.prototype.formatDelay = function (seconds) {
        var total = Math.round(seconds || 0)
        if (total <= 0) return ''

        function pad(n) { return n < 10 ? '0' + n : String(n) }

        var hours = Math.floor(total / 3600)
        var minutes = Math.floor((total % 3600) / 60)
        var secs = total % 60

        return hours > 0
            ? hours + ':' + pad(minutes) + ':' + pad(secs)
            : minutes + ':' + pad(secs)
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

    // Per-tick work: the avoid and patch flags, which the service owns.
    //
    // Position is not computed here — it arrives as `time` on the event stream
    // and is applied in updateDisplay. Deriving it from getCallDuration was
    // wrong: that returns the call's decoded length, a constant, so the timer
    // sat at the finish from the first frame, the unit readout jumped straight
    // to whoever keyed up last, and the transcript scrolled instantly to the
    // bottom because position over total was always one.
    State.prototype.tick = function () {
        var call = this.call || this.callPrevious
        if (!call) return

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
        if (!call) return

        // Deduped by id. The service emits the same call more than once as it
        // decodes and then starts playing it, so without this one call filled
        // several rows and the table held two or three distinct calls.
        for (var i = 0; i < this.callHistory.length; i++) {
            if (this.callHistory[i] && this.callHistory[i].id === call.id) return
        }

        this.callHistory.unshift(call)
        if (this.callHistory.length > 6) this.callHistory.pop()
    }

    State.prototype.formatFrequency = function (frequency) {
        if (typeof frequency !== 'number') return ''
        return (frequency / 1e6).toFixed(6) + ' MHz'
    }

    root.RdioStreamState = State
})(window)
