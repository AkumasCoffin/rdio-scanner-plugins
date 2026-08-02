/*
 * Stream overlay — plugin entry.
 *
 * Claims a top-level page and renders the overlay into it. The page is the
 * scanner's peer rather than something inside it: it renders under a bare
 * router outlet, so there is no application chrome around it, which is what an
 * OBS browser source needs.
 */

;(function () {
    'use strict'

    window.rdioScanner.plugins.register('stream', {
        init: function (ctx) {
            var path = String(ctx.config.get().streamPath || 'stream').replace(/^\/+|\/+$/g, '') || 'stream'

            // Parts are loaded by the entry rather than bundled, so the source
            // stays readable and the plugin needs no build step to install.
            var parts = ['layout.js', 'store.js', 'state.js', 'render.js', 'shapes.js', 'scroll.js', 'props.js', 'edit.js']

            var loading = parts.reduce(function (chain, file) {
                return chain.then(function () { return ctx.assets.loadScript('web/' + file) })
            }, Promise.resolve())

            loading = loading.then(function () { return ctx.assets.loadStyle('web/overlay.css') })

            loading.then(function () {
                ctx.routes.register({
                    path: path,
                    mount: function (container) {
                        return mount(ctx, container)
                    },
                })
            }).catch(function (err) {
                console.error('[stream] could not load the overlay', err)
            })
        },
    })

    function mount(ctx, container) {
        var app = ctx.app

        if (!app) {
            container.textContent = 'The stream overlay needs the scanner, which is not available on this page.'
            return function () { /* nothing to tear down */ }
        }

        // Declare this connection a display surface so it is not counted as a
        // listener. The server used to infer that from the /stream URL; saying
        // it explicitly is what lets the overlay live at a path of its choosing.
        try {
            if (app.setOverlay) app.setOverlay(true)
        } catch (err) {
            // An older server infers it from the path; nothing is lost.
        }

        // The display fonts, loaded only while the overlay is open.
        var fonts = document.createElement('link')
        fonts.rel = 'stylesheet'
        fonts.href = window.RdioStreamLayout.FONTS_HREF
        fonts.dataset.rdioStreamFonts = '1'
        document.head.appendChild(fonts)

        var store = new window.RdioStreamStore()
        var state = new window.RdioStreamState(app).start()
        var renderer = new window.RdioStreamRenderer(container, store, state).mount()
        var shapes = new window.RdioStreamShapes(renderer.svg, store, renderer)
        var scroller = new window.RdioStreamScroller(renderer.canvas, state, app).start()
        var editor = new window.RdioStreamEditor(renderer.canvas, store, renderer).attach()

        // A layout change rebuilds; a data change only rewrites text. The
        // selection is repainted after a rebuild because the nodes it was drawn
        // on may have been replaced.
        store.onChange(function () {
            renderer.build()
            shapes.update()
            editor.paintSelection()
        })
        state.onChange(function () {
            renderer.update()
            // Shapes follow the talkgroup colour and the call/idle toggles, so
            // they have to be re-checked on data too. update() is signature
            // guarded, so a static border costs a string compare.
            shapes.update()
        })

        return function () {
            editor.detach()
            scroller.stop()
            state.stop()
            store.destroy()
            renderer.destroy()

            try {
                if (app.setOverlay) app.setOverlay(false)
            } catch (err) {
                // Leaving the page closes the socket anyway.
            }

            if (fonts.parentNode) fonts.parentNode.removeChild(fonts)
        }
    }
})()
