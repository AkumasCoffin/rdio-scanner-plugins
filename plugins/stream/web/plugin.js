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
            var parts = ['layout.js', 'store.js', 'state.js', 'render.js', 'shapes.js', 'scroll.js', 'gate.js', 'mirror.js', 'props.js', 'edit.js']

            var loading = parts.reduce(function (chain, file) {
                return chain.then(function () { return ctx.assets.loadScript('web/' + file) })
            }, Promise.resolve())

            loading = loading.then(function () { return loadStyle(ctx, 'web/overlay.css') })

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

    // The overlay's stylesheet, added to the page by the plugin itself rather
    // than through ctx.assets.loadStyle.
    //
    // loadStyle keeps what it loads at the end of <head>, by moving it back
    // there whenever something is added after it. Up to rdio-scanner 6.14.4
    // that went wrong as soon as two plugins had styles: each was moved behind
    // the other on every frame, and a <link> that is moved is fetched again, so
    // this stylesheet never stayed applied and the overlay drew as a column of
    // plain text. The overlay's rules are all on its own class names and do
    // not need to be last, so it simply stays where it is put.
    //
    // Marked as the plugin's, so the host still removes it when the plugin is
    // switched off.
    function loadStyle(ctx, path) {
        return new Promise(function (resolve, reject) {
            var link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = ctx.assets.url(path)
            link.dataset.rdioPlugin = 'stream'
            link.onload = function () { resolve() }
            link.onerror = function () { reject(new Error('cannot load ' + path)) }
            document.head.appendChild(link)
        })
    }

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

        // Follower mode: the overlay mirrors whatever the main page is playing
        // rather than driving playback itself, which is what makes a second
        // window usable as a display. requestSyncState asks for the current
        // state immediately, so an overlay opened mid-call is not blank until
        // the next one.
        try {
            if (app.enableFollowerMode) app.enableFollowerMode()
            if (app.requestSyncState) app.requestSyncState()
        } catch (err) {
            console.error('[stream] could not enter follower mode', err)
        }

        // The other half of follower mode: report back what the overlay is
        // showing, so the main scanner page's LCD shows the same call. Its own
        // feed is stopped while the overlay is open, so without this the main
        // page is a set of controls over a blank screen. A separate
        // subscription from the renderer's because it is a different job — the
        // renderer draws, this reports.
        var mirror = new window.RdioStreamMirror(app).start()

        // Point the manifest at this page, so installing the overlay as an app
        // opens the overlay and not the scanner. The plugin ships its own rather
        // than using the webapp's, which goes away when the built-in overlay
        // does — a manifest pointing at a file the server no longer has would
        // break installing without breaking anything visible first.
        var manifest = document.querySelector('link[rel="manifest"]')
        var previousManifest = manifest ? manifest.getAttribute('href') : null
        if (manifest) manifest.setAttribute('href', ctx.assets.url('web/stream.webmanifest'))

        // The display fonts, loaded only while the overlay is open.
        var fonts = document.createElement('link')
        fonts.rel = 'stylesheet'
        fonts.href = window.RdioStreamLayout.FONTS_HREF
        fonts.dataset.rdioStreamFonts = '1'
        document.head.appendChild(fonts)

        var store = new window.RdioStreamStore()
        var version = ctx.config.get().rdioVersion
        var state = new window.RdioStreamState(app, version).start()
        var renderer = new window.RdioStreamRenderer(container, store, state).mount()
        var shapes = new window.RdioStreamShapes(renderer.svg, store, renderer)
        var scroller = new window.RdioStreamScroller(renderer.canvas, state, app).start()
        var gate = new window.RdioStreamGate(renderer.canvas, state, app).attach()
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
            gate.detach()
            scroller.stop()

            mirror.stop()

            try {
                if (app.disableFollowerMode) app.disableFollowerMode()
            } catch (err) {
                // Leaving the page tears the session down anyway.
            }

            if (manifest && previousManifest !== null) manifest.setAttribute('href', previousManifest)
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
