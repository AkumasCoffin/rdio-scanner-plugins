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
    }
})
