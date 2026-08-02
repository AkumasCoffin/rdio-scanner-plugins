# Transcripts

Transcribes call audio with Whisper and shows it in the scanner. This was part of
the Rdio Scanner server until 6.14; it is a plugin now, and renders identically —
the LCD, the search rows and the stream overlay were not changed.

## Setup

Install from the plugin repository, enable it, and set a provider and API key in
the plugin's settings. Groq and OpenAI are both Whisper-compatible; a self-hosted
Whisper endpoint works too.

Upgrading from a server that had transcription built in needs nothing: the
transcripts already in `calls.transcript` are migrated into this plugin's tables
on first start, verified by count, and the plugin is installed and enabled
automatically.

Several API keys can be given at once. They are used in rotation, and a key that
comes back rate-limited is set aside until its retry window passes rather than
being hammered.

## What other plugins can do with it

Transcripts are announced on the plugin bus and answerable over RPC, so nothing
else has to read this plugin's tables. That matters: the schema here is this
plugin's business to change, and a plugin querying it directly would break the
next time it did.

### Subscribe

Every transcript is published as it becomes final — from local transcription, an
inbound push from an upstream server, a transcript that arrived before its own
call, or a manual retranscribe.

```js
rdio.plugins.subscribe('transcript', function (ev) {
    // ev.from       'transcripts'
    // ev.payload    { id, system, talkgroup, transcript }
    if (/structure fire/i.test(ev.payload.transcript)) {
        // alert, notify, tag the call, whatever you like
    }
})
```

Publishing never waits and never reports who listened, so a subscriber cannot
slow transcription down or make it fail.

### Ask

```js
rdio.plugins.call('transcripts', 'has', { id: 42 })
// -> { id: 42, ready: true }

rdio.plugins.call('transcripts', 'get', { id: 42 })
// -> { id: 42, transcript: '...' }  or null

rdio.plugins.call('transcripts', 'transcribe', { id: 42 })
// transcribes now if there is no transcript yet; pass force: true to redo one
// -> { id: 42, transcript: '...', cached: false }
```

Check availability from `plugins.ready`, not `startup` — `startup` fires per
plugin in load order, so this plugin may not have loaded yet when yours does.

```js
rdio.on('plugins.ready', function () {
    if (rdio.plugins.has('transcripts')) {
        // wire up
    }
})
```

## Between servers

A transcript is forwarded to any downstream that advertises the
`transcript-forward` capability, and accepted from upstreams at
`/api/call-transcript` using the same API keys call uploads use.

First write wins. A downstream topology where two servers forward to each other
does not loop: the second arrival finds a transcript already present and is
neither stored again nor re-forwarded.

If an upstream is expected to supply a transcript and does not, this server
transcribes the call itself after a fallback delay rather than leaving it blank.
