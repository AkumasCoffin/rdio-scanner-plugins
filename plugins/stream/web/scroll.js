/*
 * Stream overlay — auto-scroll.
 *
 * Three different behaviours share one animation loop:
 *
 *   the transcript scrolls in time with the call, so what is on screen matches
 *     what is being said rather than racing ahead of it
 *   custom text marquees vertically, because it wraps
 *   every other value marquees horizontally, because it does not
 *
 * Reads are done first and writes collected and applied afterwards. Interleaving
 * them makes the browser recompute layout between each pair, which on a canvas
 * of twenty items is the difference between a frame and a stutter — and this
 * runs every frame for as long as the broadcast does.
 */

;(function (root) {
    'use strict'

    var L = root.RdioStreamLayout

    var PX_PER_SEC = 45
    var PAUSE_MS = 1500

    function Scroller(canvas, state, app) {
        this.canvas = canvas
        this.state = state
        this.app = app
        this.raf = undefined
    }

    Scroller.prototype.start = function () {
        var self = this

        function tick() {
            self.frame()
            self.raf = requestAnimationFrame(tick)
        }

        this.raf = requestAnimationFrame(tick)
        return this
    }

    Scroller.prototype.stop = function () {
        if (this.raf !== undefined) cancelAnimationFrame(this.raf)
        this.raf = undefined
    }

    Scroller.prototype.frame = function () {
        var now = performance.now()
        var writes = []
        var self = this

        var nodes = this.canvas.querySelectorAll('.rdio-stream-item')

        Array.prototype.forEach.call(nodes, function (el) {
            var type = el.getAttribute('data-type') || ''
            var auto = el.getAttribute('data-autoscroll') === '1'
            var content = el.querySelector('.item-content')
            if (!content) return

            if (type === 'transcript') {
                if (!auto) return

                var maxV = content.scrollHeight - content.clientHeight
                var call = self.state.call
                var transcript = self.state.displayCall && self.state.displayCall.transcript

                if (maxV <= 0 || !call || !transcript) return

                var duration = self.app.getCallDuration ? self.app.getCallDuration(call.id) : 0
                if (!duration || duration <= 0) return

                // Tied to playback position, not to the clock: a transcript that
                // scrolled on its own would drift out of step with the audio.
                var elapsed = self.state.callProgress.getTime() / 1000
                var top = Math.max(0, Math.min(1, elapsed / duration)) * maxV

                writes.push(function () { content.scrollTop = top })
                return
            }

            if (type === 'text') {
                // Custom text wraps, so it overflows downwards.
                var maxText = content.scrollHeight - content.clientHeight

                if (!auto || maxText <= 1) {
                    if (content.scrollTop !== 0) writes.push(function () { content.scrollTop = 0 })
                    return
                }

                var textTop = marqueePos(now, maxText)
                writes.push(function () { content.scrollTop = textTop })
                return
            }

            if (type === 'history' || L.isBorder(type)) return

            // A single-line value overflows sideways.
            var maxH = content.scrollWidth - content.clientWidth

            if (!auto || maxH <= 1) {
                if (content.scrollLeft !== 0) writes.push(function () { content.scrollLeft = 0 })
                return
            }

            var left = marqueePos(now, maxH)
            writes.push(function () { content.scrollLeft = left })
        })

        for (var i = 0; i < writes.length; i++) writes[i]()
    }

    // Out, pause, back, pause — so the end of a long value is readable rather
    // than sliding past. Driven by the clock rather than by accumulated frames,
    // so a dropped frame does not leave the marquee behind.
    function marqueePos(now, max) {
        var travel = (max / PX_PER_SEC) * 1000
        var cycle = (travel + PAUSE_MS) * 2
        var t = now % cycle

        if (t < PAUSE_MS) return 0
        if (t < PAUSE_MS + travel) return ((t - PAUSE_MS) / travel) * max
        if (t < PAUSE_MS * 2 + travel) return max

        return max - ((t - (PAUSE_MS * 2 + travel)) / travel) * max
    }

    Scroller.marqueePos = marqueePos
    Scroller.PX_PER_SEC = PX_PER_SEC
    Scroller.PAUSE_MS = PAUSE_MS

    root.RdioStreamScroller = Scroller
})(window)
