/*
 * Stream overlay — the start gate.
 *
 * A browser will not play audio until the page has been clicked, so an overlay
 * that opened straight into the live feed would show calls and play nothing.
 * OBS captures the audio from this page, so silent is useless. The gate is the
 * click.
 *
 * It doubles as the unlock prompt on a server that requires an access code:
 * without it, an overlay on a restricted server has no way to authenticate and
 * simply never receives anything.
 *
 * Missed on the first pass of this port, and found by screenshotting the
 * built-in overlay next to this one.
 */

;(function (root) {
    'use strict'

    function Gate(canvas, state, app) {
        this.canvas = canvas
        this.state = state
        this.app = app
        this.started = false
    }

    Gate.prototype.attach = function () {
        var self = this

        this.el = document.createElement('div')
        this.el.className = 'rdio-stream-gate'

        this.card = document.createElement('div')
        this.card.className = 'gate-card'
        this.el.appendChild(this.card)

        this.canvas.appendChild(this.el)
        this.render()

        this.state.onChange(function () { self.sync() })

        return this
    }

    Gate.prototype.detach = function () {
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el)
        this.el = null
    }

    // Shown until the feed has been started, and again whenever the server asks
    // for an access code.
    Gate.prototype.visible = function () {
        return !this.started || !!this.state.auth
    }

    Gate.prototype.sync = function () {
        if (!this.el) return

        // A session that expires mid-broadcast asks for the code again. The main
        // page answers that silently from the code it already has, and the
        // built-in overlay inherited that behaviour — so the card almost never
        // appeared. Without it an unattended overlay covers the broadcast with a
        // password form until somebody walks over and types, which is the worst
        // moment for this feature to need a human.
        if (this.state.auth && !this.reauthTried && this.app.readPin) {
            var saved = ''
            try {
                saved = this.app.readPin() || ''
            } catch (err) {
                saved = ''
            }

            if (saved) {
                // Once per prompt: if the saved code is the reason we are being
                // asked, retrying it forever would spin.
                this.reauthTried = true
                try {
                    this.app.authenticate(saved)
                } catch (err) {
                    console.error('[stream] could not re-authenticate', err)
                }
                return
            }
        }

        if (!this.state.auth) this.reauthTried = false

        var wanted = this.visible()
        this.el.style.display = wanted ? '' : 'none'

        // Only rebuild when the reason for being open changed, or typing into
        // the code field would lose a keystroke on every state tick.
        var mode = this.state.auth ? 'auth' : 'start'
        if (wanted && mode !== this.mode) this.render()
    }

    Gate.prototype.render = function () {
        var self = this

        this.mode = this.state.auth ? 'auth' : 'start'
        this.card.textContent = ''

        var title = document.createElement('p')
        title.className = 'gate-title'
        this.card.appendChild(title)

        if (this.mode === 'auth') {
            title.textContent = 'Enter unlock code'

            var form = document.createElement('form')
            form.autocomplete = 'off'

            var input = document.createElement('input')
            input.type = 'password'
            input.autocomplete = 'off'
            input.placeholder = 'Unlock code'

            var submit = document.createElement('button')
            submit.type = 'submit'
            submit.textContent = 'Unlock'

            form.appendChild(input)
            form.appendChild(submit)

            form.addEventListener('submit', function (event) {
                event.preventDefault()
                try {
                    self.app.authenticate(input.value)
                } catch (err) {
                    console.error('[stream] could not authenticate', err)
                }
                input.value = ''
            })

            this.card.appendChild(form)
            input.focus()

        } else {
            title.textContent = 'Stream output'

            var start = document.createElement('button')
            start.type = 'button'
            start.className = 'gate-start'
            start.textContent = '▶ Start Stream'

            start.addEventListener('click', function () { self.start() })

            var hint = document.createElement('p')
            hint.className = 'gate-hint'
            hint.textContent = 'Starts live audio for OBS capture. Control playback from the main page.'

            this.card.appendChild(start)
            this.card.appendChild(hint)
        }

        this.el.style.display = this.visible() ? '' : 'none'
    }

    Gate.prototype.start = function () {
        if (this.state.auth) return

        try {
            this.app.startLivefeed()
        } catch (err) {
            // The gate stays up. Marking it started anyway would hide it over a
            // feed that never began, leaving a silent overlay with nothing on
            // screen to say so or to try again with.
            console.error('[stream] could not start the live feed', err)
            return
        }

        this.started = true
        this.sync()
    }

    root.RdioStreamGate = Gate
})(window)
