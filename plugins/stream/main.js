/*
 * Stream overlay — server side.
 *
 * The overlay is a frontend feature; almost nothing needs to happen here. The
 * one thing that does is publishing the page address to the browser, because
 * ctx.config.get() reads only what the server side has exposed — a setting that
 * lives in the manifest but is never exposed simply never arrives, and the
 * overlay would silently ignore it and sit at the default path.
 */

function publish() {
    var path = String(rdio.config.get('path') || 'stream').replace(/^\/+|\/+$/g, '')

    rdio.config.expose('streamPath', path || 'stream')

    // The LCD shows the running version as its idle talkgroup name. The webapp
    // reads that from its own bundle; a plugin is not rebuilt when rdio is, so
    // it has to ask the server instead.
    rdio.config.expose('rdioVersion', rdio.server.version)
}

rdio.on('startup', function () {
    publish()
    rdio.log('info', 'stream overlay available at /' + (rdio.config.get('path') || 'stream'))
})

// A path change needs a reload of any open overlay to take effect, since the
// route is claimed when the page's plugin code loads. Republishing keeps a
// freshly-loaded page correct without a server restart.
rdio.on('config.changed', function () {
    publish()
})
