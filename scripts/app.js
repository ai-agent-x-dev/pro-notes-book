/* app.js — wiring. Loaded last, so storage / SearchManager / AgentManager exist.
 *
 * Rendering rule for this whole file: build nodes and set textContent. Never
 * build a row with innerHTML + interpolation. Note titles, notebook names and
 * tag names are all user input (typed, or arriving from an imported backup),
 * and innerHTML is the only thing that would turn them into script. The two
 * innerHTML uses below are static markup or marked+DOMPurify output.
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    /** Terse node builder: el('div', 'notebook-item', 'text'). */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    /** A color is only ever applied through this, so it cannot carry CSS. */
    const safeColor = (c) => /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#00ffcc';

    const state = {
        note: null,          // { id, title, content, notebook, tags } — id null until first save
        notebook: null,      // null = all notebooks
        tag: null,           // null = no tag filter
        preview: false,
        dirty: false
    };

    let search = null;
    let agents = null;
    let autoSaveTimer = null;

    /** Autosave fires this long after the last keystroke. */
    const AUTOSAVE_DEFAULT_MS = 2000;

    /* ------------------------------------------------------------------ boot */

    function init() {
        // Referenced through NB, not as bare globals: agents.js declares
        // AgentManager inside an IIFE, so it is not a global binding and a
        // bare `new AgentManager()` throws ReferenceError.
        search = new NB.SearchManager(storage);
        agents = new NB.AgentManager();

        bind();
        restoreOpenNote();
        applyFontSize();
        render();

        // Re-render on a change made in this tab (save, import, delete).
        window.addEventListener('notes-updated', () => {
            if (!state.dirty) syncEditor();
            render();
        });

        // Another tab wrote to the store. The browser fires 'storage' only in
        // the OTHER tabs, never the writer, so this cannot loop. Re-emitting
        // notes-updated reuses the path above and rebuilds the search index.
        window.addEventListener('storage', onExternalChange);

        // Mobile browsers routinely kill a backgrounded tab without firing
        // beforeunload, so flush when the page is hidden, not only on unload.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && state.dirty) saveNote(true);
        });

        window.addEventListener('beforeunload', (e) => {
            if (!state.dirty) return;
            // Persist first. If that worked there is nothing left to lose, so
            // do not interrupt the user with a dialog they cannot act on --
            // which is what the original handler did on every single change.
            const saved = saveNote(true);
            if (saved && !state.dirty) return;
            e.preventDefault();
            e.returnValue = '';
        });

        // manifest.json advertises a "New note" shortcut at ./?action=new.
        // Without this it just opened the app, so honour it — and drop the
        // param so a refresh does not immediately create another note.
        const wantsNew = new URLSearchParams(location.search).get('action') === 'new';
        if (wantsNew) {
            if (location.search) {
                history.replaceState(null, '', location.pathname + location.hash);
            }
            newNote();
        } else if (!storage.getNotes().length) {
            newNote();
        } else {
            openNote(storage.getActiveNote() || storage.getNotes()[0].id);
        }

        registerServiceWorker();

        console.info('pro-notes-book ready');
    }

    /**
     * Register sw.js for offline use.
     *
     * Best-effort by design: registration needs a secure context, so it is
     * skipped on file:// and on plain http:// origins other than localhost.
     * Failure is not an error worth surfacing — the app already works without
     * it, just without the offline cache.
     */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (!window.isSecureContext) return;
        if (location.protocol === 'file:') return;

        // Relative so the same build works at / and at /<user>.github.io/<repo>/.
        navigator.serviceWorker.register('sw.js').then((reg) => {
            // A new worker waits behind any open tab. Surface the reload
            // rather than silently serving a stale cache until every tab
            // closes.
            reg.addEventListener('updatefound', () => {
                const incoming = reg.installing;
                if (!incoming) return;
                incoming.addEventListener('statechange', () => {
                    // controller is null on the very first install: there is
                    // nothing to update from, so stay quiet.
                    if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
                        offerUpdate(incoming);
                    }
                });
            });
        }).catch((err) => {
            console.warn('service worker registration failed', err);
        });
    }

    /* -------------------------------------------------------------- bindings */

    function bind() {
        $('new-note-btn').onclick = newNote;
        $('new-notebook-btn').onclick = newNotebook;
        $('save-note-btn').onclick = () => saveNote();
        $('delete-note-btn').onclick = deleteNote;
        $('preview-toggle').onclick = togglePreview;
        $('agent-toggle').onclick = toggleAgent;
        $('close-agent').onclick = () => $('agent-panel').classList.add('hidden');
        // Send and Enter are bound by AgentManager itself; binding them here
        // too fired send() twice per click.
        $('export-btn').onclick = exportBackup;
        $('import-btn').onclick = () => $('import-input').click();

        $('import-input').onchange = (e) => {
            const file = e.target.files[0];
            if (file) importBackup(file);
            e.target.value = ''; // allow re-picking the same file
        };

        $('note-title').oninput = onEdit;
        $('note-content').oninput = onEdit;

        // Rows are rebuilt on every render, so delegate from the container.
        $('notebook-list').onclick = (e) => {
            const del = e.target.closest('.notebook-del');
            if (del) return removeNotebook(del.dataset.id);
            const row = e.target.closest('.notebook-item');
            if (row) filterNotebook(row.dataset.id || null);
        };
        $('tag-list').onclick = (e) => {
            const row = e.target.closest('.tag-item');
            if (row) filterTag(row.dataset.tag);
        };
        $('note-list').onclick = (e) => {
            const row = e.target.closest('.note-row');
            if (row) openNote(row.dataset.id);
        };

        // mousedown, not click: click blurs the textarea and collapses the
        // selection before the action can read it. And read the action off the
        // button, not e.target — the buttons wrap their glyphs in <strong> /
        // <em>, so e.target is the inner element and has no data-action.
        document.querySelectorAll('.toolbar-btn[data-action]').forEach((btn) => {
            btn.onmousedown = (e) => {
                e.preventDefault();
                format(btn.dataset.action);
            };
        });

        // SearchManager dispatches this when a result row is clicked.
        window.addEventListener('select-note', (e) => openNote(e.detail.id));

        document.addEventListener('keydown', onShortcut);
    }

    function onShortcut(e) {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase(); // 'S' when Shift is held

        if (mod && e.altKey && key === 'n') {           // plain Ctrl+N is a
            e.preventDefault();                           // reserved browser
            return newNote();                             // shortcut
        }
        if (!mod) return;

        const inEditor = document.activeElement === $('note-content');

        if (key === 's') { e.preventDefault(); saveNote(); }
        else if (key === 'k' && !inEditor) { e.preventDefault(); $('search-input').focus(); }
        else if (key === 'p') { e.preventDefault(); togglePreview(); }
        else if (key === 'b' && inEditor) { e.preventDefault(); format('bold'); }
        else if (key === 'i' && inEditor) { e.preventDefault(); format('italic'); }
    }

    function onEdit() {
        // An edit with no note behind it means the user started writing after
        // a filter hid everything; give the text a note to live in.
        if (!state.note) adoptOrphanEdits();

        state.dirty = true;
        updateSaveButton();

        // Debounced, not setInterval: one pending write per burst of typing,
        // and only when something actually changed.
        const settings = storage.getSettings();
        if (settings.autoSave === false) return;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => {
            if (state.dirty) saveNote(true);
        }, Number(settings.autoSaveInterval) || AUTOSAVE_DEFAULT_MS);

        if (state.preview) renderPreview();
    }

    /* ----------------------------------------------------------------- notes */

    function newNote() {
        if (state.dirty) saveNote(true);

        // id stays null: nothing is written until the first save, so abandoned
        // drafts don't pile up as blank records.
        state.note = { id: null, title: '', content: '', tags: [], notebook: homeNotebook() };
        state.dirty = false;

        $('note-title').value = '';
        $('note-content').value = '';
        renderPreview();
        render();
        $('note-title').focus();
    }

    /**
     * Where a new note lives: the selected notebook, else the fallback one.
     * Not a hardcoded 'default' — that notebook can be deleted, or be absent
     * after a "replace all" import, and a note pointing at it would only ever
     * show up under All Notes.
     */
    function homeNotebook() {
        const selected = state.notebook &&
            storage.getNotebooks().some((b) => b.id === state.notebook);
        return selected ? state.notebook : storage.fallbackNotebookId();
    }

    function openNote(id) {
        const note = storage.getNote(id);
        if (!note) return;

        // Only flush a note that actually exists; an unsaved draft has a null
        // id and saving it would create a duplicate.
        if (state.dirty && state.note && state.note.id && state.note.id !== id) {
            saveNote(true);
        }

        state.note = {
            id: note.id,
            title: note.title || '',
            content: note.content || '',
            tags: Array.isArray(note.tags) ? note.tags : [],
            notebook: note.notebook || 'default'
        };
        state.dirty = false;
        // Follow the note only when a DIFFERENT notebook is selected (e.g. it
        // was opened from search), so it is visible in the list. Assigning
        // unconditionally made "All Notes" unusable: selecting it opens the
        // first note, which immediately switched the filter back to that
        // note's notebook, and it narrowed tag filters the same way.
        if (state.notebook && state.notebook !== state.note.notebook) {
            state.notebook = state.note.notebook;
        }

        $('note-title').value = state.note.title;
        $('note-content').value = state.note.content;
        storage.setActiveNote(id);
        renderPreview();
        render();
    }

    /** A 'storage' event: another tab changed notes or notebooks. */
    function onExternalChange(e) {
        // key is null when another tab called localStorage.clear().
        if (e.key !== null && e.key !== storage.notesKey && e.key !== storage.notebooksKey) return;

        // Unsaved edits here would silently overwrite the other tab's version
        // of the same note on the next save. Keep the edits, but say so.
        if (state.dirty && state.note && state.note.id && e.key !== storage.notebooksKey) {
            const theirs = storage.getNote(state.note.id);
            if (theirs && theirs.content !== state.note.content) {
                ui('This note was changed in another tab — saving here will overwrite it.', 'warn');
            }
        }

        if (state.notebook && !storage.getNotebooks().some((b) => b.id === state.notebook)) {
            state.notebook = null; // the selected notebook was deleted elsewhere
        }
        window.dispatchEvent(new CustomEvent('notes-updated', { detail: { storage } }));
    }

    function syncEditor() {
        if (!state.note || !state.note.id) return;
        const note = storage.getNote(state.note.id);
        if (!note) return;
        state.note.title = note.title || '';
        state.note.content = note.content || '';
        $('note-title').value = state.note.title;
        $('note-content').value = state.note.content;
        renderPreview();
    }

    function restoreOpenNote() {
        const id = storage.getActiveNote();
        if (id && !storage.getNote(id)) storage.setActiveNote(null); // stale pointer
    }

    function saveNote(silent = false) {
        if (!state.note) return null;

        const title = $('note-title').value.trim();
        const content = $('note-content').value;

        if (!title && !content.trim()) {
            if (!silent) ui('Nothing to save.', 'warn');
            return null;
        }

        state.note.title = title || firstLine(content) || 'Untitled';
        state.note.content = content;
        state.note.tags = extractTags(content);
        // notebook is NOT reassigned from state.notebook. Doing so moved
        // notes between notebooks whenever the sidebar selection and the open
        // note disagreed; the note's own notebook is authoritative.

        const saved = storage.saveNote(state.note);
        if (!saved) return null; // storage already reported why

        state.note.id = saved.id; // adopt the generated id
        state.dirty = false;
        storage.setActiveNote(saved.id);
        render();

        if (!silent) ui('Saved.', 'ok');
        return saved;
    }

    function deleteNote() {
        if (!state.note) return;
        if (!state.note.id) return newNote(); // never saved

        if (!confirm(`Delete "${state.note.title || 'Untitled'}"?`)) return;

        const wasActive = state.note.id;
        state.dirty = false; // before the event, so the handler can sync
        storage.deleteNote(wasActive);
        storage.setActiveNote(null);

        const next = visibleNotes()[0];
        if (next) openNote(next.id);
        else newNote();

        ui('Note deleted.', 'ok');
    }

    function extractTags(content) {
        const found = String(content).match(/(^|\s)#([\w-]{1,50})/g) || [];
        return [...new Set(found.map((m) => m.trim().slice(1).toLowerCase()))];
    }

    function firstLine(text) {
        const line = text.split('\n').find((l) => l.trim());
        return line ? line.replace(/^#+\s*/, '').trim().slice(0, 60) : '';
    }

    function updateSaveButton() {
        const btn = $('save-note-btn');
        btn.disabled = !state.dirty;
        btn.textContent = state.dirty ? 'Save •' : 'Save';
    }

    /* -------------------------------------------------------------- notebooks */

    function newNotebook() {
        const name = prompt('Notebook name:');
        if (name === null) return;
        if (!name.trim()) return ui('Name cannot be empty.', 'warn');

        const colors = ['#00ffcc', '#ff00ff', '#ffff00', '#00aaff', '#ff3366', '#00ff88'];
        storage.saveNotebook({
            name: name.trim(),
            color: colors[Math.floor(Math.random() * colors.length)]
        });
        render();
    }

    function removeNotebook(id) {
        const book = storage.getNotebooks().find((b) => b.id === id);
        if (!book) return;
        if (!confirm(`Delete "${book.name}"? Its notes move to another notebook.`)) return;

        const res = storage.deleteNotebook(id);
        if (!res) return; // refused (last notebook); storage already said so

        if (state.notebook === id) state.notebook = null;
        render();
        ui(res.movedCount ? `Deleted, ${res.movedCount} note(s) moved.` : 'Notebook deleted.', 'ok');
    }

    /**
     * Blank the editor when a filter hides every note.
     *
     * Leaving the previous note on screen under a filter that excludes it is
     * misleading, and it is a data-loss bug: the note stays loaded while
     * state.notebook now points at the new filter, so the next autosave
     * writes it into the wrong notebook. Callers flush any pending edit
     * BEFORE calling this, so nothing typed is discarded here.
     */
    function clearEditor() {
        state.note = null;
        state.dirty = false;
        $('note-title').value = '';
        $('note-content').value = '';
        $('note-preview').innerHTML = '';
        $('note-list').querySelectorAll('.note-item.active')
            .forEach(el => el.classList.remove('active'));
        updateSaveButton();
    }

    /**
     * Typing into an editor with no note behind it means the user started
     * writing after a filter hid everything. Adopt the text as a new unsaved
     * note in the current filter scope instead of dropping it on the next
     * navigation. render() only redraws lists, so the typed text is left
     * untouched.
     */
    function adoptOrphanEdits() {
        const title = $('note-title').value;
        const content = $('note-content').value;
        if (!title && !content) return;

        const now = new Date().toISOString();
        state.note = {
            id: null,
            title: '',
            content: '',
            tags: [],
            notebook: homeNotebook(),
            createdAt: now,
            updatedAt: now
        };
        render();
    }

    function filterNotebook(id) {
        state.notebook = id;
        state.tag = null;
        if (state.dirty) saveNote(true);
        render();

        const first = visibleNotes()[0];
        if (first) openNote(first.id);
        else clearEditor();
    }

    function filterTag(tag) {
        state.tag = state.tag === tag ? null : tag; // toggle
        state.notebook = null;
        if (state.dirty) saveNote(true);
        render();

        const first = visibleNotes()[0];
        if (first) openNote(first.id);
        else {
            clearEditor();
            if (state.tag) ui(`No notes with #${state.tag} — press Ctrl+Alt+N to add one`, 'warn');
        }
    }

    /* --------------------------------------------------------------- rendering */

    function visibleNotes() {
        let notes = storage.getNotes();
        if (state.notebook) notes = notes.filter((n) => n.notebook === state.notebook);
        if (state.tag) {
            notes = notes.filter((n) =>
                Array.isArray(n.tags) && n.tags.some((t) => String(t).toLowerCase() === state.tag));
        }
        return notes.sort((a, b) =>
            String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    }

    function render() {
        renderNotebooks();
        renderTags();
        renderNotes();
        updateSaveButton();
    }

    function renderNotebooks() {
        const list = $('notebook-list');
        const notes = storage.getNotes();
        // Null-prototype: n.notebook comes from imported JSON, so a backup
        // containing "__proto__" would otherwise lose that notebook's count.
        const counts = Object.create(null);
        notes.forEach((n) => { counts[n.notebook] = (counts[n.notebook] || 0) + 1; });

        list.textContent = '';
        list.appendChild(notebookRow(
            { id: null, name: 'All Notes', color: '#00ffcc' },
            state.notebook === null, notes.length
        ));
        storage.getNotebooks().forEach((b) => {
            list.appendChild(notebookRow(b, state.notebook === b.id, counts[b.id] || 0));
        });
    }

    function notebookRow(book, active, count) {
        const row = el('div', 'notebook-item' + (active ? ' active' : ''));
        row.dataset.id = book.id || '';
        row.tabIndex = 0;

        const swatch = el('span', 'notebook-swatch');
        swatch.style.background = safeColor(book.color);
        row.append(swatch, el('span', 'notebook-name', book.name), el('span', 'notebook-count', count));

        if (book.id) {
            const del = el('button', 'btn-icon notebook-del', '×');
            del.dataset.id = book.id;
            del.title = 'Delete notebook';
            row.appendChild(del);
        }

        // Clicks are handled by the delegated listener on #notebook-list. A
        // row.onclick here as well fired filterNotebook twice, and ran before
        // the delete button's handler, so pressing × switched notebooks even
        // when the user then cancelled the confirm.
        row.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
        };
        return row;
    }

    function renderTags() {
        const list = $('tag-list');
        const inUse = storage.getTagsInUse();
        list.textContent = '';

        if (!inUse.length) {
            list.appendChild(el('div', 'list-empty', '#tags in note text appear here'));
            return;
        }

        inUse.forEach(({ tag, count }) => {
            const row = el('div', 'tag-item' + (state.tag === tag ? ' active' : ''));
            row.dataset.tag = tag;
            row.tabIndex = 0;
            row.append(
                el('span', 'tag-name', tag),  // .tag-name::before supplies the '#'
                el('span', 'tag-count', count)
            );
            row.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
            };
            list.appendChild(row);
        });
    }

    function renderNotes() {
        const list = $('note-list');
        const notes = visibleNotes();
        list.textContent = '';
        $('note-list-count').textContent = state.tag ? '#' + state.tag : notes.length;

        if (!notes.length) {
            list.appendChild(el('div', 'list-empty', 'No notes here yet'));
            return;
        }

        notes.forEach((note) => {
            const row = el('div',
                'notebook-item note-row' + (note.id === (state.note && state.note.id) ? ' active' : ''));
            row.dataset.id = note.id;
            row.tabIndex = 0;
            row.append(
                el('span', 'notebook-name', note.title || 'Untitled'),
                el('span', 'notebook-count', ago(note.updatedAt))
            );
            row.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
            };
            list.appendChild(row);
        });
    }

    function ago(iso) {
        const then = new Date(iso).getTime();
        if (!iso || isNaN(then)) return '';
        const secs = (Date.now() - then) / 1000;
        if (secs < 60) return 'now';
        if (secs < 3600) return Math.floor(secs / 60) + 'm';
        if (secs < 86400) return Math.floor(secs / 3600) + 'h';
        if (secs < 604800) return Math.floor(secs / 86400) + 'd';
        return new Date(iso).toISOString().slice(0, 10);
    }

    /* ---------------------------------------------------------------- markdown */

    function togglePreview() {
        state.preview = !state.preview;
        $('note-content').classList.toggle('hidden', state.preview);
        $('note-preview').classList.toggle('hidden', !state.preview);
        $('preview-toggle').classList.toggle('active', state.preview);
        $('preview-toggle').textContent = state.preview ? 'Edit' : 'Preview';
        if (state.preview) renderPreview();
    }

    function renderPreview() {
        if (!state.preview) return;
        const box = $('note-preview');
        box.innerHTML = renderMarkdown($('note-content').value);
        // marked emits no rel, so a note's links would get a window.opener
        // handle. Modern browsers imply noopener for target=_blank, so this is
        // belt-and-braces.
        box.querySelectorAll('a[href]').forEach((a) => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer nofollow');
        });
    }

    /**
     * marked -> DOMPurify. Both are vendored and precached, but either can
     * still be absent (an SRI mismatch blocks it, or the service worker could
     * not cache it). The fallback is escaped plain text, never un-sanitised
     * HTML.
     */
    function renderMarkdown(src) {
        const text = String(src || '');
        if (!text.trim()) return '<p class="preview-empty">Nothing to preview.</p>';

        if (!window.marked || !window.DOMPurify) {
            console.warn('preview: marked/DOMPurify unavailable (offline?) — plain text');
            return '<pre>' + NB.escapeHtml(text) + '</pre>';
        }

        let html;
        try {
            html = marked.parse(text, { gfm: true, breaks: true });
        } catch (err) {
            console.error('preview: marked failed', err);
            return '<pre>' + NB.escapeHtml(text) + '</pre>';
        }

        try {
            return DOMPurify.sanitize(html, {
                ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
                    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
                    'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
                // No `src`. Images are deliberately NOT allowed in the preview:
                //   - a remote <img> is a beacon. Every preview open would tell a
                //     third party the IP, UA and exact time the note was read,
                //     which is incompatible with a local-first app;
                //   - a data: <img> survives ALLOWED_URI_REGEXP regardless
                //     (DOMPurify's ADD_DATA_URI_TAGS is *added to* the allowed
                //     set, not replaced by it), so a note could embed an
                //     arbitrary inline blob and quietly consume the storage
                //     quota;
                //   - neither works offline anyway.
                // Re-enable by adding 'img' and 'src' to the two lists above.
                ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'align'],
                // Blocks javascript: and data: in href.
                ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
                FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'img', 'base', 'meta', 'link', 'svg', 'math'],
                FORBID_ATTR: ['style', 'srcset', 'ping', 'onerror', 'onload'],
                // No ADD_ATTR for target/rel: those are deliberately NOT in
                // ALLOWED_ATTR, so they are stripped from the input and
                // re-applied with a known-safe rel after sanitising.
                ALLOW_DATA_ATTR: false
            });
        } catch (err) {
            console.error('preview: sanitize failed', err);
            return '<pre>' + NB.escapeHtml(text) + '</pre>';
        }
    }

    /* ---------------------------------------------------------------- toolbar */

    const FORMATS = {
        bold: ['**', '**', 'bold text'],
        italic: ['*', '*', 'italic text'],
        heading: ['## ', '', 'Heading'],
        list: ['- ', '', 'List item'],
        link: ['[', '](https://)', 'link text']
    };

    function format(action) {
        const spec = FORMATS[action];
        const ta = $('note-content');
        if (!spec) return;

        const [before, after, placeholder] = spec;
        const value = ta.value;
        const selEnd = ta.selectionEnd == null ? value.length : ta.selectionEnd;
        const selStart = ta.selectionStart == null ? selEnd : ta.selectionStart;
        const block = action === 'heading' || action === 'list';

        let start = selStart;
        let text;
        let prefix = '';

        if (block && selStart === selEnd) {
            // Collapsed cursor: a block prefix mid-line renders as literal
            // text, so start a fresh line after the current one rather than
            // reformatting the line the cursor happens to sit in.
            const lineEnd = value.indexOf('\n', selEnd);
            start = lineEnd === -1 ? value.length : lineEnd + 1;
            prefix = start > 0 ? '\n' : '';
            text = placeholder;
        } else if (block) {
            // With a selection, apply the prefix from the start of the line.
            start = value.lastIndexOf('\n', selStart - 1) + 1;
            text = value.slice(start, selEnd);
        } else {
            // Inline formats: no selection means insert a selected placeholder,
            // so typing overwrites it instead of appending after a literal
            // "bold text".
            text = value.slice(selStart, selEnd) || placeholder;
        }

        const insert = prefix + before;
        ta.value = value.slice(0, start) + insert + text + after + value.slice(selEnd);

        const from = start + insert.length;
        ta.focus();
        ta.setSelectionRange(from, from + text.length);
        onEdit();
    }

    /* ------------------------------------------------------------------ agent */

    function toggleAgent() {
        const panel = $('agent-panel');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) agents.focus();
    }

    /* ---------------------------------------------------------- import/export */

    function exportBackup() {
        const blob = new Blob(
            [JSON.stringify(storage.exportData(), null, 2)],
            { type: 'application/json' }
        );
        const url = URL.createObjectURL(blob);
        const a = el('a');
        a.href = url;
        a.download = `pro-notes-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        // Revoke next tick — revoking synchronously cancels the download.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        ui(`Exported ${storage.getNotes().length} note(s).`, 'ok');
    }

    function importBackup(file) {
        if (file.size > 20 * 1024 * 1024) return ui('File too large (max 20 MB).', 'err');

        const reader = new FileReader();
        reader.onload = () => {
            let data;
            try {
                data = JSON.parse(reader.result);
            } catch (err) {
                return ui('Not valid JSON: ' + err.message, 'err');
            }

            // Commit any pending edit BEFORE the confirm. Autosave is
            // debounced, so an import could otherwise wipe a half-written
            // note with no prompt and no undo.
            if (state.dirty) saveNote(true);

            const merge = confirm('Merge with existing notes?\n\nOK = merge, Cancel = replace all.');

            let res;
            try {
                res = storage.importData(data, { merge });
            } catch (err) {
                // importData normalises hostile input, but a throw here would
                // otherwise vanish inside the FileReader callback.
                console.error('import failed', err);
                return ui('Import failed: ' + err.message, 'err');
            }
            if (!res.ok) return; // storage already reported why

            state.note = null;
            state.dirty = false;
            // "Replace all" can remove the selected notebook.
            if (state.notebook && !storage.getNotebooks().some((b) => b.id === state.notebook)) {
                state.notebook = null;
            }
            $('note-title').value = '';
            $('note-content').value = '';

            const first = visibleNotes()[0];
            if (first) openNote(first.id);
            else newNote();

            ui(`Imported ${res.imported} note(s).`, 'ok');
        };
        reader.onerror = () => ui('Could not read the file.', 'err');
        reader.readAsText(file);
    }

    function applyFontSize() {
        const sizes = { small: '0.85rem', medium: '0.95rem', large: '1.1rem' };
        const size = storage.getSettings().fontSize;
        $('note-content').style.fontSize = sizes[size] || sizes.medium;
    }

    /* ----------------------------------------------------------------- status */

    let statusTimer = null;

    /** Kinds that have a matching .status-* rule in components.css. */
    const STATUS_KINDS = ['ok', 'warn', 'err', 'info'];

    function ui(message, kind) {
        const box = $('status');
        // An unknown kind would produce class "status-typo", which matches no
        // rule and looks like the message silently failed to apply.
        const safeKind = STATUS_KINDS.includes(kind) ? kind : '';
        box.textContent = message;
        box.className = 'status' + (safeKind ? ' status-' + safeKind : '');
        // Clear any actionable affordance: ui() overwrites className, so a
        // leftover onclick would leave an invisible click target.
        box.onclick = null;
        box.tabIndex = -1;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { box.textContent = ''; }, kind === 'err' ? 6000 : 2500);
    }

    /**
     * A new service worker finished installing and is waiting. The old one
     * keeps serving this tab until every tab closes, so surface the reload
     * instead of reloading underneath someone mid-sentence.
     */
    function offerUpdate(worker) {
        const box = $('status');
        clearTimeout(statusTimer);
        box.textContent = 'Update ready — click to reload';
        box.className = 'status status-info status-action';
        box.tabIndex = 0;

        const apply = () => {
            // Reload only once the new worker has actually taken control,
            // otherwise the reload races back onto the old cache.
            navigator.serviceWorker.addEventListener('controllerchange',
                () => location.reload(), { once: true });
            worker.postMessage('skipWaiting');
        };

        box.onclick = apply;
        box.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
        };
    }

    /* ------------------------------------------------------------------ boot */

    window.NB = window.NB || {};
    // Merge, don't replace: search.js and agents.js have already put
    // SearchManager and AgentManager on NB, and assigning a fresh object here
    // would drop them.
    Object.assign(window.NB, {
        ui,
        app: {
            getState: () => state,
            getSearch: () => search,
            getAgent: () => agents,
            // What the user sees, not the last save: state.note only catches up
            // with the editor on save, so an agent command issued between
            // typing and autosave used to act on stale text.
            getCurrentNoteSnapshot: () => (state.note ? {
                ...state.note,
                title: $('note-title').value.trim() || state.note.title,
                content: $('note-content').value
            } : null),
            saveNote: (silent) => saveNote(silent),
            newNote,
            openNote,
            renderMarkdown
        }
    });

    window.NB.escapeHtml = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
