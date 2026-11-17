// System Messages — the webapp half.
//
// Two separate things live here, on two different pages:
//
//   the scanner     the strip of messages above the display, and the card that
//                   lists them all;
//   the admin page  the panel under the plugin list where messages and API
//                   keys are managed.
//
// Everything a message carries is put on the page as text, never as markup,
// and its link is only ever given an http or https address.

window.rdioScanner.plugins.register('system-messages', {
    init: function (ctx) {
        'use strict'

        var COMMAND = 'SYM'
        var KINDS = ['system', 'maintenance']
        var KIND_LABEL = { system: 'System', maintenance: 'Maintenance' }
        var KIND_HEADING = { system: 'System messages', maintenance: 'Maintenance' }
        // Each kind has its own five colours, calm to serious; the first is
        // its default.
        var COLORS = {
            system: ['green', 'teal', 'purple', 'yellow', 'pink'],
            maintenance: ['blue', 'amber', 'orange', 'red', 'grey'],
        }
        var DEFAULT_COLOR = { system: 'green', maintenance: 'blue' }
        // What each is for, shown beside the swatches.
        var COLOR_HINT = {
            green: 'All clear, or restored',
            teal: 'Information',
            purple: 'A notice',
            yellow: 'Degraded',
            pink: 'An outage',
            blue: 'Planned',
            amber: 'Starting soon',
            orange: 'Running over',
            red: 'Under way',
            grey: 'Finished, or called off',
        }
        // Every colour there is a shade for. A message stored by version 1.0
        // may be in a colour that has since moved to the other kind, and is
        // still shown in the colour it was given.
        var KNOWN_COLORS = ['blue', 'green', 'teal', 'amber', 'yellow', 'orange', 'red', 'pink', 'purple', 'grey']
        var LIMITS = { title: 80, body: 500, linkUrl: 500, linkLabel: 60, keyLabel: 60 }
        var CLOSED_KEY = 'rdio-system-messages-closed'

        ctx.injectCss(STYLES())

        // -------------------------------------------------------------------
        // Small helpers
        // -------------------------------------------------------------------

        // h('div', {class: 'x', onclick: fn}, [child, 'text'])
        function h(tag, props, children) {
            var el = document.createElement(tag)

            Object.keys(props || {}).forEach(function (name) {
                var value = props[name]
                if (value === null || value === undefined || value === false) return

                if (name === 'class') el.className = value
                else if (name === 'text') el.textContent = value
                else if (name.slice(0, 2) === 'on') el.addEventListener(name.slice(2), value)
                else if (name === 'value') el.value = value
                else el.setAttribute(name, value === true ? '' : value)
            })

            ;[].concat(children || []).forEach(function (child) {
                if (child === null || child === undefined || child === false) return
                el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
            })

            return el
        }

        function clear(el) {
            while (el.firstChild) el.removeChild(el.firstChild)
        }

        function icon(path) {
            var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            svg.setAttribute('viewBox', '0 0 24 24')
            svg.setAttribute('aria-hidden', 'true')
            svg.setAttribute('class', 'sysmsg-icon')
            var p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
            p.setAttribute('d', path)
            svg.appendChild(p)
            return svg
        }

        var ICON_CLOSE = 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z'
        var ICON_INFO = 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z'

        // Only http and https. The server refuses anything else, and this is
        // the same test again, because the page is where it would do harm.
        function safeUrl(value) {
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return ''

            try {
                var url = new URL(value)
                return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
            } catch (err) {
                return ''
            }
        }

        function link(message) {
            var href = safeUrl(message.linkUrl)
            if (!href) return null

            return h('a', {
                class: 'sysmsg-link',
                href: href,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: message.linkLabel || 'More information',
                onclick: function (event) {
                    event.stopPropagation()
                },
            })
        }

        function when(ms) {
            if (typeof ms !== 'number' || !isFinite(ms)) return ''

            try {
                return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
            } catch (err) {
                return new Date(ms).toLocaleString()
            }
        }

        function colorOf(message) {
            return KNOWN_COLORS.indexOf(message.color) >= 0 ? message.color : DEFAULT_COLOR[message.kind] || 'blue'
        }

        // -------------------------------------------------------------------
        // The scanner: what is showing, and what this listener has closed
        // -------------------------------------------------------------------

        var messages = [] // as the server sent them, already in display order
        var strips = [] // every mounted strip container
        var dialog = null // the open card, if any

        // Closed is remembered against a message's revision, so one that has
        // been edited since shows again.
        function token(message) {
            return message.id + ':' + message.revision
        }

        function readClosed() {
            try {
                var list = JSON.parse(window.localStorage.getItem(CLOSED_KEY) || '[]')
                return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string' }) : []
            } catch (err) {
                return []
            }
        }

        var closed = readClosed()

        function writeClosed() {
            // The newest two hundred are plenty; without a bound this would
            // only ever grow.
            closed = closed.slice(-200)

            try {
                window.localStorage.setItem(CLOSED_KEY, JSON.stringify(closed))
            } catch (err) {
                // Private windows and blocked storage: it is remembered until
                // the page is reloaded, which is the best there is.
            }
        }

        function isClosed(message) {
            return closed.indexOf(token(message)) >= 0
        }

        function close(message) {
            if (!isClosed(message)) closed.push(token(message))
            writeClosed()
            render()
        }

        function reopen(message) {
            var t = token(message)
            closed = closed.filter(function (x) { return x !== t })
            writeClosed()
            render()
        }

        function accept(payload) {
            var list = payload && Array.isArray(payload.messages) ? payload.messages : []

            messages = list.filter(function (message) {
                return (
                    message &&
                    typeof message.id === 'number' &&
                    typeof message.title === 'string' &&
                    KINDS.indexOf(message.kind) >= 0
                )
            })

            render()
        }

        function render() {
            strips.forEach(renderStrip)
            if (dialog) dialog.render()
        }

        // One message as a row. `inCard` rows show everything; rows in the
        // strip keep the body short and open the card when pressed.
        function row(message, inCard) {
            var shut = isClosed(message)
            var color = colorOf(message)

            var head = h('div', { class: 'sysmsg-head' }, [
                h('span', { class: 'sysmsg-kind', text: KIND_LABEL[message.kind] }),
                h('span', { class: 'sysmsg-title', text: message.title }),
            ])

            var content = h('div', { class: 'sysmsg-content' }, [
                head,
                message.body ? h('div', { class: 'sysmsg-body', text: message.body }) : null,
                link(message),
            ])

            if (inCard) {
                var times = []
                if (when(message.startsAt)) times.push('Since ' + when(message.startsAt))
                if (when(message.endsAt)) times.push('until ' + when(message.endsAt))
                if (times.length) content.appendChild(h('div', { class: 'sysmsg-times', text: times.join(', ') }))
            }

            var action

            if (inCard && shut) {
                action = h('button', {
                    type: 'button',
                    class: 'sysmsg-text-button',
                    text: 'Show again',
                    onclick: function () { reopen(message) },
                })
            } else {
                action = h(
                    'button',
                    {
                        type: 'button',
                        class: 'sysmsg-close',
                        title: 'Close this message',
                        'aria-label': 'Close this message: ' + message.title,
                        onclick: function (event) {
                            event.stopPropagation()
                            close(message)
                        },
                    },
                    [icon(ICON_CLOSE)]
                )
            }

            var el = h(
                'div',
                { class: 'sysmsg-row sysmsg-c-' + color + (inCard ? ' sysmsg-row-full' : '') + (shut ? ' sysmsg-row-shut' : '') },
                [content, action]
            )

            if (!inCard) {
                el.setAttribute('role', 'button')
                el.setAttribute('tabindex', '0')
                el.setAttribute('title', 'Show all messages')
                el.addEventListener('click', openDialog)
                el.addEventListener('keydown', function (event) {
                    if (event.target !== el) return
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openDialog()
                    }
                })
            }

            return el
        }

        function renderStrip(el) {
            clear(el)

            var open = messages.filter(function (message) { return !isClosed(message) })
            var shutCount = messages.length - open.length

            el.className = 'sysmsg-strip' + (messages.length ? '' : ' sysmsg-empty')

            open.forEach(function (message) {
                el.appendChild(row(message, false))
            })

            // What is left behind once messages are closed, so they can be
            // read again.
            if (shutCount > 0) {
                el.appendChild(
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'sysmsg-chip',
                            onclick: openDialog,
                        },
                        [icon(ICON_INFO), shutCount === 1 ? '1 closed message' : shutCount + ' closed messages']
                    )
                )
            }
        }

        // The card: every message that is showing, the two kinds apart.
        function openDialog() {
            if (dialog) return

            var returnTo = document.activeElement

            var list = h('div', { class: 'sysmsg-card-list' })

            var shut = h(
                'button',
                { type: 'button', class: 'sysmsg-close', title: 'Close', 'aria-label': 'Close', onclick: closeDialog },
                [icon(ICON_CLOSE)]
            )

            var card = h(
                'div',
                { class: 'sysmsg-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Messages' },
                [h('div', { class: 'sysmsg-card-head' }, [h('span', { class: 'sysmsg-card-title', text: 'Messages' }), shut]), list]
            )

            var overlay = h(
                'div',
                {
                    class: 'sysmsg-overlay',
                    onclick: function (event) {
                        if (event.target === overlay) closeDialog()
                    },
                },
                [card]
            )

            function onKey(event) {
                if (event.key === 'Escape') {
                    event.stopPropagation()
                    closeDialog()
                    return
                }

                // Keep Tab inside the card while it is open.
                if (event.key === 'Tab') {
                    var stops = card.querySelectorAll('button, a[href]')
                    if (!stops.length) return

                    var first = stops[0]
                    var last = stops[stops.length - 1]

                    // Focus is outside the card — the button that had it was
                    // redrawn, or the text was clicked. Bring it back in
                    // rather than letting Tab walk the page underneath.
                    if (!card.contains(document.activeElement)) {
                        event.preventDefault()
                        ;(event.shiftKey ? last : first).focus()
                        return
                    }

                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault()
                        last.focus()
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault()
                        first.focus()
                    }
                }
            }

            function closeDialog() {
                document.removeEventListener('keydown', onKey, true)
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
                dialog = null

                // Back to where it was opened from. That row may have been
                // redrawn while the card was open, in which case the first
                // thing in the strip is the nearest there is.
                var target = returnTo && document.contains(returnTo) ? returnTo : null
                if (!target) {
                    for (var i = 0; i < strips.length && !target; i++) {
                        target = strips[i].querySelector('.sysmsg-row, .sysmsg-chip')
                    }
                }
                if (target && typeof target.focus === 'function') target.focus()
            }

            dialog = {
                close: closeDialog,
                render: function () {
                    // Redrawing removes whichever button was pressed, and
                    // focus with it.
                    var hadFocus = list.contains(document.activeElement)

                    clear(list)
                    if (hadFocus) shut.focus()

                    if (!messages.length) {
                        list.appendChild(h('p', { class: 'sysmsg-none', text: 'There are no messages at the moment.' }))
                        return
                    }

                    KINDS.forEach(function (kind) {
                        var ofKind = messages.filter(function (message) { return message.kind === kind })
                        if (!ofKind.length) return

                        list.appendChild(h('h3', { class: 'sysmsg-section', text: KIND_HEADING[kind] }))
                        ofKind.forEach(function (message) {
                            list.appendChild(row(message, true))
                        })
                    })
                },
            }

            dialog.render()
            document.addEventListener('keydown', onKey, true)
            document.body.appendChild(overlay)
            shut.focus()
        }

        ctx.dom.attach(
            '[data-rdio="lcd"]',
            function (el) {
                strips.push(el)
                renderStrip(el)

                return function () {
                    strips = strips.filter(function (x) { return x !== el })
                    if (!strips.length && dialog) dialog.close()
                }
            },
            { position: 'before' }
        )

        ctx.ws.on(COMMAND, accept)

        // The configuration arrives each time the scanner connects, which
        // makes it the moment to ask what is showing: a push only reaches
        // whoever was connected when it was sent.
        ctx.on('config', function () {
            ctx.ws.send(COMMAND, {})
        })

        // -------------------------------------------------------------------
        // The admin page
        // -------------------------------------------------------------------

        // The panel opens from the Settings button on this plugin's own card
        // in the plugin list, which is where anyone looks for it.
        //
        // The server draws that button for the settings form it builds from a
        // manifest, and leaves it disabled for a plugin that declares none —
        // this one, whose settings are a panel of its own. So the button is
        // taken over: enabled, and made to open the panel inside the card.
        var inCard = false
        var dropFallback = null

        ctx.dom.attach('[data-rdio="admin-plugins"] .plugin-card', function (el) {
            var card = el.parentElement
            if (!card || !isOwnCard(card)) {
                el.style.display = 'none'
                return
            }

            // The panel under the list is only for when the card cannot be
            // found. If the list was slow to arrive it is already there, and
            // would otherwise stay as a second copy.
            inCard = true
            if (dropFallback) dropFallback()

            var button = settingsButton(card)
            if (!button) {
                // No button to open it with: show it in the card, open.
                return mountAdmin(el)
            }

            var label = button.querySelector('.mat-button-wrapper') || button
            var close = null

            function toggle(event) {
                // Immediate, because the admin page's own handler is on this
                // same button. Stopping propagation alone only spares it when
                // the click lands on the label inside; pressed with the
                // keyboard, or clicked on its edge, the button is the target
                // and both handlers would run — opening the page's empty
                // settings form as well as this panel.
                event.preventDefault()
                event.stopImmediatePropagation()

                if (close) {
                    close()
                    close = null
                    clear(el)
                    el.className = ''
                    label.textContent = ' Settings '
                } else {
                    close = mountAdmin(el)
                    label.textContent = ' Close settings '
                    el.scrollIntoView({ block: 'nearest' })
                }

                button.setAttribute('aria-expanded', close ? 'true' : 'false')
            }

            button.disabled = false
            button.removeAttribute('disabled')
            button.classList.remove('mat-button-disabled')
            button.setAttribute('aria-expanded', 'false')
            button.addEventListener('click', toggle, true)

            return function () {
                button.removeEventListener('click', toggle, true)
                if (close) close()
            }
        })

        function isOwnCard(card) {
            // Newer servers mark each card with the plugin it belongs to;
            // older ones are told apart by the name on the card.
            var marked = card.getAttribute('data-rdio-plugin-id')
            if (marked) return marked === ctx.plugin.id

            // The same class is used for the cards of plugins on offer from a
            // repository, this one among them. Only an installed plugin's card
            // has the row of Settings, Uninstall and Purge buttons.
            if (!card.querySelector('.plugin-actions')) return false

            var name = card.querySelector('.plugin-name')
            return !!name && name.textContent.trim() === ctx.plugin.name
        }

        function settingsButton(card) {
            var marked = card.querySelector('[data-rdio="plugin-settings"]')
            if (marked) return marked

            var buttons = card.querySelectorAll('.plugin-actions button')
            for (var i = 0; i < buttons.length; i++) {
                if (/^(close settings|settings)$/i.test(buttons[i].textContent.trim())) return buttons[i]
            }
            return null
        }

        // Under the plugin list, where it used to be: only if the card could
        // not be found, so the panel is never out of reach.
        ctx.slots.mount('admin-panel', function (el) {
            var teardown = null

            function drop() {
                if (teardown) teardown()
                teardown = null
                clear(el)
                el.className = ''
            }

            dropFallback = drop

            var timer = window.setTimeout(function () {
                if (!inCard) teardown = mountAdmin(el)
            }, 1500)

            return function () {
                window.clearTimeout(timer)
                if (dropFallback === drop) dropFallback = null
                drop()
            }
        })

        function mountAdmin(root) {
            var all = [] // every stored message, as the API returns them
            var keys = []
            var editing = null // the id being edited, or null for a new one
            var newKey = null // {label, key} just created; shown once
            var confirming = null // 'message:3' or 'key:2' awaiting a yes
            var keyLabel = '' // what has been typed for a new key so far
            var busy = false
            var alive = true

            var form = { kind: 'system', color: null, title: '', body: '', linkUrl: '', linkLabel: '', startsAt: '', endsAt: '' }

            var notice = h('div', { class: 'sysmsg-notice', role: 'status', 'aria-live': 'polite' })
            var formHost = h('div', {})
            var listHost = h('div', {})
            var keysHost = h('div', {})

            root.className = 'sysmsg-admin'
            clear(root)
            root.appendChild(h('h2', { class: 'sysmsg-admin-title', text: 'System Messages' }))
            root.appendChild(
                h('p', {
                    class: 'sysmsg-admin-lede',
                    text: 'Messages shown to everyone listening, above the scanner display. Listeners can close a message; editing it shows it to them again.',
                })
            )
            root.appendChild(notice)
            root.appendChild(formHost)
            root.appendChild(listHost)
            root.appendChild(keysHost)

            function say(text, bad) {
                notice.textContent = text || ''
                notice.className = 'sysmsg-notice' + (text ? (bad ? ' sysmsg-notice-bad' : ' sysmsg-notice-good') : '')
            }

            // Calls the plugin's own routes. A refusal comes back as
            // {error}; see forPage in main.js for why it is not a 4xx.
            function send(method, path, body) {
                var request = method === 'GET' ? ctx.api.get(path) : ctx.api.post(path, body || {})

                return request.then(
                    function (res) {
                        if (res && res.error) throw new Error(res.error)
                        return res
                    },
                    function (err) {
                        if (/HTTP 401/.test(String(err && err.message))) {
                            throw new Error('Your login has expired. Sign in again.')
                        }
                        throw new Error('The server could not be reached, or could not complete the request.')
                    }
                )
            }

            function refresh() {
                return Promise.all([send('GET', 'admin/messages'), send('GET', 'admin/keys')]).then(function (res) {
                    if (!alive) return
                    all = (res[0] && res[0].messages) || []
                    keys = (res[1] && res[1].keys) || []
                    renderList()
                    renderKeys()
                })
            }

            function run(work, done) {
                if (busy) return
                busy = true
                say('')

                work()
                    .then(function (res) {
                        busy = false
                        if (!alive) return
                        if (done) done(res)
                        return refresh()
                    })
                    .then(null, function (err) {
                        busy = false
                        if (alive) say(err.message, true)
                    })
            }

            // datetime-local speaks in local time with no zone; the API is
            // sent the moment itself.
            function toLocalInput(iso) {
                if (!iso) return ''
                var d = new Date(iso)
                if (isNaN(d.getTime())) return ''
                var pad = function (n) { return (n < 10 ? '0' : '') + n }
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
            }

            function fromLocalInput(value) {
                if (!value) return null
                var ms = new Date(value).getTime()
                return isNaN(ms) ? null : ms
            }

            // The colour chosen, if it is one this kind can have; otherwise
            // the kind's default. So switching kind moves the colour with it,
            // and editing an older message in a colour its kind no longer
            // offers starts from the default rather than an impossible choice.
            // The moment a time field stands for: what was typed, or — if the
            // field still shows the time the message already had — that time
            // to the millisecond.
            function timeOf(key) {
                var was = form[key + 'Was']
                if (was && form[key] === toLocalInput(was)) return Date.parse(was)
                return fromLocalInput(form[key])
            }

            function formColor() {
                return COLORS[form.kind].indexOf(form.color) >= 0 ? form.color : DEFAULT_COLOR[form.kind]
            }

            function resetForm() {
                editing = null
                form = { kind: 'system', color: null, title: '', body: '', linkUrl: '', linkLabel: '', startsAt: '', endsAt: '' }
                renderForm()
            }

            function edit(message) {
                editing = message.id
                form = {
                    kind: message.kind,
                    color: message.color,
                    title: message.title,
                    body: message.body || '',
                    linkUrl: message.linkUrl || '',
                    linkLabel: message.linkLabel || '',
                    startsAt: toLocalInput(message.startsAt),
                    endsAt: toLocalInput(message.endsAt),
                    // The form shows minutes. Kept so that a time which was
                    // not touched is sent back exactly, seconds and all.
                    startsAtWas: message.startsAt,
                    endsAtWas: message.endsAt,
                }
                say('')
                renderForm()
                formHost.scrollIntoView({ block: 'nearest' })
            }

            // What is wrong with the form as it stands, or '' — the same rules
            // the server applies, so the button can say so before a round trip.
            function problem() {
                if (!form.title.trim()) return 'Give the message a title.'
                if (form.title.trim().length > LIMITS.title) return 'The title is too long.'
                if (form.body.trim().length > LIMITS.body) return 'The text is too long.'
                if (form.linkUrl.trim() && !safeUrl(form.linkUrl.trim())) return 'The link must begin with http:// or https://.'
                if (form.linkLabel.trim() && !form.linkUrl.trim()) return 'Link text needs a link address.'

                var starts = fromLocalInput(form.startsAt)
                var ends = fromLocalInput(form.endsAt)
                if (starts !== null && ends !== null && ends <= starts) return 'The end must be later than the start.'

                return ''
            }

            function submit(event) {
                event.preventDefault()

                var wrong = problem()
                if (wrong) {
                    say(wrong, true)
                    return
                }

                var body = {
                    kind: form.kind,
                    color: formColor(),
                    title: form.title,
                    body: form.body,
                    linkUrl: form.linkUrl.trim(),
                    linkLabel: form.linkLabel,
                    startsAt: timeOf('startsAt'),
                    endsAt: timeOf('endsAt'),
                }

                var wasEditing = editing

                run(
                    function () {
                        return wasEditing === null
                            ? send('POST', 'admin/messages', body)
                            : send('POST', 'admin/messages/update?id=' + wasEditing, body)
                    },
                    function () {
                        say(wasEditing === null ? 'Posted.' : 'Saved. Listeners who had closed it will see it again.')
                        resetForm()
                    }
                )
            }

            // `focus` names what to put focus back on: choosing a kind or a
            // colour redraws the form, and the button that was pressed with it.
            function renderForm(focus) {
                clear(formHost)

                var preview = h('div', { class: 'sysmsg-preview' })

                function repaint() {
                    clear(preview)
                    preview.appendChild(
                        h('div', { class: 'sysmsg-row sysmsg-c-' + formColor() }, [
                            h('div', { class: 'sysmsg-content' }, [
                                h('div', { class: 'sysmsg-head' }, [
                                    h('span', { class: 'sysmsg-kind', text: KIND_LABEL[form.kind] }),
                                    h('span', { class: 'sysmsg-title', text: form.title.trim() || 'Title' }),
                                ]),
                                form.body.trim() ? h('div', { class: 'sysmsg-body', text: form.body.trim() }) : null,
                                safeUrl(form.linkUrl.trim())
                                    ? h('span', { class: 'sysmsg-link', text: form.linkLabel.trim() || 'More information' })
                                    : null,
                            ]),
                            h('span', { class: 'sysmsg-close', 'aria-hidden': 'true' }, [icon(ICON_CLOSE)]),
                        ])
                    )
                }

                function field(label, control, extra) {
                    return h('label', { class: 'sysmsg-field' }, [h('span', { class: 'sysmsg-label' }, [label, extra || null]), control])
                }

                function counted(key, max, control) {
                    var count = h('span', { class: 'sysmsg-count' })

                    function update() {
                        var n = control.value.trim().length
                        count.textContent = n + ' / ' + max
                        count.className = 'sysmsg-count' + (n > max ? ' sysmsg-count-over' : '')
                    }

                    control.addEventListener('input', function () {
                        form[key] = control.value
                        update()
                        repaint()
                    })

                    update()
                    return count
                }

                function bound(key, control) {
                    control.addEventListener('input', function () {
                        form[key] = control.value
                        repaint()
                    })
                    return control
                }

                var kindButtons = h(
                    'div',
                    { class: 'sysmsg-segments', role: 'radiogroup', 'aria-label': 'Kind' },
                    KINDS.map(function (kind) {
                        return h('button', {
                            type: 'button',
                            role: 'radio',
                            'aria-checked': form.kind === kind ? 'true' : 'false',
                            class: 'sysmsg-segment' + (form.kind === kind ? ' sysmsg-segment-on' : ''),
                            text: KIND_LABEL[kind],
                            onclick: function () {
                                form.kind = kind
                                renderForm('.sysmsg-segment-on')
                            },
                        })
                    })
                )

                var swatches = h(
                    'div',
                    { class: 'sysmsg-swatches', role: 'radiogroup', 'aria-label': 'Colour' },
                    COLORS[form.kind].map(function (color) {
                        var on = formColor() === color
                        return h('button', {
                            type: 'button',
                            role: 'radio',
                            'aria-checked': on ? 'true' : 'false',
                            'aria-label': color + ': ' + COLOR_HINT[color],
                            title: color + ' — ' + COLOR_HINT[color],
                            class: 'sysmsg-swatch sysmsg-c-' + color + (on ? ' sysmsg-swatch-on' : ''),
                            onclick: function () {
                                form.color = color
                                renderForm('.sysmsg-swatch-on')
                            },
                        })
                    })
                )

                var title = h('input', { type: 'text', class: 'sysmsg-input', value: form.title, maxlength: String(LIMITS.title + 40) })
                var body = h('textarea', { class: 'sysmsg-input', rows: '3' })
                body.value = form.body
                var linkUrl = bound('linkUrl', h('input', { type: 'url', class: 'sysmsg-input', value: form.linkUrl, placeholder: 'https://' }))
                var linkLabel = bound('linkLabel', h('input', { type: 'text', class: 'sysmsg-input', value: form.linkLabel, placeholder: 'More information', maxlength: String(LIMITS.linkLabel) }))
                var startsAt = bound('startsAt', h('input', { type: 'datetime-local', class: 'sysmsg-input', value: form.startsAt }))
                var endsAt = bound('endsAt', h('input', { type: 'datetime-local', class: 'sysmsg-input', value: form.endsAt }))

                var el = h('form', { class: 'sysmsg-panel', onsubmit: submit, novalidate: true }, [
                    h('h3', { class: 'sysmsg-panel-title', text: editing === null ? 'New message' : 'Edit message' }),
                    h('div', { class: 'sysmsg-grid' }, [
                        h('div', { class: 'sysmsg-field' }, [h('span', { class: 'sysmsg-label', text: 'Kind' }), kindButtons]),
                        h('div', { class: 'sysmsg-field' }, [
                            h('span', { class: 'sysmsg-label', text: 'Colour' }),
                            swatches,
                            h('span', { class: 'sysmsg-hint', text: COLOR_HINT[formColor()] }),
                        ]),
                    ]),
                    field('Title', title, counted('title', LIMITS.title, title)),
                    field('Text (optional)', body, counted('body', LIMITS.body, body)),
                    h('div', { class: 'sysmsg-grid' }, [field('Link address (optional)', linkUrl), field('Link text', linkLabel)]),
                    h('div', { class: 'sysmsg-grid' }, [
                        field('Starts — empty for now', startsAt),
                        field('Ends — empty for until you end it', endsAt),
                    ]),
                    h('div', { class: 'sysmsg-field' }, [h('span', { class: 'sysmsg-label', text: 'How listeners will see it' }), preview]),
                    h('div', { class: 'sysmsg-actions' }, [
                        h('button', { type: 'submit', class: 'sysmsg-button sysmsg-button-main', text: editing === null ? 'Post message' : 'Save changes' }),
                        editing === null ? null : h('button', { type: 'button', class: 'sysmsg-button', text: 'Cancel', onclick: resetForm }),
                    ]),
                ])

                formHost.appendChild(el)
                repaint()

                if (focus) {
                    var again = el.querySelector(focus)
                    if (again) again.focus()
                }
            }

            // "Delete" becomes "Delete? Yes / No" in place, rather than a
            // browser dialog over the page.
            function confirmable(id, label, verb, act) {
                if (confirming !== id) {
                    return h('button', {
                        type: 'button',
                        class: 'sysmsg-text-button sysmsg-danger',
                        text: label,
                        onclick: function () {
                            confirming = id
                            renderList()
                            renderKeys()
                        },
                    })
                }

                return h('span', { class: 'sysmsg-confirm' }, [
                    h('span', { text: verb + '?' }),
                    h('button', {
                        type: 'button',
                        class: 'sysmsg-text-button sysmsg-danger',
                        text: 'Yes',
                        onclick: function () {
                            confirming = null
                            act()
                        },
                    }),
                    h('button', {
                        type: 'button',
                        class: 'sysmsg-text-button',
                        text: 'No',
                        onclick: function () {
                            confirming = null
                            renderList()
                            renderKeys()
                        },
                    }),
                ])
            }

            var STATE_LABEL = { active: 'Showing', scheduled: 'Scheduled', ended: 'Ended' }

            function renderList() {
                clear(listHost)

                var panel = h('div', { class: 'sysmsg-panel' }, [h('h3', { class: 'sysmsg-panel-title', text: 'Messages' })])

                if (!all.length) {
                    panel.appendChild(h('p', { class: 'sysmsg-none', text: 'No messages yet.' }))
                    listHost.appendChild(panel)
                    return
                }

                // Showing first, then scheduled, then ended.
                var order = { active: 0, scheduled: 1, ended: 2 }
                var sorted = all.slice().sort(function (a, b) {
                    return order[a.state] - order[b.state] || b.id - a.id
                })

                sorted.forEach(function (message) {
                    var times = []
                    if (message.state === 'scheduled') times.push('starts ' + when(Date.parse(message.startsAt)))
                    else times.push('since ' + when(Date.parse(message.startsAt || message.createdAt)))
                    if (message.endsAt) times.push((message.state === 'ended' ? 'ended ' : 'ends ') + when(Date.parse(message.endsAt)))
                    times.push('posted by ' + message.source)

                    panel.appendChild(
                        h('div', { class: 'sysmsg-item sysmsg-c-' + colorOf(message) + (message.state === 'ended' ? ' sysmsg-item-ended' : '') }, [
                            h('div', { class: 'sysmsg-item-main' }, [
                                h('div', { class: 'sysmsg-head' }, [
                                    h('span', { class: 'sysmsg-pill sysmsg-pill-' + message.state, text: STATE_LABEL[message.state] || message.state }),
                                    h('span', { class: 'sysmsg-kind', text: KIND_LABEL[message.kind] || message.kind }),
                                    h('span', { class: 'sysmsg-title', text: message.title }),
                                ]),
                                message.body ? h('div', { class: 'sysmsg-body', text: message.body }) : null,
                                message.linkUrl ? h('div', { class: 'sysmsg-times', text: (message.linkLabel || 'More information') + ' → ' + message.linkUrl }) : null,
                                h('div', { class: 'sysmsg-times', text: times.join(' · ') }),
                            ]),
                            h('div', { class: 'sysmsg-item-actions' }, [
                                h('button', { type: 'button', class: 'sysmsg-text-button', text: 'Edit', onclick: function () { edit(message) } }),
                                message.state === 'ended'
                                    ? null
                                    : h('button', {
                                          type: 'button',
                                          class: 'sysmsg-text-button',
                                          text: 'End now',
                                          onclick: function () {
                                              run(
                                                  function () { return send('POST', 'admin/messages/end?id=' + message.id) },
                                                  function () { say('Ended.') }
                                              )
                                          },
                                      }),
                                confirmable('message:' + message.id, 'Delete', 'Delete', function () {
                                    run(
                                        function () { return send('POST', 'admin/messages/delete?id=' + message.id) },
                                        function () {
                                            if (editing === message.id) resetForm()
                                            say('Deleted.')
                                        }
                                    )
                                }),
                            ]),
                        ])
                    )
                })

                listHost.appendChild(panel)
            }

            function renderKeys() {
                clear(keysHost)

                var base = new URL('api/plugin/system-messages/v1/', document.baseURI).href
                // Redrawn after every action, so what was being typed is kept
                // outside it.
                var label = h('input', { type: 'text', class: 'sysmsg-input', value: keyLabel, placeholder: 'What will use this key', maxlength: String(LIMITS.keyLabel), 'aria-label': 'Key label' })
                label.addEventListener('input', function () {
                    keyLabel = label.value
                })

                var panel = h('div', { class: 'sysmsg-panel' }, [
                    h('h3', { class: 'sysmsg-panel-title', text: 'API keys' }),
                    h('p', { class: 'sysmsg-admin-lede' }, [
                        'Other programs can post and end messages over HTTP with one of these keys. The API is described in ',
                        h('a', { class: 'sysmsg-link', href: base + 'openapi.json', target: '_blank', rel: 'noopener noreferrer', text: 'openapi.json' }),
                        ', and is served at ',
                        h('code', { class: 'sysmsg-code', text: base }),
                        '.',
                    ]),
                ])

                if (newKey) {
                    var copy = h('button', {
                        type: 'button',
                        class: 'sysmsg-button',
                        text: 'Copy',
                        onclick: function () {
                            var done = function () { copy.textContent = 'Copied' }

                            // The clipboard API exists only on https and on
                            // localhost. A scanner reached over plain http on
                            // a local network has neither, so the key is
                            // selected and copied the older way — and if that
                            // fails too it is at least left selected.
                            function byHand() {
                                var ok = false
                                try {
                                    var range = document.createRange()
                                    range.selectNodeContents(keyText)
                                    var selection = window.getSelection()
                                    selection.removeAllRanges()
                                    selection.addRange(range)
                                    ok = document.execCommand('copy')
                                } catch (err) {
                                    ok = false
                                }
                                if (ok) done()
                                else copy.textContent = 'Press Ctrl+C'
                            }

                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(newKey.key).then(done, byHand)
                            } else {
                                byHand()
                            }
                        },
                    })

                    var keyText = h('code', { class: 'sysmsg-code sysmsg-code-key', text: newKey.key })

                    panel.appendChild(
                        h('div', { class: 'sysmsg-newkey' }, [
                            h('div', { class: 'sysmsg-label', text: 'Key for "' + newKey.label + '" — copy it now. It is not stored and cannot be shown again.' }),
                            h('div', { class: 'sysmsg-newkey-row' }, [
                                keyText,
                                copy,
                                h('button', {
                                    type: 'button',
                                    class: 'sysmsg-button',
                                    text: 'Done',
                                    onclick: function () {
                                        newKey = null
                                        renderKeys()
                                    },
                                }),
                            ]),
                        ])
                    )
                }

                keys.forEach(function (key) {
                    panel.appendChild(
                        h('div', { class: 'sysmsg-item sysmsg-c-grey' }, [
                            h('div', { class: 'sysmsg-item-main' }, [
                                h('div', { class: 'sysmsg-head' }, [h('span', { class: 'sysmsg-title', text: key.label })]),
                                h('div', {
                                    class: 'sysmsg-times',
                                    text: 'created ' + when(Date.parse(key.createdAt)) + ' · ' + (key.lastUsedAt ? 'last used ' + when(Date.parse(key.lastUsedAt)) : 'never used'),
                                }),
                            ]),
                            h('div', { class: 'sysmsg-item-actions' }, [
                                confirmable('key:' + key.id, 'Revoke', 'Revoke', function () {
                                    run(
                                        function () { return send('POST', 'admin/keys/delete?id=' + key.id) },
                                        function () { say('Revoked. Anything using that key is now refused.') }
                                    )
                                }),
                            ]),
                        ])
                    )
                })

                panel.appendChild(
                    h(
                        'form',
                        {
                            class: 'sysmsg-keyform',
                            onsubmit: function (event) {
                                event.preventDefault()

                                var text = label.value.trim()
                                if (!text) {
                                    say('Say what will use the key, so you can tell them apart later.', true)
                                    return
                                }

                                run(
                                    function () { return send('POST', 'admin/keys', { label: text }) },
                                    function (res) {
                                        newKey = { label: res.label, key: res.key }
                                        keyLabel = ''
                                        say('Key created.')
                                    }
                                )
                            },
                        },
                        [label, h('button', { type: 'submit', class: 'sysmsg-button', text: 'Create key' })]
                    )
                )

                keysHost.appendChild(panel)
            }

            renderForm()
            renderList()
            renderKeys()

            refresh().then(null, function (err) {
                if (alive) say(err.message, true)
            })

            // A scheduled message starts and a running one ends without
            // anyone pressing anything, so the list is read again now and
            // then while the panel is open.
            var timer = window.setInterval(function () {
                if (busy || confirming || document.hidden) return

                // Reading again redraws the lists, which takes focus from
                // whatever in them has it. Not while someone is in the middle
                // of something here.
                if (listHost.contains(document.activeElement) || keysHost.contains(document.activeElement)) return

                refresh().then(null, function () {})
            }, 30000)

            return function () {
                alive = false
                window.clearInterval(timer)
            }
        }

        // -------------------------------------------------------------------
        // Styles
        // -------------------------------------------------------------------

        function STYLES() {
            var rgb = {
                blue: '56, 132, 255',
                green: '34, 170, 98',
                amber: '245, 170, 35',
                yellow: '240, 208, 40',
                teal: '20, 172, 166',
                pink: '236, 72, 153',
                orange: '234, 98, 20',
                red: '232, 65, 65',
                purple: '157, 106, 245',
                grey: '136, 146, 160',
            }

            var css = Object.keys(rgb)
                .map(function (name) {
                    return '.sysmsg-c-' + name + ' { --sysmsg-rgb: ' + rgb[name] + '; }'
                })
                .join('\n')

            return (
                css +
                '\n' +
                [
                    // The scanner is a column of fixed height in which the display
                    // takes whatever is left. Unbounded, a handful of messages
                    // leaves it nothing, so the strip stops at about a fifth of
                    // the screen and scrolls from there.
                    '.sysmsg-strip { display: flex; flex-direction: column; gap: 6px; margin: -12px 0 12px; font-family: var(--font-sans, inherit);',
                    '  flex: 0 0 auto; max-height: clamp(72px, 18vh, 240px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }',
                    '.sysmsg-strip > * { flex: 0 0 auto; }',
                    '.sysmsg-strip.sysmsg-empty { display: none; }',

                    '.sysmsg-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 8px 8px 12px;',
                    '  background: rgba(var(--sysmsg-rgb), 0.16); border: 1px solid rgba(var(--sysmsg-rgb), 0.45);',
                    '  border-left: 4px solid rgb(var(--sysmsg-rgb)); border-radius: var(--radius-md, 6px);',
                    '  color: var(--text-main, inherit); text-align: left; min-width: 0; }',
                    '.sysmsg-strip .sysmsg-row { cursor: pointer; }',
                    '.sysmsg-strip .sysmsg-row:hover { background: rgba(var(--sysmsg-rgb), 0.24); }',
                    '.sysmsg-row:focus-visible, .sysmsg-close:focus-visible, .sysmsg-chip:focus-visible, .sysmsg-text-button:focus-visible,',
                    '.sysmsg-button:focus-visible, .sysmsg-segment:focus-visible, .sysmsg-swatch:focus-visible, .sysmsg-link:focus-visible {',
                    '  outline: 2px solid var(--accent, #38bdf8); outline-offset: 2px; }',
                    '.sysmsg-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
                    '.sysmsg-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }',
                    '.sysmsg-kind { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;',
                    '  color: rgb(var(--sysmsg-rgb)); filter: saturate(1.2); white-space: nowrap; }',
                    '.sysmsg-title { font-size: 0.9rem; font-weight: 600; color: var(--text-bright, inherit); overflow-wrap: anywhere; min-width: 0; }',
                    '.sysmsg-body { font-size: 0.82rem; line-height: 1.4; color: var(--text-main, inherit); white-space: pre-wrap; overflow-wrap: anywhere; }',
                    '.sysmsg-strip .sysmsg-body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
                    '.sysmsg-link { font-size: 0.82rem; color: var(--accent, #38bdf8); text-decoration: underline; align-self: flex-start; overflow-wrap: anywhere; }',
                    '.sysmsg-times { font-size: 0.74rem; color: var(--text-muted, inherit); opacity: 0.85; overflow-wrap: anywhere; }',
                    '.sysmsg-icon { width: 18px; height: 18px; fill: currentColor; display: block; }',
                    '.sysmsg-close { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;',
                    '  padding: 0; border: 0; border-radius: var(--radius-md, 6px); background: transparent; color: var(--text-muted, inherit); cursor: pointer; }',
                    'button.sysmsg-close:hover { background: rgba(var(--sysmsg-rgb, 136, 146, 160), 0.3); color: var(--text-bright, inherit); }',
                    '.sysmsg-row-shut { opacity: 0.6; }',

                    '.sysmsg-chip { align-self: flex-end; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 6px;',
                    '  border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); border-radius: var(--radius-pill, 999px);',
                    '  background: transparent; color: var(--text-muted, inherit); font: inherit; font-size: 0.74rem; cursor: pointer; }',
                    '.sysmsg-chip:hover { color: var(--text-bright, inherit); border-color: var(--accent, #38bdf8); }',
                    '.sysmsg-chip .sysmsg-icon { width: 15px; height: 15px; }',

                    '.sysmsg-overlay { position: fixed; inset: 0; z-index: var(--z-overlay, 1000); display: flex; align-items: center; justify-content: center;',
                    '  padding: 16px; background: rgba(0, 0, 0, 0.55); font-family: var(--font-sans, inherit); }',
                    '.sysmsg-card { width: 100%; max-width: 520px; max-height: min(640px, 100%); display: flex; flex-direction: column;',
                    '  background: var(--surface-raised, #1e293b); color: var(--text-main, #e2e8f0); border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4));',
                    '  border-radius: var(--radius-lg, 10px); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45); }',
                    '.sysmsg-card-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 12px 16px;',
                    '  border-bottom: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); }',
                    '.sysmsg-card-title { font-size: 1rem; font-weight: 600; color: var(--text-bright, inherit); }',
                    '.sysmsg-card-list { padding: 4px 16px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }',
                    '.sysmsg-section { margin: 12px 0 0; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted, inherit); }',
                    '.sysmsg-row-full .sysmsg-kind { display: none; }',
                    '.sysmsg-none { margin: 12px 0 0; font-size: 0.85rem; color: var(--text-muted, inherit); }',

                    '.sysmsg-text-button { flex: 0 0 auto; padding: 4px 6px; border: 0; background: transparent; color: var(--accent, #38bdf8);',
                    '  font: inherit; font-size: 0.8rem; cursor: pointer; border-radius: var(--radius-md, 6px); white-space: nowrap; }',
                    '.sysmsg-text-button:hover { text-decoration: underline; }',
                    '.sysmsg-danger { color: var(--state-danger, #ef4444); }',

                    '.sysmsg-admin { margin-top: 16px; max-width: 1000px; font-family: var(--font-sans, inherit); color: var(--text-main, inherit); display: flex; flex-direction: column; gap: 12px; }',
                    '.sysmsg-admin-title { margin: 0; font-size: 1.15rem; font-weight: 600; color: var(--text-bright, inherit); }',
                    '.sysmsg-admin-lede { margin: 0; font-size: 0.85rem; line-height: 1.5; color: var(--text-muted, inherit); max-width: 90ch; }',
                    '.sysmsg-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; margin-top: 4px;',
                    '  background: var(--surface-panel, rgba(136, 146, 160, 0.08)); border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); border-radius: var(--radius-lg, 10px); }',
                    '.sysmsg-panel-title { margin: 0; font-size: 0.95rem; font-weight: 600; color: var(--text-bright, inherit); }',
                    '.sysmsg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }',
                    '.sysmsg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }',
                    '.sysmsg-label { display: flex; justify-content: space-between; gap: 8px; font-size: 0.78rem; color: var(--text-muted, inherit); }',
                    '.sysmsg-count { font-variant-numeric: tabular-nums; }',
                    '.sysmsg-count-over { color: var(--state-danger, #ef4444); font-weight: 600; }',
                    '.sysmsg-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit; font-size: 0.88rem; color: var(--text-bright, inherit);',
                    '  background: var(--surface-deep, rgba(0, 0, 0, 0.25)); border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); border-radius: var(--radius-md, 6px); color-scheme: dark light; }',
                    '.sysmsg-input:focus { outline: 2px solid var(--accent, #38bdf8); outline-offset: 0; }',
                    'textarea.sysmsg-input { resize: vertical; min-height: 4.5em; }',
                    '.sysmsg-segments { display: inline-flex; align-self: flex-start; border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); border-radius: var(--radius-md, 6px); overflow: hidden; }',
                    '.sysmsg-segment { padding: 7px 14px; border: 0; background: transparent; color: var(--text-muted, inherit); font: inherit; font-size: 0.85rem; cursor: pointer; }',
                    '.sysmsg-segment-on { background: var(--accent, #38bdf8); color: var(--surface-deep, #0b1120); font-weight: 600; }',
                    '.sysmsg-swatches { display: flex; flex-wrap: wrap; gap: 8px; }',
                    '.sysmsg-swatch { width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 2px solid transparent; background: rgb(var(--sysmsg-rgb)); cursor: pointer; }',
                    '.sysmsg-swatch-on { border-color: var(--text-bright, #fff); box-shadow: 0 0 0 2px rgb(var(--sysmsg-rgb)); }',
                    '.sysmsg-hint { font-size: 0.78rem; color: var(--text-muted, inherit); }',
                    '.sysmsg-preview { max-width: 640px; }',
                    '.sysmsg-actions { display: flex; flex-wrap: wrap; gap: 8px; }',
                    '.sysmsg-button { padding: 8px 14px; font: inherit; font-size: 0.85rem; cursor: pointer; white-space: nowrap; color: var(--text-bright, inherit);',
                    '  background: transparent; border: 1px solid var(--border-subtle, rgba(136, 146, 160, 0.4)); border-radius: var(--radius-md, 6px); }',
                    '.sysmsg-button:hover { border-color: var(--accent, #38bdf8); }',
                    '.sysmsg-button-main { background: var(--accent, #38bdf8); border-color: var(--accent, #38bdf8); color: var(--surface-deep, #0b1120); font-weight: 600; }',
                    '.sysmsg-notice { font-size: 0.85rem; min-height: 0; }',
                    '.sysmsg-notice-good, .sysmsg-notice-bad { padding: 8px 12px; border-radius: var(--radius-md, 6px); }',
                    '.sysmsg-notice-good { background: rgba(34, 170, 98, 0.16); color: var(--state-success-text, #4ade80); }',
                    '.sysmsg-notice-bad { background: rgba(232, 65, 65, 0.16); color: var(--state-danger, #ef4444); }',
                    '.sysmsg-item { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 4px 12px; padding: 10px 0 10px 12px;',
                    '  border-left: 4px solid rgb(var(--sysmsg-rgb)); border-top: 1px solid var(--border-faint, rgba(136, 146, 160, 0.2)); }',
                    '.sysmsg-item-ended { border-left-color: rgba(var(--sysmsg-rgb), 0.35); }',
                    '.sysmsg-item-ended .sysmsg-title, .sysmsg-item-ended .sysmsg-body { opacity: 0.6; }',
                    '.sysmsg-item-main { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
                    '.sysmsg-item-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }',
                    '.sysmsg-confirm { display: inline-flex; align-items: center; gap: 2px; font-size: 0.8rem; color: var(--text-muted, inherit); }',
                    '.sysmsg-pill { padding: 1px 8px; border-radius: var(--radius-pill, 999px); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }',
                    '.sysmsg-pill-active { background: rgba(34, 170, 98, 0.2); color: var(--state-success-text, #4ade80); }',
                    '.sysmsg-pill-scheduled { background: rgba(56, 132, 255, 0.2); color: var(--state-info-text, #60a5fa); }',
                    '.sysmsg-pill-ended { background: rgba(136, 146, 160, 0.2); color: var(--text-muted, inherit); }',
                    '.sysmsg-code { font-family: var(--font-mono, monospace); font-size: 0.8rem; overflow-wrap: anywhere; }',
                    '.sysmsg-newkey { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid rgba(240, 176, 32, 0.6); background: rgba(240, 176, 32, 0.12); border-radius: var(--radius-md, 6px); }',
                    '.sysmsg-newkey-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }',
                    '.sysmsg-code-key { flex: 1 1 260px; padding: 8px 10px; background: var(--surface-deep, rgba(0, 0, 0, 0.25)); border-radius: var(--radius-md, 6px); color: var(--text-bright, inherit); user-select: all; }',
                    '.sysmsg-keyform { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border-faint, rgba(136, 146, 160, 0.2)); }',
                    '.sysmsg-keyform .sysmsg-input { flex: 1 1 220px; width: auto; }',
                    '@media (prefers-reduced-motion: no-preference) { .sysmsg-row, .sysmsg-chip { transition: background-color 0.12s, border-color 0.12s; } }',
                ].join('\n')
            )
        }
    },
})
