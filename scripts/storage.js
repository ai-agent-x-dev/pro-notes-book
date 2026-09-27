/* storage.js — localStorage wrapper.
 *
 * Two things the raw API gets wrong and this fixes:
 *   - setItem throws QuotaExceededError. Unhandled, that kills the save path
 *     with no user feedback, so every write is guarded.
 *   - JSON.parse throws on a corrupt value. Also guarded, with the bad value
 *     left in place so it can still be recovered by hand.
 *
 * Imported data is NOT deeply validated here. Every render path in app.js
 * writes with textContent, so a hostile backup's strings display as text
 * rather than executing — escaping at the sink, not validating at the source.
 */

/** The fallback notebook. Referenced by id from three places; keep it single. */
const DEFAULT_NOTEBOOK = { id: 'default', name: 'Default', color: '#00ffcc' };

class StorageManager {
    constructor() {
        this.notesKey = 'pro-notes-notes';
        this.notebooksKey = 'pro-notes-notebooks';
        this.tagsKey = 'pro-notes-tags';
        this.settingsKey = 'pro-notes-settings';
        this.activeKey = 'pro-notes-active';
        this.init();
    }

    init() {
        const seed = {
            [this.notesKey]: [],
            // Seeding Default means a note can never reference a notebook that
            // does not exist.
            [this.notebooksKey]: [{ ...DEFAULT_NOTEBOOK }],
            [this.tagsKey]: [],
            [this.settingsKey]: {
                theme: 'dark',
                fontSize: 'medium',
                autoSave: true,
                autoSaveInterval: 2000
            }
        };
        Object.keys(seed).forEach(key => {
            if (!localStorage.getItem(key)) this.write(key, seed[key]);
        });

        // Earlier versions seeded a 30 s autosave, which lost up to half a
        // minute of typing when a tab was killed. Nothing in the UI sets this
        // value, so exactly 30000 can only be the old seed: move it forward.
        if (this.getSettings().autoSaveInterval === 30000) {
            this.set({ autoSaveInterval: 2000 });
        }
    }

    /* ------------------------------------------------------------- primitives */

    read(key, fallback) {
        let raw = null;
        try {
            raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (err) {
            console.error(`storage: bad data in "${key}"`, err);
            this.quarantine(key, raw);
            return fallback;
        }
    }

    /**
     * Preserve an unparseable value before anything overwrites it.
     *
     * Without this the file header's promise is hollow: the corrupt value
     * survives only until the next successful setNotes(), which is at most
     * one autosave away. Single-slot rather than timestamped so a repeated
     * failure cannot fill the quota it is trying to protect.
     */
    quarantine(key, raw) {
        if (!raw) return;
        try {
            localStorage.setItem(key + '.corrupt', raw);
        } catch (err) {
            // Quota is exactly the situation where a second copy is least
            // welcome. The original value is still untouched.
            console.warn(`storage: could not quarantine corrupt "${key}"`, err);
        }
    }

    write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (err) {
            const quota = err && /quota/i.test(err.name || '');
            console.error(`storage: write to "${key}" failed`, err);
            this.fail(quota
                ? 'Storage full — export a backup, then delete some notes.'
                : 'Cannot write to local storage (private browsing?)');
            return false;
        }
    }

    /** Surfaces a problem without storage.js needing to know about the DOM. */
    fail(message) {
        window.dispatchEvent(new CustomEvent('storage-error', { detail: { message } }));
    }

    event(type) {
        window.dispatchEvent(new CustomEvent(type, { detail: { storage: this } }));
    }

    /* ------------------------------------------------------------------ notes */

    getNotes() {
        const notes = this.read(this.notesKey, []);
        return Array.isArray(notes) ? notes : [];
    }

    setNotes(notes) {
        if (!this.write(this.notesKey, notes)) return false;
        this.event('notes-updated');
        return true;
    }

    getNote(id) {
        return this.getNotes().find(n => n.id === id) || null;
    }

    /** @returns {object|null} the stored record, or null if the write failed */
    saveNote(note) {
        if (!note || typeof note !== 'object') return null;

        const now = new Date().toISOString();
        const notes = this.getNotes();
        const index = notes.findIndex(n => n.id === note.id);

        let record;
        if (index >= 0) {
            // Spread the stored note first so createdAt survives: the caller
            // does not carry it.
            record = { ...notes[index], ...note, updatedAt: now };
            notes[index] = record;
        } else {
            record = {
                tags: [],
                notebook: this.fallbackNotebookId(),
                ...note,
                id: note.id || this.generateId(),
                createdAt: now,
                updatedAt: now
            };
            notes.push(record);
        }

        return this.setNotes(notes) ? record : null;
    }

