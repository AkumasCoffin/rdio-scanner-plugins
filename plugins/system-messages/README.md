# System Messages

Tell everyone listening what is going on — "County Fire is not being received", "the server restarts
at 22:00" — above the scanner display, so they do not have to write and ask.

Needs Rdio Scanner 6.14.4-beta.1 or later.

## What listeners see

Each message that is showing is a line above the display, system messages first and maintenance
messages after them. A listener can close a message and carry on listening; a small "closed
messages" button stays behind, and pressing it — or any message — opens a card with all of them, the
two kinds under their own headings.

A message that is edited is shown again to listeners who had closed it. Nothing is shown before a
listener has entered their access code, on servers that use them.

The Android app shows the same messages in builds that include support for this plugin. Older
builds of the app show nothing.

## Posting a message

In the administration page, open **Plugins** and press **Settings** on the System Messages card.

| Field | |
|---|---|
| Kind | **System** for something about what is being received; **Maintenance** for work on the server. |
| Colour | Five for each kind — see below. The first of each is the one it starts on. |
| Title | Up to 80 characters. |
| Text | Optional, up to 500 characters. Line breaks are kept. |
| Link | Optional. One `http://` or `https://` address, and the words to show it as. |
| Starts | Empty for now, or a time to start showing it. |
| Ends | Empty for "until I end it", or a time to stop. |

The text is plain text. Markup typed into a message is shown as it was typed.

The colours are split by kind so that a colour never means two things, and each set runs from calm
to serious:

| System | | Maintenance | |
|---|---|---|---|
| Green | All clear, or restored | Blue | Planned |
| Teal | Information | Amber | Starting soon |
| Purple | A notice | Orange | Running over |
| Yellow | Degraded | Red | Under way |
| Pink | An outage | Grey | Finished, or called off |

The meanings are there to pick by; nothing enforces them. Messages posted with version 1.0, which
let either kind use any colour, keep the colour they have until they are edited.

**End now** takes a message down and keeps it in the list; **Delete** removes it. Listeners see either
within a couple of seconds, without reloading.

At most 20 messages can be showing or scheduled at once.

## The HTTP API

Other programs can post, change and end messages — a monitoring check that notices a feed has
stopped, a deploy script announcing a restart.

1. In the same Settings panel, under **API keys**, name what will use the key and press **Create key**. The key
   is shown once; only a hash of it is stored.
2. Send it as `X-API-Key`, or as `Authorization: Bearer <key>`.

These keys are their own. An upload API key cannot post messages, and a message key cannot upload
calls.

```sh
BASE=https://scanner.example.com/api/plugin/system-messages
KEY=sm_...

# Post a system message that shows until it is ended
curl -s -X POST "$BASE/v1/messages" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"kind":"system","color":"yellow","title":"County Fire is not being received","body":"The north tower feed dropped at 14:05."}'

# Post a maintenance window ahead of time
curl -s -X POST "$BASE/v1/messages" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"kind":"maintenance","title":"Server update tonight","startsAt":"2026-03-01T21:00:00Z","endsAt":"2026-03-01T22:30:00Z"}'

# What listeners are being shown right now
curl -s "$BASE/v1/messages?active=true" -H "X-API-Key: $KEY"

# End message 12
curl -s -X POST "$BASE/v1/messages/end?id=12" -H "X-API-Key: $KEY"
```

| | | |
|---|---|---|
| `GET` | `/v1/messages` | List. `?active=true` for only what is showing. |
| `POST` | `/v1/messages` | Post a message. |
| `GET` | `/v1/messages/item?id=N` | Read one. |
| `PUT` | `/v1/messages/item?id=N` | Replace one. Shows it again to listeners who closed it. |
| `DELETE` | `/v1/messages/item?id=N` | Delete one. |
| `POST` | `/v1/messages/end?id=N` | End one now. |
| `GET` | `/v1/openapi.json` | The full description. No key needed. |

The complete contract — every field, limit, and error — is [`openapi.json`](openapi.json), an
OpenAPI 3.1 document. The running plugin serves the same file at `/v1/openapi.json`, so a client
generator or an API browser can be pointed straight at your server.

Times go in as ISO 8601 with a zone, or as milliseconds since the epoch, and come back as ISO 8601
in UTC. Errors are `{"error": "…"}` with 400 (the request was wrong), 401 (no key, or not a key this
server knows), 404 (no such message) or 409 (a limit was reached).

## For other clients

Clients receive the messages over the websocket they already hold, as the `SYM` command:

```json
["SYM", { "messages": [ { "id": 12, "revision": 1, "kind": "system", "color": "yellow",
  "title": "…", "body": "", "linkUrl": "", "linkLabel": "", "startsAt": 1772402400000, "endsAt": null } ] }]
```

The list is everything showing now, in display order, and replaces what the client had. It is pushed
whenever it changes; a client sends `SYM` after it connects to be told the current list. Remember a
closed message as `id:revision`.

## Tests

```sh
node main.test.js
```
