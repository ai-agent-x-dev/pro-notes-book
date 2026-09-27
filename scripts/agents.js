/* agents.js — the AI agent panel
 *
 * SECURITY MODEL — read this before changing the remote path.
 *
 * There is no API key in this file and there must never be one. Anything in
 * the browser is readable by anyone who loads the page, so a key here is a
 * published key, scraped within minutes of the first push to GitHub.
 *
 * Instead, prompts the local commands do not handle are POSTed to the
 * same-origin /api/agent route in _worker.js, which holds the Claude API key
 * as a Cloudflare secret and calls the model server-side. The browser proves
 * it may use that route with a passphrase, not with the key.
 *
 * Nothing leaves the browser unless a GET probe of the endpoint reports a
 * model is available. On GitHub Pages (no server code) and offline, the probe
 * fails and every command stays local: tokenising, summarising and
 * pattern-matching only.
 */
(function (global) {
    "use strict";

    var DEFAULT_CONFIG = {
        // Relative, so it resolves against the page: /api/agent on Cloudflare
        // Pages (served by _worker.js), and a 404 under GitHub Pages, where the
        // probe in init() then keeps the panel fully offline. Set to null to
        // never contact a server at all.
        agentEndpoint: 'api/agent',
        // Matches the Worker's MAX_NOTE_CHARS and the app's import cap, so a
        // note the app can hold is sent whole.
        maxNoteChars: 200000,
        maxTitleChars: 500,
        timeoutMs: 90000
    };

    // The passphrase for the Worker, NOT an API key: the Claude API key only
    // ever exists server-side. Kept apart from the notes keys so Export never
    // includes it.
    var PASSPHRASE_KEY = 'pro-notes-agent-passphrase';

    /**
     * @param {object} [options] All optional. `new AgentManager()` is valid and
     *   falls back to the global `storage`; the DOM elements are optional too,
     *   so constructing the agent before the panel exists does not throw.
     *   (An unguarded `options.storage` here crashed the whole app on load.)
     */
    function AgentManager(options) {
        var opts = options || {};
        this.storage = opts.storage ||
            (typeof storage !== 'undefined' ? storage : null);
        this.config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
        this.messages = opts.messagesEl || document.getElementById('agent-messages');
        this.input = opts.inputEl || document.getElementById('agent-prompt');
        this.sendBtn = opts.sendBtn || document.getElementById('send-agent-prompt');
        this.hint = opts.hintEl || document.getElementById('agent-hint');
        this.authRow = opts.authEl || document.getElementById('agent-auth');
        this.passInput = opts.passInputEl || document.getElementById('agent-passphrase');
        this.passBtn = opts.passBtn || document.getElementById('agent-passphrase-save');
        this.busy = false;
        // True once the endpoint's probe says a model is available. Until
        // then nothing is ever sent to the server.
        this.remote = false;
        this.probed = null; // the probe's promise, once started
        this.pendingPrompt = null;
        this.init();
    }

    AgentManager.prototype.init = function () {
        var self = this;
        // Every element is optional: the agent can be constructed headlessly
        // (e.g. from a test) and still answer commands.
        if (!this.input || !this.messages) return;

        if (this.sendBtn) {
            this.sendBtn.addEventListener('click', function () { self.send(); });
        }

        // Enter sends, Shift+Enter newlines.
        this.input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                self.send();
            }
        });

        if (this.passBtn && this.passInput) {
            this.passBtn.addEventListener('click', function () { self.unlock(); });
            this.passInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); self.unlock(); }
            });
        }
        // No probe here: it runs on first use (focus() or send()), so a
        // visitor who never opens the panel makes no request, and GitHub
        // Pages does not log a 404 on every page load.
    };

    /** Start the endpoint probe once; later calls share its result. */
    AgentManager.prototype.ensureProbed = function () {
        if (!this.probed) this.probed = this.probe();
        return this.probed;
    };

    /* ---------------------------------------------------------------- remote */

    /**
     * Ask the endpoint whether a model is available. A GET with no note
     * content: on GitHub Pages it is a harmless 404, offline the service
     * worker answers 504, and either way the panel stays local-only.
     */
    AgentManager.prototype.probe = function () {
        var self = this;
        var endpoint = this.config.agentEndpoint;
        if (!endpoint || !this.isSameOrigin(endpoint) || typeof fetch !== 'function') {
            return Promise.resolve(false);
        }
        return fetch(endpoint, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
            .then(function (res) {
                if (!res.ok) return false;
                return res.json().then(function (data) { return !!(data && data.available === true); });
            })
            .catch(function () { return false; })
            .then(function (available) {
                self.remote = available;
                self.setHint();
                return available;
            });
    };

    AgentManager.prototype.setHint = function () {
        if (!this.hint) return;
        this.hint.textContent = this.remote
            ? 'Commands like "help" run locally. Anything else is sent, with the open note, to Claude through this site\'s server.'
            : 'Runs fully offline. Try "help".';
    };

    AgentManager.prototype.getPassphrase = function () {
        try { return global.localStorage.getItem(PASSPHRASE_KEY) || ''; } catch (err) { return ''; }
    };

    AgentManager.prototype.setPassphrase = function (value) {
        try {
            if (value) global.localStorage.setItem(PASSPHRASE_KEY, value);
            else global.localStorage.removeItem(PASSPHRASE_KEY);
        } catch (err) { /* storage blocked: it lasts for this page only */ }
        this.sessionPassphrase = value || '';
    };

    AgentManager.prototype.showAuth = function (show) {
        if (!this.authRow) return;
        this.authRow.classList.toggle('hidden', !show);
        if (show && this.passInput) this.passInput.focus();
    };

    /** Store the typed passphrase and retry the prompt that asked for it. */
    AgentManager.prototype.unlock = function () {
        var value = this.passInput ? this.passInput.value.trim() : '';
        if (!value) return;
        this.passInput.value = '';
        this.setPassphrase(value);
        this.showAuth(false);
        if (this.pendingPrompt) {
            var retry = this.pendingPrompt;
            this.pendingPrompt = null;
            this.input.value = retry;
            this.send();
        }
    };

    /* ------------------------------------------------------------------ chat */

    AgentManager.prototype.send = function () {
        if (this.busy || !this.input) return;
        var text = this.input.value.trim();
        if (!text) return;

        this.input.value = '';
        this.append('user', text);

        var ctx = this.getContext();
        var typing = this.appendTyping();

        this.busy = true;
        this.setBusy(true);

        var self = this;
        this.ensureProbed()
            .then(function () { return self.dispatch(text, ctx); })
            .then(function (reply) {
                typing.remove();
                self.append('bot', typeof reply === 'string' ? reply : JSON.stringify(reply));
            })
            .catch(function (err) {
                typing.remove();
                console.error('agent: dispatch failed', err);
                self.append('error', 'Request failed: ' + (err && err.message ? err.message : err));
            })
            .then(function () {
                self.busy = false;
                self.setBusy(false);
                self.input.focus();
            });
    };

    /**
     * Current note + store snapshot, so commands act on what the user sees.
     */
    AgentManager.prototype.getContext = function () {
        var store = this.storage;
        return {
            note: (global.NB && global.NB.app) ? global.NB.app.getCurrentNoteSnapshot() : null,
            notes: store ? store.getNotes() : [],
            notebooks: store ? store.getNotebooks() : []
        };
    };

    /**
     * Local commands first; the remote Worker only gets a chance if no local
     * command matched AND an endpoint is configured.
     */
    AgentManager.prototype.dispatch = function (prompt, ctx) {
        var local = this.runLocal(prompt, ctx);
        if (local) return local;

        if (this.remote && this.config.agentEndpoint) {
            // The header promises "same-origin endpoint", but a comment is not
            // enforcement. If agentEndpoint is ever set from settings, a query
            // string or a shared config, this is what stops note content being
            // POSTed to an attacker's host. (CSP connect-src 'self' is the
            // second line of defence.)
            if (this.isSameOrigin(this.config.agentEndpoint)) {
                return this.callRemote(prompt, ctx);
            }
            console.warn('agent: refusing a cross-origin agentEndpoint',
                this.config.agentEndpoint);
        }

        return this.help(ctx) +
            '\n\n(No model is available on this host, so the assistant runs ' +
            'fully offline. Deploy to Cloudflare Pages with _worker.js to ' +
            'connect Claude.)';
    };

    /**
     * @returns {string|null} reply, or null if no command matched
     */
    AgentManager.prototype.runLocal = function (prompt, ctx) {
        var cmd = prompt.toLowerCase().trim();

        if (/^(hi|hello|hey)\b/.test(cmd)) {
            return 'Hello. I can summarize, outline, tag, or count the current note. ' +
                'Type "help" for the list.';
        }

        if (/^(help|\?|commands)\b/.test(cmd)) {
            return this.help(ctx);
        }

        if (cmd === 'lock') {
            this.setPassphrase('');
            return 'Passphrase forgotten on this device. The next request to ' +
                'Claude will ask for it again.';
        }

        // Before the note commands: their patterns match anywhere in the
        // text, so "find summary" or "search stats" was answered as a summary
        // or stats request instead of searching for the word.
        if (/^(find|search)\b/.test(cmd)) {
            var query = prompt.replace(/^\s*(find|search)\s*/i, '').trim();
            if (!query) return 'Try: find kubernetes';
            return this.find(query, ctx.notes);
        }

        if (/summar(y|ise|ize)/.test(cmd)) {
            if (!ctx.note) return 'Open a note first.';
            return 'Summary\n\n' + this.summarize(ctx.note.content, 60);
        }

        if (/^(outline|structure|headings)/.test(cmd)) {
            if (!ctx.note) return 'Open a note first.';
            return this.outline(ctx.note.content);
        }

        if (/^(tags?|hashtags)/.test(cmd)) {
            if (!ctx.note) return 'Open a note first.';
            var tags = this.extractTags(ctx.note.content);
            return tags.length
                ? 'Tags in this note\n\n' + tags.map(function (t) { return '#' + t; }).join('  ')
                : 'No #tags found in this note.';
        }

        if (/(word ?count|how many words|stats|length)/.test(cmd)) {
            if (!ctx.note) return 'Open a note first.';
            return this.stats(ctx.note.content);
        }

        if (/^(title|suggest (a )?title)/.test(cmd)) {
            if (!ctx.note) return 'Open a note first.';
            var t = this.suggestTitle(ctx.note.content);
            return t ? 'Suggested title\n\n' + t : 'Add some body text first.';
        }

        return null;
    };

    /** True only for a URL on this app's own origin. */
    AgentManager.prototype.isSameOrigin = function (endpoint) {
        try {
            return new URL(endpoint, global.location.href).origin === global.location.origin;
        } catch (err) {
            return false; // unparseable: treat as hostile
        }
    };

    var MAX_RESPONSE_BYTES = 1e6;

    /**
     * Read a response body as text, aborting once it passes maxBytes.
     *
     * res.text() buffers the whole body before its length can be checked, so
     * a cap applied afterwards protects nothing. Counting bytes as they
     * stream in stops a runaway endpoint at the cap.
     */
    AgentManager.prototype.readCapped = function (res, maxBytes, controller) {
        var declared = Number(res.headers.get('content-length'));
        if (declared > maxBytes) {
            controller.abort();
            return Promise.reject(new Error('Response too large'));
        }
        if (!res.body || !res.body.getReader) {
            // No streaming support: fall back to a buffered read.
            return res.text().then(function (text) {
                if (text.length > maxBytes) throw new Error('Response too large');
                return text;
            });
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var received = 0;
        var text = '';
        function pump() {
            return reader.read().then(function (chunk) {
                if (chunk.done) return text + decoder.decode();
                received += chunk.value.byteLength;
                if (received > maxBytes) {
                    controller.abort();
                    throw new Error('Response too large');
                }
                text += decoder.decode(chunk.value, { stream: true });
                return pump();
            });
        }
        return pump();
    };

    /**
     * POST to the same-origin endpoint, which is expected to hold the model
     * key and return { reply: string }. No credentials are attached here by
     * design.
     *
     * Hardened because the response is untrusted: its size is capped while
     * it streams, its content-type is checked, and the reply is
     * string-validated before it reaches the DOM.
     */
    AgentManager.prototype.callRemote = function (prompt, ctx) {
        var self = this;
        var passphrase = this.getPassphrase() || this.sessionPassphrase || '';
        if (!passphrase) return this.askPassphrase(prompt);

        var controller = new AbortController();
        var timeoutMs = this.config.timeoutMs;
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

        // The note is read from the editor snapshot. Both limits equal what
        // the app can store, so these slices never cut a note the app holds.
        var note = ctx.note
            ? {
                title: String(ctx.note.title || '').slice(0, self.config.maxTitleChars),
                content: String(ctx.note.content || '').slice(0, self.config.maxNoteChars)
            }
            : null;

        return fetch(this.config.agentEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // A custom header also forces a CORS preflight, which the
                // Worker never approves, so no other site can call it.
                'Authorization': 'Bearer ' + passphrase
            },
            // No model field: the server decides which model runs.
            body: JSON.stringify({ prompt: prompt, note: note }),
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error' // a redirect here would leak the prompt elsewhere
        })
            .then(function (res) {
                if (res.status === 401) {
                    self.setPassphrase('');
                    return { ask: true };
                }
                if (!res.ok) {
                    // The Worker returns { error } with a readable reason.
                    return self.readCapped(res, 10000, controller)
                        .then(function (text) { return JSON.parse(text); })
                        .catch(function () { return null; })
                        .then(function (data) {
                            throw new Error(data && typeof data.error === 'string'
                                ? data.error.slice(0, 300)
                                : 'HTTP ' + res.status);
                        });
                }
                var type = res.headers.get('content-type') || '';
                if (type.indexOf('json') === -1) {
                    throw new Error('Expected JSON, got ' + (type || 'no content-type'));
                }
                return self.readCapped(res, MAX_RESPONSE_BYTES, controller)
                    .then(function (text) { return JSON.parse(text); });
            })
            .then(function (data) {
                if (data && data.ask) {
                    return self.askPassphrase(prompt, 'That passphrase was not accepted.');
                }
                if (!data || typeof data.reply !== 'string') {
                    throw new Error('Malformed response from agent endpoint');
                }
                // Bound what reaches textContent.
                return data.reply.slice(0, 40000);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') {
                    throw new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's.');
                }
                throw err;
            })
            .finally(function () { clearTimeout(timer); });
    };

    /** Show the passphrase field; the prompt is retried once it is entered. */
    AgentManager.prototype.askPassphrase = function (prompt, reason) {
        this.pendingPrompt = prompt;
        this.showAuth(true);
        return (reason ? reason + ' ' : '') +
            'Enter the assistant passphrase below to send this to Claude. ' +
            'It is stored on this device; type "lock" to forget it.';
    };

    /* -------------------------------------------------------------- commands */

    AgentManager.prototype.help = function (ctx) {
        var where = ctx && ctx.note
            ? 'Acting on: "' + ctx.note.title + '"'
            : 'No note open — open one for note-scoped commands.';
        return [
            'Commands',
            '',
            '  summarize            first-lines summary of the note',
            '  outline              list the headings',
            '  tags                 hashtags found in the note',
            '  stats                words, characters, reading time',
            '  title                suggest a title',
            '  find <term>          search across every note',
            '  lock                 forget the Claude passphrase on this device',
            '  help                 this list',
            '',
            where
        ].join('\n');
    };

    AgentManager.prototype.summarize = function (body, maxWords) {
        var text = String(body || '').trim();
        if (!text) return '(empty note)';

        var paragraphs = text.split(/\n\s*\n/).filter(function (p) { return p.trim(); });
        var out = [];
        var used = 0;

        for (var i = 0; i < paragraphs.length && used < maxWords; i++) {
            var p = paragraphs[i].replace(/\s+/g, ' ').trim();
            var words = p.split(' ').length;
            if (used + words > maxWords) {
                p = p.split(' ').slice(0, maxWords - used).join(' ') + '…';
                used = maxWords;
            } else {
                used += words;
            }
            out.push(p);
        }

        return out.join('\n\n');
    };

    AgentManager.prototype.outline = function (body) {
        var lines = String(body || '').split('\n');
        var heads = [];
        lines.forEach(function (line) {
            var m = line.match(/^(#{1,6})\s+(.+)$/);
            if (m) heads.push('  '.repeat(m[1].length - 1) + m[2].trim());
        });
        if (!heads.length) return 'No markdown headings in this note.';
        return heads.join('\n');
    };

    AgentManager.prototype.extractTags = function (body) {
        var found = String(body || '').match(/(^|\s)#([\w-]{1,50})/g) || [];
        var out = [];
        found.forEach(function (m) {
            var tag = m.trim().slice(1).toLowerCase();
            if (tag && out.indexOf(tag) === -1) out.push(tag);
        });
        return out;
    };

    AgentManager.prototype.stats = function (body) {
        var text = String(body || '');
        var words = (text.match(/\S+/g) || []).length;
        var chars = text.length;
        var lines = text ? text.split('\n').length : 0;
        var readMin = Math.max(1, Math.round(words / 200));
        return [
            'Words:      ' + words,
            'Characters: ' + chars,
            'Lines:      ' + lines,
            'Reading:    ~' + readMin + ' min'
        ].join('\n');
    };

    AgentManager.prototype.suggestTitle = function (body) {
        var text = String(body || '').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        // Prefer a leading heading, else the first 6 words.
        var heading = text.match(/^#\s+(.+)/);
        if (heading) return heading[1].trim().slice(0, 80);
        var words = text.split(' ').slice(0, 6).join(' ');
        return (words + (text.split(' ').length > 6 ? '…' : '')).slice(0, 80);
    };

    AgentManager.prototype.find = function (query, notes) {
        var q = query.toLowerCase();
        var hits = (notes || []).filter(function (n) {
            return String(n.title || '').toLowerCase().indexOf(q) !== -1 ||
                String(n.content || '').toLowerCase().indexOf(q) !== -1;
        }).slice(0, 8);

        if (!hits.length) return 'No notes match "' + query + '".';
        return hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ':\n\n' +
            hits.map(function (n, i) {
                return '  ' + (i + 1) + '. ' + (n.title || 'Untitled');
            }).join('\n');
    };

    /* ----------------------------------------------------------------- view */

    AgentManager.prototype.append = function (role, text) {
        if (!this.messages) return null;
        var el = document.createElement('div');
        el.className = 'agent-message ' + role;
        // textContent, not innerHTML: model output is untrusted input.
        el.textContent = text;
        this.messages.appendChild(el);
        this.scrollToEnd();
        return el;
    };

    AgentManager.prototype.appendTyping = function () {
        if (!this.messages) return { remove: function () {} };
        var el = document.createElement('div');
        el.className = 'agent-message bot agent-typing';
        el.innerHTML = '<span></span><span></span><span></span>'; // static markup
        this.messages.appendChild(el);
        this.scrollToEnd();
        return { remove: function () { if (el.parentNode) el.parentNode.removeChild(el); } };
    };

    AgentManager.prototype.scrollToEnd = function () {
        if (!this.messages) return;
        this.messages.scrollTop = this.messages.scrollHeight;
    };

    AgentManager.prototype.setBusy = function (busy) {
        if (this.sendBtn) {
            this.sendBtn.disabled = busy;
            this.sendBtn.textContent = busy ? 'Working…' : 'Send';
        }
    };

    /** Called when the panel opens. */
    AgentManager.prototype.focus = function () {
        this.ensureProbed();
        if (this.input) this.input.focus();
    };

    /** Alias: app.js call sites use this name. */
    AgentManager.prototype.sendAgentPrompt = function () {
        return this.send();
    };

    global.NB = global.NB || {};
    global.NB.AgentManager = AgentManager;
    global.NB.agentConfig = DEFAULT_CONFIG;
})(window);