    deleteNote(id) {
        return this.setNotes(this.getNotes().filter(n => n.id !== id));
    }

    /* -------------------------------------------------------------- notebooks */

    getNotebooks() {
        const books = this.read(this.notebooksKey, []);
        return Array.isArray(books) ? books : [];
    }

    /** @returns {object|null} the stored record (with its id), or null if the write failed */
    saveNotebook(notebook) {
        if (!notebook || typeof notebook !== 'object') return null;
        const books = this.getNotebooks();
        const index = books.findIndex(b => b.id === notebook.id);

        let record;
        if (index >= 0) {
            record = { ...books[index], ...notebook };
            books[index] = record;
        } else {
            record = { ...DEFAULT_NOTEBOOK, ...notebook, id: notebook.id || this.generateId() };
            books.push(record);
        }

        if (!this.write(this.notebooksKey, books)) return null;
        this.event('notebooks-updated');
        return record;
    }

    /**
     * The notebook a note goes to when nothing more specific applies:
     * 'default' while it exists, else the first notebook. 'default' is not
     * guaranteed — the user can delete it, and a "replace all" import may not
     * contain it.
     */
    fallbackNotebookId() {
        const books = this.getNotebooks();
        if (books.some(b => b.id === DEFAULT_NOTEBOOK.id)) return DEFAULT_NOTEBOOK.id;
        return books.length ? books[0].id : DEFAULT_NOTEBOOK.id;
    }

    /**
     * Refuses to remove the last notebook, and re-homes its notes rather than
     * deleting them — deleting user data as a side effect is not acceptable.
     *
     * @returns {{movedCount: number, movedTo: string}|false} false = refused
     */
    deleteNotebook(id) {
        const books = this.getNotebooks();
        if (books.length <= 1) {
            this.fail('Cannot delete the only notebook.');
            return false;
        }

        const remaining = books.filter(b => b.id !== id);
        if (remaining.length === books.length) return false;

        const target = remaining[0].id;
        const notes = this.getNotes();
        let movedCount = 0;

        const rehomed = notes.map(n => {
            if (n.notebook !== id) return n;
            movedCount++;
            return { ...n, notebook: target };
        });

        // Notes first, and stop if that fails: removing the notebook while its
        // notes still point at it would orphan them.
        if (!this.setNotes(rehomed)) return false;
        if (!this.write(this.notebooksKey, remaining)) return false;
        this.event('notebooks-updated');
        return { movedCount, movedTo: target };
    }

    /* ------------------------------------------------------------------- tags */

