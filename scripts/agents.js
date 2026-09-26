/* agents.js — the AI agent panel
 *
 * SECURITY MODEL — read this before wiring a real model.
 *
 * There is no API key in this file and there must never be one. Anything in
 * the browser is readable by anyone who loads the page, so a key here is a
 * published key. The remote path below therefore POSTs to a same-origin
 * endpoint and expects the Worker (_worker.js) to hold the credential and
 * call the model server-side. A key committed here would be scraped within
 * minutes of the first push to GitHub.
 *
 * Until that Worker is deployed, every command below is local and offline:
 * tokenising, summarising, and pattern-matching only. That is enough for the
 * panel to be useful and testable with no network and no cost.
 */
(function (global) {
    "use strict";

    var DEFAULT_CONFIG = {
        // Same-origin by default. Point this at your Worker route, e.g.
        // '/api/agent'. Left null, the agent stays fully offline.
        agentEndpoint: null,
        model: 'local-rules',
        maxNoteChars: 200000
    };

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
        this.busy = false;
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
        Promise.resolve()
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

        if (this.config.agentEndpoint) {
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
            '\n\n(No model endpoint configured — this agent is running fully ' +
            'offline. Set agentEndpoint in app.js after deploying _worker.js.)';
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

        if (/^(find|search)\b/.test(cmd)) {
            var query = prompt.replace(/^\s*(find|search)\s*/i, '').trim();
            if (!query) return 'Try: find kubernetes';
            return this.find(query, ctx.notes);
        }

        return null;
    };

    /**
     * POST to the Worker. The Worker is expected to hold the model key and
     * return { reply: string }. No credentials are attached here by design.
     *
     * Hardened because the response is untrusted: it is capped, its
     * content-type is checked, and the reply is string-validated before it
     * reaches the DOM.
     */
    /** True only for a URL on this app's own origin. */
    AgentManager.prototype.isSameOrigin = function (endpoint) {
        try {
            return new URL(endpoint, global.location.href).origin === global.location.origin;
        } catch (err) {
            return false; // unparseable: treat as hostile
        }
    };

    AgentManager.prototype.callRemote = function (prompt, ctx) {
        var self = this;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 30000);

        // Trim the note payload: a 200 KB note is not a useful prompt and
        // would blow the request budget on every call.
        var note = ctx.note
            ? { title: ctx.note.title, content: ctx.note.content.slice(0, self.config.maxNoteChars) }
            : null;

        return fetch(this.config.agentEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt, note: note, model: this.config.model }),
            signal: controller.signal,
            credentials: 'same-origin',
            redirect: 'error' // a redirect here would leak the prompt elsewhere
        })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var type = res.headers.get('content-type') || '';
                if (type.indexOf('json') === -1) {
                    throw new Error('Expected JSON, got ' + (type || 'no content-type'));
                }
                // Cap before parsing: a hostile/erroneous endpoint cannot
                // stream an unbounded body into memory.
                return res.text().then(function (text) {
                    if (text.length > 1e6) throw new Error('Response too large');
                    return JSON.parse(text);
                });
            })
            .then(function (data) {
                if (!data || typeof data.reply !== 'string') {
                    throw new Error('Malformed response from agent endpoint');
                }
                // Bound what reaches innerText/textContent.
                return data.reply.slice(0, 20000);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') {
                    throw new Error('Request timed out after 30s.');
                }
                throw err;
            })
            .finally(function () { clearTimeout(timer); });
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

    AgentManager.prototype.focus = function () {
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
