// Hello World — frontend half of the reference plugin.
//
// Mounts a small counter under the LCD, kept up to date by the HLO websocket
// command the backend half emits.

window.rdioScanner.plugins.register('hello-world', {
    init: function (ctx) {
        var label = 'Calls seen'
        var enabled = false
        var counts = {}
        var current = null
        var render = null

        ctx.injectCss(
            '.hello-world-counter {' +
            '  font-family: inherit;' +
            '  font-size: 0.75rem;' +
            '  opacity: 0.7;' +
            '  padding: 0.25rem 0.5rem;' +
            '  text-align: center;' +
            '}' +
            '.hello-world-badge {' +
            '  font-size: 0.65rem;' +
            '  opacity: 0.45;' +
            '  padding-left: 0.4rem;' +
            '}' +
            '.hello-world-view {' +
            '  font-family: inherit;' +
            '  padding: 1rem;' +
            '}' +
            '.hello-world-view table {' +
            '  border-collapse: collapse;' +
            '  width: 100%;' +
            '}' +
            '.hello-world-view td {' +
            '  border-bottom: 1px solid rgba(127,127,127,0.2);' +
            '  padding: 0.35rem 0.5rem;' +
            '}'
        )

        function key(system, talkgroup) {
            return system + ':' + talkgroup
        }

        function paint() {
            if (!render) return
            if (!enabled || !current) {
                render.textContent = ''
                return
            }
            var count = counts[key(current.system, current.talkgroup)]
            render.textContent = count === undefined ? '' : label + ': ' + count
        }

        ctx.on('config', function (config) {
            enabled = !!config.helloWorldEnabled
            if (config.helloWorldLabel) label = config.helloWorldLabel
            paint()
        })

        ctx.on('call', function (call) {
            current = call
            paint()

            // Ask for the count if we have not seen this talkgroup yet this session.
            if (enabled && counts[key(call.system, call.talkgroup)] === undefined) {
                ctx.ws.send('HLO', { system: call.system, talkgroup: call.talkgroup })
            }
        })

        ctx.ws.on('HLO', function (payload) {
            counts[key(payload.system, payload.talkgroup)] = payload.count
            paint()
        })

        ctx.slots.mount('lcd-below', function (el) {
            el.className = 'hello-world-counter'
            render = el
            paint()
        })

        // Arbitrary placement: a badge on every call history row, including
        // rows that appear later. Slots are convenience anchors, not a
        // boundary — this shows reaching anywhere on the page with the
        // lifecycle handled for you.
        ctx.dom.attach('[data-rdio="history-row"] td:last-child', function (el) {
            var row = el.closest('[data-rdio-call]')
            var id = row && row.getAttribute('data-rdio-call')
            if (!id) return

            el.className = 'hello-world-badge'
            el.textContent = '#' + id
        })

        // A whole screen of its own, with an entry in the navigation. This is
        // the shape anything substantial takes — a map, a dashboard, a feed
        // from another service.
        ctx.views.register({
            id: 'counts',
            label: 'Call counts',
            icon: 'leaderboard',
            mount: function (el) {
                el.className = 'hello-world-view'
                el.textContent = 'Loading…'

                var cancelled = false

                ctx.api.get('counts').then(function (res) {
                    if (cancelled) return

                    el.textContent = ''

                    var rows = (res && res.counts) || []
                    if (!rows.length) {
                        el.textContent = 'No calls counted yet.'
                        return
                    }

                    var table = document.createElement('table')
                    rows.forEach(function (entry) {
                        var tr = document.createElement('tr')
                        tr.innerHTML =
                            '<td>' + entry.system + '</td>' +
                            '<td>' + entry.talkgroup + '</td>' +
                            '<td>' + entry.count + '</td>'
                        table.appendChild(tr)
                    })
                    el.appendChild(table)
                }).catch(function () {
                    if (!cancelled) el.textContent = 'Could not load counts.'
                })

                // Returned teardown runs when the view is left or the plugin
                // is disabled.
                return function () { cancelled = true }
            }
        })
    }
})