    /** Tags come from note text, so this is the sidebar's source of truth. */
    getTagsInUse() {
        // Null-prototype: tag names come from note text, and a note tagged
        // #constructor would otherwise read Object.prototype.constructor,
        // turning the count into a string and the sort comparator into NaN.
        const counts = Object.create(null);
        this.getNotes().forEach(note => {
            (Array.isArray(note.tags) ? note.tags : []).forEach(tag => {
                const key = String(tag).toLowerCase();
                if (!key) return;
                counts[key] = (counts[key] || 0) + 1;
            });
        });
        return Object.entries(counts)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    /* --------------------------------------------------------------- settings */

    getSettings() {
        const s = this.read(this.settingsKey, {});
        return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    }

    set(patch) {
        const next = { ...this.getSettings(), ...patch };
        if (!this.write(this.settingsKey, next)) return null;
        this.event('settings-updated');
        return next;
    }

    /* ------------------------------------------------------------------ misc */

    generateId() {
        // randomUUID is unavailable in insecure contexts (http:// on a LAN IP).
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    /** Which note to reopen on next load. */
    getActiveNote() {
        return this.read(this.activeKey, null);
    }

    setActiveNote(id) {
        return this.write(this.activeKey, id);
    }

    /* ---------------------------------------------------------- export/import */

    exportData() {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            notes: this.getNotes(),
            notebooks: this.getNotebooks(),
            settings: this.getSettings()
        };
    }

    /**
     * @param {object} data parsed from a backup file
     * @param {{merge?: boolean}} [opts] merge keeps existing notes
     */
    importData(data, opts = {}) {
        const fail = (error) => {
            this.fail('Import failed: ' + error);
            return { ok: false, error };
        };

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return fail('expected a JSON object');
        }
        if (data.notes !== undefined && !Array.isArray(data.notes)) {
            return fail('"notes" must be an array');
        }

        const now = new Date().toISOString();
        const id = () => this.generateId();

        // Normalise to the shape the app expects. String fields are coerced
        // rather than rejected — a backup with a numeric title should import,
        // not abort. A null/primitive element is dropped rather than allowed
        // to throw: this runs inside FileReader.onload, which nothing wraps,
        // so a single bad element would abort the whole import in silence.
        const incoming = (data.notes || [])
            .filter(n => n && typeof n === 'object')
            .map(n => ({
                id: typeof n.id === 'string' && n.id ? n.id : id(),
                title: String(n.title == null ? '' : n.title).slice(0, 500),
                // Capped: an uncapped body is both a preview-freeze risk and
                // the most likely way to blow the storage quota.
                content: String(n.content == null ? '' : n.content).slice(0, 200000),
                tags: (Array.isArray(n.tags) ? n.tags : [])
                    .map(t => String(t).toLowerCase().slice(0, 50))
                    .slice(0, 50),
                notebook: typeof n.notebook === 'string' ? n.notebook : 'default',
                createdAt: n.createdAt || now,
                updatedAt: n.updatedAt || now
            }));

        // Re-key on collision, or two records share an id: a merge would
        // silently overwrite, and a file with duplicate ids would leave notes
        // that open, save and delete as one. Applies to both modes.
        const existing = this.getNotes();
        const seen = new Set(opts.merge ? existing.map(n => n.id) : []);
        const rekeyed = incoming.map(n => {
            if (!seen.has(n.id)) { seen.add(n.id); return n; }
            return { ...n, id: id() };
        });
        const finalNotes = opts.merge ? existing.concat(rekeyed) : rekeyed;

        const books = this.getNotebooks();
        const seenBooks = new Set();
        const incomingBooks = (Array.isArray(data.notebooks) ? data.notebooks : [])
            .filter(b => b && typeof b.id === 'string' && b.id)
            // A duplicate notebook id keeps the first entry only.
            .filter(b => !seenBooks.has(b.id) && seenBooks.add(b.id))
            .map(b => ({
                id: b.id,
                name: String(b.name == null || b.name === '' ? 'Notebook' : b.name).slice(0, 120),
                color: b.color
            }));

        let finalBooks;
        if (opts.merge) {
            // Merge keeps every existing notebook and only adds new ones.
            const known = new Set(books.map(b => b.id));
            finalBooks = books.concat(incomingBooks.filter(b => !known.has(b.id)));
        } else {
            // "Replace all" (the Cancel branch of the import prompt): the file
            // wins outright. Conflating this with merge silently resurrects
            // notebooks the user thought they had removed.
            finalBooks = incomingBooks;
        }

        // A note must never be left pointing at a notebook that does not
        // exist, or it disappears from every filter. Re-home orphans onto the
        // first notebook, creating a default when the file carried none.
        const knownIds = new Set(finalBooks.map(b => b.id));
        if (finalNotes.some(n => !knownIds.has(n.notebook))) {
            if (!finalBooks.length) {
                finalBooks = [{ ...DEFAULT_NOTEBOOK }];
                knownIds.add('default');
            }
            const fallback = finalBooks[0].id;
            finalNotes.forEach(n => {
                if (!knownIds.has(n.notebook)) n.notebook = fallback;
            });
        }

        // Check every write. Reporting success after a failed write is the
        // worst outcome here: the caller clears the editor and congratulates
        // the user while their notes were never stored.
        if (!this.setNotes(finalNotes)) {
            return fail('Not enough storage — nothing was imported. Export a backup and free some space.');
        }
        if (!this.write(this.notebooksKey, finalBooks)) {
            return fail('Notebooks could not be saved — nothing was imported.');
        }
        // Settings are only adopted on a full replace. A "merge" that quietly
        // resets your theme and autosave interval is not a merge.
        if (!opts.merge && data.settings && typeof data.settings === 'object') {
            if (!this.write(this.settingsKey, { ...this.getSettings(), ...data.settings })) {
                return fail('Settings could not be saved — nothing was imported.');
            }
        }

        return { ok: true, imported: incoming.length };
    }
}

const storage = new StorageManager();

// A top-level `const` does not create a window property, so `window.storage`
// would be undefined. Alias it explicitly: app.js and agents.js resolve the
// bare `storage` binding from the global lexical scope, and this makes the
// store reachable from devtools for debugging.
window.storage = storage;

window.addEventListener('storage-error', (e) => {
    // 'err' matches the .status-err rule; 'error' would silently fall back to
    // the unstyled base status.
    if (window.NB && NB.ui) NB.ui(e.detail.message, 'err');
});
