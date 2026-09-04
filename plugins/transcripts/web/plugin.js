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
 *
 * These settings now render inside each system's own editor, through the
 * admin-system slot, rather than as a list of every system parked under the
 * plugin manager. That list was the only place a plugin could draw at the time.
 * It meant configuring one system's prompt happened two tabs away from
 * everything else about that system, against a second copy of the system list
 * that could disagree with the real one — and it scaled badly, rendering every
 * system and every talkgroup on a server that has hundreds.
 */
;(function () {
    'use strict'

    window.rdioScanner.plugins.register('transcripts', {
        init: function (ctx) {
            ctx.slots.mount('admin-system', function (el, data) {
                return mount(ctx, el, data)
            })
        },
    })

    // One fetch, shared by every pane.
    //
    // The endpoint answers for all systems at once, and the slot remounts on
    // every system the user clicks through — so without this, browsing a
    // twelve-system config is twelve identical round trips. Cleared after a
    // save, and on failure, so the next pane retries rather than replaying the
    // error forever.
    var settingsRequest = null

    // Edits that have not been saved yet, kept per system id.
    //
    // Selecting another system destroys this pane and building a fresh one from
    // the server would silently discard whatever was typed. The system editor
    // around it deliberately keeps unsaved edits across that same switch, so
    // dropping them here would make the plugin's fields behave unlike every
    // field beside them.
    var pending = {}

    function loadSettings(ctx) {
        if (!settingsRequest) {
            settingsRequest = ctx.api.get('settings').catch(function (err) {
                settingsRequest = null
                throw err
            })
        }

        return settingsRequest
    }

    function mount(ctx, el, system) {
        var systemId = system && system.id

        // A system being created has no id yet, and these settings are stored
        // against one. Nothing to draw until it has been saved.
        if (systemId === null || systemId === undefined || systemId === '') return

        var state = {
            systemId: systemId,
            label: (system && system.label) || '',
            provider: '',
            promptMaxChars: 896,
            globalPrompt: '',
            talkgroups: [],
            settings: { systemId: systemId, transcribe: true, prompt: '' },
            talkgroupSettings: {},
            loaded: false,
            error: '',
        }

        var root = document.createElement('div')
        root.className = 'rdio-transcripts-system'
        el.appendChild(root)

        injectStyles()
        render()
        load()

        function render() {
            root.textContent = ''

            var title = document.createElement('div')
            title.className = 'tx-title'
            title.textContent = 'Transcription'
            root.appendChild(title)

            if (state.error) {
                var problem = document.createElement('p')
                problem.className = 'tx-note tx-error'
                problem.textContent = state.error
                root.appendChild(problem)
                return
            }

            if (!state.loaded) {
                var loading = document.createElement('p')
                loading.className = 'tx-note'
                loading.textContent = 'Loading…'
                root.appendChild(loading)
                return
            }

            root.appendChild(systemFields())
        }

        function systemFields() {
            var wrap = document.createElement('div')

            var head = document.createElement('div')
            head.className = 'tx-row'

            var describe = document.createElement('p')
            describe.className = 'tx-describe'
            describe.innerHTML = '<span class="tx-label">Transcribe this system</span><br>' +
                '<span class="tx-note">Off means calls on this system are never sent to ' +
                (state.provider ? escapeHtml(state.provider) : 'the transcription provider') +
                '. Individual talkgroups can be switched off below.</span>'
            head.appendChild(describe)

            var toggle = document.createElement('label')
            toggle.className = 'tx-toggle'

            var box = document.createElement('input')
            box.type = 'checkbox'
            box.checked = state.settings.transcribe !== false
            box.addEventListener('change', function () {
                state.settings.transcribe = box.checked
                markPending()
            })
            toggle.appendChild(box)
            head.appendChild(toggle)

            wrap.appendChild(head)

            var promptRow = document.createElement('div')
            promptRow.className = 'tx-block'

            var promptLabel = document.createElement('p')
            promptLabel.className = 'tx-describe'
            promptLabel.innerHTML = '<span class="tx-label">Prompt</span><br>' +
                '<span class="tx-note">Biases the transcription toward this system’s vocabulary — unit ' +
                'identifiers, street names, agency abbreviations. Left blank, the global prompt from the ' +
                'plugin’s settings is used; a prompt here replaces it rather than adding to it.</span>'
            promptRow.appendChild(promptLabel)

            var prompt = document.createElement('textarea')
            prompt.className = 'tx-prompt'
            prompt.rows = 3
            prompt.placeholder = 'Unit IDs, street names, agency names… (leave blank to use the global prompt)'
            prompt.value = state.settings.prompt || ''
            promptRow.appendChild(prompt)

            // Not a maxlength. Only Groq enforces the cap, and it does so by
            // trimming from the front at transcription time — so a hard limit
            // here would block prompts another provider accepts, while saying
            // nothing about what actually happens when one is too long.
            var counter = document.createElement('div')
            counter.className = 'tx-count'
            promptRow.appendChild(counter)

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
                state.settings.prompt = prompt.value
                markPending()
                updateCounter()
            })

            updateCounter()
            wrap.appendChild(promptRow)

            // Talkgroups are a switch only. A per-talkgroup prompt would be more
            // vocabulary than Whisper's prompt window can hold on a system with
            // hundreds of them, and Groq caps it at 896 characters regardless.
            if (state.talkgroups.length) {
                var details = document.createElement('details')
                details.className = 'tx-talkgroups'

                var summary = document.createElement('summary')
                summary.textContent = 'Per-talkgroup switches (' + state.talkgroups.length + ')'
                details.appendChild(summary)

                var list = document.createElement('div')
                list.className = 'tx-talkgroup-list'
                state.talkgroups.forEach(function (talkgroup) {
                    list.appendChild(talkgroupRow(talkgroup))
                })
                details.appendChild(list)

                wrap.appendChild(details)
            }

            var actions = document.createElement('div')
            actions.className = 'tx-actions'

            var save = document.createElement('button')
            save.type = 'button'
            save.className = 'tx-save'
            save.textContent = 'Save transcription settings'
            save.addEventListener('click', function () { persist(save) })
            actions.appendChild(save)

            var hint = document.createElement('span')
            hint.className = 'tx-note tx-save-hint'
            hint.textContent = 'Saved separately from the system’s own settings.'
            actions.appendChild(hint)

            wrap.appendChild(actions)

            return wrap
        }

        function talkgroupRow(talkgroup) {
            var current = state.talkgroupSettings[talkgroup.id]

            var row = document.createElement('label')
            row.className = 'tx-talkgroup'

            var box = document.createElement('input')
            box.type = 'checkbox'
            box.checked = !current || current.transcribe !== false
            box.addEventListener('change', function () {
                state.talkgroupSettings[talkgroup.id] = {
                    systemId: state.systemId,
                    talkgroupId: talkgroup.id,
                    transcribe: box.checked,
                }
                markPending()
            })
            row.appendChild(box)

            var label = document.createElement('span')
            label.textContent = talkgroup.label || talkgroup.name || ('Talkgroup ' + talkgroup.id)
            row.appendChild(label)

            return row
        }

        function markPending() {
            pending[state.systemId] = {
                settings: state.settings,
                talkgroupSettings: state.talkgroupSettings,
            }
        }

        function load() {
            loadSettings(ctx).then(function (data) {
                state.provider = (data && data.provider) || ''
                state.promptMaxChars = (data && data.promptMaxChars) || state.promptMaxChars
                state.globalPrompt = (data && data.globalPrompt) || ''

                var system = findSystem(data)
                state.talkgroups = (system && system.talkgroups) || []
                if (!state.label) state.label = (system && system.label) || ''

                ;((data && data.systemSettings) || []).forEach(function (row) {
                    if (!sameId(row.systemId, state.systemId)) return

                    state.settings = {
                        systemId: state.systemId,
                        transcribe: row.transcribe !== false && row.transcribe !== 0,
                        prompt: row.prompt || '',
                    }
                })

                ;((data && data.talkgroupSettings) || []).forEach(function (row) {
                    if (!sameId(row.systemId, state.systemId)) return

                    state.talkgroupSettings[row.talkgroupId] = {
                        systemId: state.systemId,
                        talkgroupId: row.talkgroupId,
                        transcribe: row.transcribe !== false && row.transcribe !== 0,
                    }
                })

                // Whatever was typed before this pane was last destroyed wins
                // over what the server last stored.
                var unsaved = pending[state.systemId]
                if (unsaved) {
                    state.settings = unsaved.settings
                    state.talkgroupSettings = unsaved.talkgroupSettings
                }

                state.loaded = true
                render()
            }).catch(function (err) {
                state.loaded = true
                state.error = 'Could not load transcription settings: ' + err
                render()
            })
        }

        function findSystem(data) {
            var systems = (data && data.systems) || []

            for (var i = 0; i < systems.length; i++) {
                if (sameId(systems[i].id, state.systemId)) return systems[i]
            }

            return null
        }

        function persist(button) {
            var talkgroups = Object.keys(state.talkgroupSettings).map(function (id) {
                return state.talkgroupSettings[id]
            })

            button.disabled = true
            button.textContent = 'Saving…'

            // Only this system. The endpoint upserts row by row and does not
            // delete what it was not sent, so a pane can save its own settings
            // without holding a copy of every other system's.
            ctx.api.post('settings', { systems: [state.settings], talkgroups: talkgroups }).then(function () {
                delete pending[state.systemId]
                settingsRequest = null

                button.disabled = false
                button.textContent = 'Saved'
                // Back to the resting label, so the button does not read as
                // though it is still reporting the last save forever.
                window.setTimeout(function () {
                    button.textContent = 'Save transcription settings'
                }, 2000)
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

    // System ids arrive as a number from the config form and can come back from
    // the settings endpoint as a string, depending on the database driver.
    function sameId(a, b) {
        return String(a) === String(b)
    }

    function escapeHtml(text) {
        var span = document.createElement('span')
        span.textContent = text
        return span.innerHTML
    }

    // Styled from the theme contract so this looks like the rest of the system
    // editor rather than like something bolted on.
    function injectStyles() {
        if (document.getElementById('rdio-transcripts-admin-css')) return

        var css = [
            '.rdio-transcripts-system { display: block; margin: 8px 0 0;',
            '  padding-top: 16px; border-top: 1px solid rgba(var(--line-rgb, 148,163,184), 0.2); }',
            '.rdio-transcripts-system .tx-title { margin-bottom: 12px; font-weight: 500; }',
            '.rdio-transcripts-system .tx-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }',
            '.rdio-transcripts-system .tx-block { margin-top: 14px; }',
            '.rdio-transcripts-system .tx-describe { margin: 0; }',
            '.rdio-transcripts-system .tx-label { font-size: 14px; }',
            '.rdio-transcripts-system .tx-note { font-size: 12px; opacity: 0.75; }',
            '.rdio-transcripts-system .tx-error { color: var(--state-danger-text-dim, #fca5a5); opacity: 1; }',
            '.rdio-transcripts-system .tx-toggle { flex: none; padding-top: 2px; cursor: pointer; }',
            '.rdio-transcripts-system .tx-prompt { display: block; width: 100%; margin-top: 8px; padding: 6px 8px;',
            '  border: 1px solid rgba(var(--line-rgb, 148,163,184), 0.4); border-radius: 6px;',
            '  background: rgba(var(--surface-deep-rgb, 2,6,23), 0.5); color: var(--text-pale, #f1f5f9);',
            '  font: inherit; font-size: 12px; resize: vertical; box-sizing: border-box; }',
            '.rdio-transcripts-system .tx-count { margin-top: 4px; font-size: 11px; opacity: 0.65; }',
            '.rdio-transcripts-system .tx-count.tx-over { color: var(--state-danger-text-dim, #fca5a5); opacity: 1; }',
            '.rdio-transcripts-system .tx-talkgroups { margin-top: 14px; font-size: 12px; }',
            '.rdio-transcripts-system .tx-talkgroups summary { cursor: pointer; opacity: 0.75; }',
            // Hundreds of talkgroups would otherwise push everything below off
            // the page; the list scrolls in place instead.
            '.rdio-transcripts-system .tx-talkgroup-list { max-height: 260px; margin-top: 6px; overflow-y: auto; }',
            '.rdio-transcripts-system .tx-talkgroup { display: flex; align-items: center; gap: 6px; padding: 3px 0 3px 16px; cursor: pointer; }',
            '.rdio-transcripts-system .tx-actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }',
            '.rdio-transcripts-system .tx-save { padding: 8px 16px; border: 0; border-radius: 6px;',
            '  background: rgba(var(--accent-rgb, 249,115,22), 0.9); color: #fff; font: inherit; cursor: pointer; }',
            '.rdio-transcripts-system .tx-save:disabled { opacity: 0.6; cursor: default; }',
        ].join('\n')

        var style = document.createElement('style')
        style.id = 'rdio-transcripts-admin-css'
        style.textContent = css
        document.head.appendChild(style)
    }
})()
