/*
 * Transcripts — per-system and per-talkgroup settings.
 *
 * The backend has always stored these: a prompt and a transcribe switch per
 * system, and a transcribe switch per talkgroup, with GET and POST endpoints to
 * read and write them. What it never had was anywhere to set them, so the
 * per-system prompt the built-in transcription offered simply went missing when
 * the feature moved out of the server.
 *
 * A prompt is what makes transcription usable on a busy system — unit
 * identifiers, street names, agency abbreviations, the vocabulary Whisper will
 * otherwise guess at. One global prompt cannot serve a fire system and a rail
 * network at once, which is why the per-system one exists.
 */

;(function () {
    'use strict'

    window.rdioScanner.plugins.register('transcripts', {
        init: function (ctx) {
            ctx.slots.mount('admin-panel', function (el) {
                return mount(ctx, el)
            })
        },
    })

    function mount(ctx, el) {
        var state = {
            systems: [],
            systemSettings: {},
            talkgroupSettings: {},
            provider: '',
            promptMaxChars: 896,
            globalPrompt: '',
            open: false,
            loaded: false,
        }

        var root = document.createElement('div')
        root.className = 'rdio-transcripts-admin'
        el.appendChild(root)

        injectStyles(ctx)
        render()

        function render() {
            root.textContent = ''

            var header = document.createElement('button')
            header.type = 'button'
            header.className = 'tx-header'
            header.textContent = 'Transcription — per system'
            header.addEventListener('click', function () {
                state.open = !state.open
                if (state.open && !state.loaded) load()
                else render()
            })
            root.appendChild(header)

            if (!state.open) return

            var body = document.createElement('div')
            body.className = 'tx-body'
            root.appendChild(body)

            if (!state.loaded) {
                var loading = document.createElement('p')
                loading.className = 'tx-note'
                loading.textContent = 'Loading…'
                body.appendChild(loading)
                return
            }

            var intro = document.createElement('p')
            intro.className = 'tx-note'
            intro.textContent =
                'A prompt biases Whisper toward the vocabulary of one system — unit identifiers, ' +
                'street names, agency abbreviations. A system left blank falls back to the global ' +
                'prompt in this plugin’s settings, and a system prompt replaces it rather than ' +
                'adding to it. The same ' + state.promptMaxChars + '-character limit applies to both.'
            body.appendChild(intro)

            if (!state.systems.length) {
                var none = document.createElement('p')
                none.className = 'tx-note'
                none.textContent = 'No systems are configured yet.'
                body.appendChild(none)
                return
            }

            state.systems.forEach(function (system) {
                body.appendChild(systemRow(system))
            })

            var actions = document.createElement('div')
            actions.className = 'tx-actions'

            var save = document.createElement('button')
            save.type = 'button'
            save.className = 'tx-save'
            save.textContent = 'Save transcription settings'
            save.addEventListener('click', function () { persist(save) })
            actions.appendChild(save)

            body.appendChild(actions)
        }

        function systemRow(system) {
            var settings = state.systemSettings[system.id] || { transcribe: true, prompt: '' }

            var wrap = document.createElement('div')
            wrap.className = 'tx-system'

            var head = document.createElement('div')
            head.className = 'tx-system-head'

            var name = document.createElement('span')
            name.className = 'tx-system-name'
            name.textContent = system.label || ('System ' + system.id)
            head.appendChild(name)

            var toggle = document.createElement('label')
            toggle.className = 'tx-toggle'

            var box = document.createElement('input')
            box.type = 'checkbox'
            box.checked = settings.transcribe !== false
            box.addEventListener('change', function () {
                setSystem(system.id, { transcribe: box.checked })
            })
            toggle.appendChild(box)

            var toggleText = document.createElement('span')
            toggleText.textContent = 'Transcribe'
            toggle.appendChild(toggleText)

            head.appendChild(toggle)
            wrap.appendChild(head)

            var prompt = document.createElement('textarea')
            prompt.className = 'tx-prompt'
            prompt.rows = 3
            prompt.placeholder = 'Unit IDs, street names, agency names… (leave blank to use the global prompt)'
            prompt.value = settings.prompt || ''
            wrap.appendChild(prompt)

            // Not a maxlength. Only Groq enforces the cap, and it does so by
            // trimming from the front at transcription time — so a hard limit
            // here would block prompts another provider accepts, while saying
            // nothing about what actually happens when one is too long.
            var counter = document.createElement('div')
            counter.className = 'tx-count'
            wrap.appendChild(counter)

            var updateCounter = function () {
                var length = prompt.value.length
                var over = length - state.promptMaxChars

                // Blank is a real setting, not an empty field, so it says which
                // prompt the system will actually be transcribed with.
                if (!length) {
                    counter.classList.remove('tx-over')
                    counter.textContent = state.globalPrompt
                        ? 'Using the global prompt (' + state.globalPrompt.length + ' characters)'
                        : 'No prompt — the global one is blank too'
                    return
                }

                counter.textContent = length + ' / ' + state.promptMaxChars
                counter.classList.toggle('tx-over', over > 0)

                if (over > 0) {
                    counter.textContent += state.provider === 'groq'
                        ? ' — Groq will drop the first ' + over + ' characters'
                        : ' — over the limit other providers enforce'
                }
            }

            prompt.addEventListener('input', function () {
                setSystem(system.id, { prompt: prompt.value })
                updateCounter()
            })

            updateCounter()

            // Talkgroups are a switch only. A per-talkgroup prompt would be more
            // vocabulary than Whisper's prompt window can hold on a system with
            // hundreds of them, and Groq caps it at 896 characters regardless.
            if ((system.talkgroups || []).length) {
                var details = document.createElement('details')
                details.className = 'tx-talkgroups'

                var summary = document.createElement('summary')
                summary.textContent = system.talkgroups.length + ' talkgroups'
                details.appendChild(summary)

                system.talkgroups.forEach(function (talkgroup) {
                    details.appendChild(talkgroupRow(system, talkgroup))
                })

                wrap.appendChild(details)
            }

            return wrap
        }

        function talkgroupRow(system, talkgroup) {
            var key = system.id + ':' + talkgroup.id
            var settings = state.talkgroupSettings[key] || { transcribe: true }

            var row = document.createElement('label')
            row.className = 'tx-talkgroup'

            var box = document.createElement('input')
            box.type = 'checkbox'
            box.checked = settings.transcribe !== false
            box.addEventListener('change', function () {
                state.talkgroupSettings[key] = {
                    systemId: system.id,
                    talkgroupId: talkgroup.id,
                    transcribe: box.checked,
                }
            })
            row.appendChild(box)

            var label = document.createElement('span')
            label.textContent = talkgroup.label || talkgroup.name || ('Talkgroup ' + talkgroup.id)
            row.appendChild(label)

            return row
        }

        function setSystem(systemId, changes) {
            var current = state.systemSettings[systemId] || { systemId: systemId, transcribe: true, prompt: '' }

            current.systemId = systemId
            if ('transcribe' in changes) current.transcribe = changes.transcribe
            if ('prompt' in changes) current.prompt = changes.prompt

            state.systemSettings[systemId] = current
        }

        function load() {
            ctx.api.get('settings').then(function (data) {
                state.systems = (data && data.systems) || []
                state.provider = (data && data.provider) || ''
                state.promptMaxChars = (data && data.promptMaxChars) || state.promptMaxChars
                state.globalPrompt = (data && data.globalPrompt) || ''

                state.systemSettings = {}
                ;((data && data.systemSettings) || []).forEach(function (row) {
                    state.systemSettings[row.systemId] = {
                        systemId: row.systemId,
                        transcribe: row.transcribe !== false && row.transcribe !== 0,
                        prompt: row.prompt || '',
                    }
                })

                state.talkgroupSettings = {}
                ;((data && data.talkgroupSettings) || []).forEach(function (row) {
                    state.talkgroupSettings[row.systemId + ':' + row.talkgroupId] = {
                        systemId: row.systemId,
                        talkgroupId: row.talkgroupId,
                        transcribe: row.transcribe !== false && row.transcribe !== 0,
                    }
                })

                state.loaded = true
                render()
            }).catch(function (err) {
                state.loaded = true
                render()

                var problem = document.createElement('p')
                problem.className = 'tx-note tx-error'
                problem.textContent = 'Could not load transcription settings: ' + err
                root.appendChild(problem)
            })
        }

        function persist(button) {
            var systems = Object.keys(state.systemSettings).map(function (id) {
                return state.systemSettings[id]
            })

            var talkgroups = Object.keys(state.talkgroupSettings).map(function (key) {
                return state.talkgroupSettings[key]
            })

            button.disabled = true
            button.textContent = 'Saving…'

            ctx.api.post('settings', { systems: systems, talkgroups: talkgroups }).then(function () {
                button.disabled = false
                button.textContent = 'Saved'
                // Back to the resting label, so the button does not read as
                // though it is still reporting the last save forever.
                window.setTimeout(function () { button.textContent = 'Save transcription settings' }, 2000)
            }).catch(function (err) {
                button.disabled = false
                button.textContent = 'Save failed — try again'
                console.error('[transcripts] could not save settings', err)
            })
        }

        return function () {
            if (root.parentNode) root.parentNode.removeChild(root)
        }
    }

    // Styled from the theme contract so this looks like the rest of the admin
    // panel rather than like something bolted on.
    function injectStyles(ctx) {
        if (document.getElementById('rdio-transcripts-admin-css')) return

        var css = [
            '.rdio-transcripts-admin { display: block; margin: 0 0 8px; }',
            '.rdio-transcripts-admin .tx-header { display: block; width: 100%; padding: 16px 24px; border: 0;',
            '  background: var(--surface-panel, #1e293b); color: var(--text-pale, #f1f5f9);',
            '  font: inherit; font-weight: 500; text-align: left; cursor: pointer; }',
            '.rdio-transcripts-admin .tx-header:hover { background: rgba(var(--line-rgb, 148,163,184), 0.12); }',
            '.rdio-transcripts-admin .tx-body { padding: 8px 24px 20px; }',
            '.rdio-transcripts-admin .tx-note { margin: 4px 0 14px; font-size: 12px; opacity: 0.75; }',
            '.rdio-transcripts-admin .tx-error { color: var(--state-danger-text-dim, #fca5a5); opacity: 1; }',
            '.rdio-transcripts-admin .tx-system { padding: 10px 0; border-top: 1px solid rgba(var(--line-rgb, 148,163,184), 0.2); }',
            '.rdio-transcripts-admin .tx-system-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
            '.rdio-transcripts-admin .tx-system-name { font-weight: 500; }',
            '.rdio-transcripts-admin .tx-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }',
            '.rdio-transcripts-admin .tx-prompt { display: block; width: 100%; margin-top: 8px; padding: 6px 8px;',
            '  border: 1px solid rgba(var(--line-rgb, 148,163,184), 0.4); border-radius: 6px;',
            '  background: rgba(var(--surface-deep-rgb, 2,6,23), 0.5); color: var(--text-pale, #f1f5f9);',
            '  font: inherit; font-size: 12px; resize: vertical; box-sizing: border-box; }',
            '.rdio-transcripts-admin .tx-count { margin-top: 4px; font-size: 11px; opacity: 0.65; }',
            '.rdio-transcripts-admin .tx-count.tx-over { color: var(--state-danger-text-dim, #fca5a5); opacity: 1; }',
            '.rdio-transcripts-admin .tx-talkgroups { margin-top: 8px; font-size: 12px; }',
            '.rdio-transcripts-admin .tx-talkgroups summary { cursor: pointer; opacity: 0.75; }',
            '.rdio-transcripts-admin .tx-talkgroup { display: flex; align-items: center; gap: 6px; padding: 3px 0 3px 16px; cursor: pointer; }',
            '.rdio-transcripts-admin .tx-actions { margin-top: 16px; }',
            '.rdio-transcripts-admin .tx-save { padding: 8px 16px; border: 0; border-radius: 6px;',
            '  background: rgba(var(--accent-rgb, 249,115,22), 0.9); color: #fff; font: inherit; cursor: pointer; }',
            '.rdio-transcripts-admin .tx-save:disabled { opacity: 0.6; cursor: default; }',
        ].join('\n')

        var style = document.createElement('style')
        style.id = 'rdio-transcripts-admin-css'
        style.textContent = css
        document.head.appendChild(style)
    }
})()
