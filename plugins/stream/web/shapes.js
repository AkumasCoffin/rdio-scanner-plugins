/*
 * Stream overlay — shapable borders.
 *
 * A shape is an editable closed polygon drawn as up to three concentric bands.
 * The bands are not offset polygons: each is the same outline stroked at a
 * different width and clipped to the interior, so only the inside half shows.
 * Offsetting would spike at reflex corners, which is precisely what someone
 * bending an edge inwards is likely to make.
 *
 * Ported from the original's imperative SVG builder, geometry and all. The
 * corner rounding in particular is subtle enough that reimplementing it would
 * have been a way to get slightly different corners for no reason.
 */

;(function (root) {
    'use strict'

    var NS = 'http://www.w3.org/2000/svg'
    var L = root.RdioStreamLayout

    function Shapes(svg, store, renderer) {
        this.svg = svg
        this.store = store
        this.renderer = renderer
        this.signature = ''
    }

    Shapes.prototype.items = function () {
        return this.store.getLayout().items.filter(function (i) { return i.type === 'shape' })
    }

    Shapes.prototype.points = function (item) {
        return (item.points && item.points.length >= 3) ? item.points : L.defaultShapePoints(item.w, item.h)
    }

    Shapes.prototype.absPoints = function (item) {
        return this.points(item).map(function (p) { return { x: item.x + p.x, y: item.y + p.y } })
    }

    // Rebuilt only when something that affects the drawing changes. Shapes are
    // rebuilt from scratch each time, so doing it on every data tick would mean
    // tearing down and recreating SVG twice a second for a static border.
    Shapes.prototype.update = function () {
        var shapes = this.items()
        var self = this

        var signature = shapes.map(function (s) {
            return [s.id, s.x, s.y, JSON.stringify(s.points), s.borderWidth, s.cornerRadius,
                s.color, s.useLedColor ? 1 : 0,
                s.middleFill ? 1 : 0, s.middleWidth, s.middleColor, s.middleUseLed ? 1 : 0,
                s.centerFill ? 1 : 0, s.innerWidth, s.centerColor, s.centerUseLed ? 1 : 0,
                s.hideOnCall ? 1 : 0, s.hideOnIdle ? 1 : 0, s.w, s.h,
                JSON.stringify(s.dividers)].join(':')
        }).join('||') + '#' + (this.renderer.ledColor() || '') +
            (this.renderer.state.call ? 'c' : 'i')

        if (signature === this.signature) return
        this.signature = signature

        var renders = []
        shapes.forEach(function (s) {
            // Honour the item's own hide-while-call and hide-while-idle toggles.
            if (!self.renderer.dataVisible(s)) return
            var render = self.build(s)
            if (render) renders.push(render)
        })

        this.paint(renders)
    }

    Shapes.prototype.build = function (item) {
        var outline = roundedPath(this.absPoints(item), item.cornerRadius)
        if (!outline) return null

        var r = this.renderer

        var wo = item.borderWidth
        var wm = item.middleFill ? item.middleWidth : 0
        var wi = item.centerFill ? item.innerWidth : 0
        var total = wo + wm + wi

        // Widest first, narrower bands painted over it. Each stroke is centred on
        // the outline and clipped to the interior, so a stroke of 2×width shows
        // exactly `width` inside.
        var bands = []
        if (total > 0) bands.push({ color: r.colorOf(item), width: 2 * total })
        if (wm > 0) bands.push({ color: colorOf(r, item, 'middle'), width: 2 * (wm + wi) })
        if (wi > 0) bands.push({ color: colorOf(r, item, 'center'), width: 2 * wi })

        var dividers = []
        var dvs = item.dividers || []

        if (dvs.length && total > 0) {
            // One line the full thickness of the border, gradient-filled across
            // its width — inner at each edge, then middle, then outer down the
            // centre — so it meets the bands as a blend rather than as two hard
            // lines that do not quite line up.
            var half = []
            if (wi > 0) half.push(colorOf(r, item, 'center'))
            if (wm > 0) half.push(colorOf(r, item, 'middle'))
            if (wo > 0) half.push(r.colorOf(item))

            var colors = half.length > 1 ? half.concat(half.slice(0, -1).reverse()) : half
            var stops = colors.map(function (color, i) {
                return { off: colors.length > 1 ? Number((i / (colors.length - 1)).toFixed(4)) : 0, color: color }
            })

            var h = total / 2

            dvs.forEach(function (dv) {
                if (dv.axis === 'v') {
                    var x = item.x + dv.pos * item.w
                    dividers.push({
                        d: 'M ' + x.toFixed(2) + ' ' + (item.y - 2).toFixed(2) +
                           ' L ' + x.toFixed(2) + ' ' + (item.y + item.h + 2).toFixed(2),
                        width: total, x1: x - h, y1: item.y, x2: x + h, y2: item.y, stops: stops,
                    })
                } else {
                    var y = item.y + dv.pos * item.h
                    dividers.push({
                        d: 'M ' + (item.x - 2).toFixed(2) + ' ' + y.toFixed(2) +
                           ' L ' + (item.x + item.w + 2).toFixed(2) + ' ' + y.toFixed(2),
                        width: total, x1: item.x, y1: y - h, x2: item.x, y2: y + h, stops: stops,
                    })
                }
            })
        }

        return bands.length ? { outline: outline, bands: bands, dividers: dividers } : null
    }

    function colorOf(renderer, item, which) {
        var useLed = which === 'middle' ? item.middleUseLed : item.centerUseLed
        var own = which === 'middle' ? item.middleColor : item.centerColor
        return useLed ? (renderer.ledColor() || own) : own
    }

    Shapes.prototype.paint = function (renders) {
        var svg = this.svg
        while (svg.firstChild) svg.removeChild(svg.firstChild)

        svg.style.display = renders.length ? '' : 'none'
        if (!renders.length) return

        var defs = document.createElementNS(NS, 'defs')
        svg.appendChild(defs)

        renders.forEach(function (r, index) {
            // Index-based ids, so they are always valid and unique whatever an
            // item's id happens to be.
            var clipId = 'rdio-shape-clip-' + index

            var clip = document.createElementNS(NS, 'clipPath')
            clip.setAttribute('id', clipId)
            clip.setAttribute('clipPathUnits', 'userSpaceOnUse')

            var clipPath = document.createElementNS(NS, 'path')
            clipPath.setAttribute('d', r.outline)
            clip.appendChild(clipPath)
            defs.appendChild(clip)

            // Dividers under the bands, so they meet the inner edge cleanly.
            r.dividers.forEach(function (dv, di) {
                var stroke

                if (dv.stops.length <= 1) {
                    stroke = dv.stops[0] ? dv.stops[0].color : '#000000'
                } else {
                    var gradId = 'rdio-shape-divgrad-' + index + '-' + di
                    var grad = document.createElementNS(NS, 'linearGradient')
                    grad.setAttribute('id', gradId)
                    grad.setAttribute('gradientUnits', 'userSpaceOnUse')
                    grad.setAttribute('x1', String(dv.x1))
                    grad.setAttribute('y1', String(dv.y1))
                    grad.setAttribute('x2', String(dv.x2))
                    grad.setAttribute('y2', String(dv.y2))

                    dv.stops.forEach(function (s) {
                        var stop = document.createElementNS(NS, 'stop')
                        stop.setAttribute('offset', String(s.off))
                        stop.setAttribute('stop-color', s.color)
                        grad.appendChild(stop)
                    })

                    defs.appendChild(grad)
                    stroke = 'url(#' + gradId + ')'
                }

                var line = document.createElementNS(NS, 'path')
                line.setAttribute('d', dv.d)
                line.setAttribute('fill', 'none')
                line.setAttribute('stroke', stroke)
                line.setAttribute('stroke-width', String(dv.width))
                line.setAttribute('clip-path', 'url(#' + clipId + ')')
                line.style.clipPath = 'url(#' + clipId + ')'
                svg.appendChild(line)
            })

            r.bands.forEach(function (band) {
                var path = document.createElementNS(NS, 'path')
                path.setAttribute('d', r.outline)
                path.setAttribute('fill', 'none')
                path.setAttribute('stroke', band.color)
                path.setAttribute('stroke-width', String(band.width))
                path.setAttribute('stroke-linejoin', 'round')
                // Both the attribute and the CSS property: older WebKit honours
                // only one of them for an SVG clip reference, and OBS embeds a
                // browser nobody chose.
                path.setAttribute('clip-path', 'url(#' + clipId + ')')
                path.style.clipPath = 'url(#' + clipId + ')'
                svg.appendChild(path)
            })
        })
    }

    // A closed polygon with rounded corners. The cut-back at each vertex is
    // clamped to half of each adjoining edge so a tight corner cannot eat the
    // edge next to it, and the arc radius shrinks with it when clamped.
    function roundedPath(poly, radius) {
        var n = poly.length
        if (n < 3) return ''

        var pin = []
        var pout = []
        var sweep = []
        var arc = []

        for (var i = 0; i < n; i++) {
            var prev = poly[(i - 1 + n) % n]
            var v = poly[i]
            var next = poly[(i + 1) % n]

            var inX = v.x - prev.x
            var inY = v.y - prev.y
            var outX = next.x - v.x
            var outY = next.y - v.y

            var lenIn = Math.hypot(inX, inY) || 1
            var lenOut = Math.hypot(outX, outY) || 1

            var uinX = inX / lenIn
            var uinY = inY / lenIn
            var uoutX = outX / lenOut
            var uoutY = outY / lenOut

            var cross = uinX * uoutY - uinY * uoutX  // sin of the turn, signed
            var dot = uinX * uoutX + uinY * uoutY    // cos of the turn
            var sin = Math.abs(cross)

            // tan of half the turn: near zero on a straight run, large at a cusp
            var halfTan = sin / Math.max(1e-6, 1 + dot)

            // Collinear and not a cusp: nothing to round.
            if (sin < 0.02 && dot > 0) {
                pin.push(v)
                pout.push(v)
                arc.push(0)
                sweep.push(0)
                continue
            }

            var t = Math.min(radius * halfTan, lenIn / 2, lenOut / 2)
            var r = halfTan > 1e-6 ? t / halfTan : 0

            pin.push({ x: v.x - uinX * t, y: v.y - uinY * t })
            pout.push({ x: v.x + uoutX * t, y: v.y + uoutY * t })
            arc.push(r)
            sweep.push(cross > 0 ? 1 : 0)
        }

        function f(p) { return p.x.toFixed(2) + ' ' + p.y.toFixed(2) }

        var d = 'M ' + f(pout[0])

        for (var step = 1; step <= n; step++) {
            var j = step % n
            if (arc[j] > 0.5) {
                d += ' L ' + f(pin[j]) + ' A ' + arc[j].toFixed(2) + ' ' + arc[j].toFixed(2) +
                     ' 0 0 ' + sweep[j] + ' ' + f(pout[j])
            } else {
                // Straight through the vertex. Emitting pin and pout, which
                // coincide here, would leave a zero-length segment that a round
                // line-join draws as a stray disc on a flat edge.
                d += ' L ' + f(poly[j])
            }
        }

        return d + ' Z'
    }

    Shapes.roundedPath = roundedPath

    root.RdioStreamShapes = Shapes
})(window)
