/* search.js — Search functionality
 *
 * Two fixes over the original draft, both security:
 *
 *   1. STORED XSS. highlightMatch() returned a string with <mark> spliced in,
 *      and displayResults() assigned it to innerHTML. Note titles and bodies
 *      are user-authored and get rendered as HTML, so a note containing
 *      `<img src=x onerror=...>` executed on every keystroke in the search box.
 *      highlight() now returns a DocumentFragment of text and <mark> nodes, so
 *      user text can only ever land in a text node.
 *
 *   2. REGEX INJECTION / ReDoS. The query was interpolated raw into
 *      new RegExp(), so typing `(` threw SyntaxError and a crafted query could
 *      backtrack catastrophically. highlight() no longer builds a regex at all:
 *      it locates matches with indexOf() over lowercased strings.
 *
 * Note: assigning the old highlight string to textContent instead of innerHTML
 * would have closed the XSS hole but rendered the <mark> tags literally, so the
 * node-based approach above is what actually preserves the highlighting.
 *
 * Also completed: the draft was cut off inside selectNote().
 *
 * Requires styles: .search-results must have an .active rule
 * (display:none -> display:block). See main.css.
 */
class SearchManager {
    constructor(storage) {
        this.storage = storage;
        this.searchInput = document.getElementById('search-input');
        this.searchResults = document.getElementById('search-results');
        // Object.create(null), not {}: searching for the word "constructor" or
        // "toString" would otherwise hit Object.prototype, and
        // this.searchIndex['constructor'].forEach is not a function.
        this.searchIndex = Object.create(null);
        this.notesById = Object.create(null);
        this.debounceTimer = null;
        this.debounceMs = 120;
        this.limit = 10;
        this.initSearch();
    }

    initSearch() {
        this.buildSearchIndex();

        window.addEventListener('notes-updated', () => this.buildSearchIndex());
        window.addEventListener('data-imported', () => this.buildSearchIndex());

        this.searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            clearTimeout(this.debounceTimer);
            if (query.length === 0) {
                this.hideResults();
                return;
            }
            // Debounced: buildSearchIndex is O(notes x words) and this fires
            // on every keystroke.
            this.debounceTimer = setTimeout(() => this.performSearch(query), this.debounceMs);
        });

        // Keyboard navigation. Without this, results are mouse-only.
        this.searchInput.addEventListener('keydown', (e) => this.onKeyDown(e));

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                this.hideResults();
            }
        });
    }

    /* ------------------------------------------------------------------ index */

    buildSearchIndex() {
        this.searchIndex = Object.create(null);
        this.notesById = Object.create(null);
        const notes = this.storage.getNotes();

        notes.forEach(note => {
            if (!note || !note.id) return;
            this.notesById[note.id] = note;

            const titleWords = this.tokenize(note.title || '');
            const contentWords = this.tokenize(note.content || '');
            const tags = (Array.isArray(note.tags) ? note.tags : []).map(t => String(t));
            const tagWords = this.tokenize(tags.join(' '));

            // Frequency map, so scoring is O(words) instead of the original's
            // O(words^2) contentWords.filter() inside the index loop.
            // Null-prototype: tokenize() keeps underscores, so a note
            // containing the word "constructor" would otherwise read
            // Object.prototype.constructor, making its score NaN and degrading
            // the ordering of every other result.
            const contentFreq = Object.create(null);
            contentWords.forEach(w => { contentFreq[w] = (contentFreq[w] || 0) + 1; });
            const titleSet = new Set(titleWords);
            const tagSet = new Set(tagWords);

            const allWords = new Set([...titleWords, ...contentWords, ...tagWords]);
            allWords.forEach(word => {
                if (!this.searchIndex[word]) this.searchIndex[word] = [];

                let score = 0;
                if (titleSet.has(word)) score += 10;              // Title: most relevant
                if (tagSet.has(word)) score += 5;                // Tags: somewhat
                score += Math.min(contentFreq[word] || 0, 25);   // Body occurrences, capped

                this.searchIndex[word].push({ id: note.id, score: score });
            });
        });
    }

    tokenize(text) {
        return String(text).toLowerCase()
            .replace(/[^\w\s#-]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 0);
    }

    /* ----------------------------------------------------------------- search */

    performSearch(query) {
        const queryWords = this.tokenize(query);
        if (!queryWords.length) {
            this.hideResults();
            return;
        }

        const results = [];
        const seen = new Set();

        // Pass 1: exact token hits from the inverted index.
        queryWords.forEach(word => {
            (this.searchIndex[word] || []).forEach(item => {
                if (seen.has(item.id)) {
                    const existing = results.find(r => r.id === item.id);
                    if (existing) existing.score += item.score;
                    return;
                }
                seen.add(item.id);
                const note = this.notesById[item.id];
                if (!note) return;
                results.push({
                    id: item.id,
                    title: note.title || 'Untitled',
                    content: this.excerpt(note.content || ''),
                    notebook: note.notebook,
                    tags: Array.isArray(note.tags) ? note.tags : [],
                    score: item.score
                });
            });
        });

        // Pass 2: prefix/substring fallback. Without this, typing "doc" never
        // matches a note containing "docker" — the index is exact-token only.
        if (results.length < this.limit) {
            const partial = queryWords.filter(w => w.length >= 2);
            Object.keys(this.notesById).forEach(id => {
                if (seen.has(id)) return;
                const note = this.notesById[id];
                const title = String(note.title || '').toLowerCase();
                const tags = (Array.isArray(note.tags) ? note.tags : []).join(' ').toLowerCase();
                const match = partial.find(w => title.includes(w) || tags.includes(w));
                if (!match) return;
                seen.add(id);
                results.push({
                    id: id,
                    title: note.title || 'Untitled',
                    content: this.excerpt(note.content || ''),
                    notebook: note.notebook,
                    tags: Array.isArray(note.tags) ? note.tags : [],
                    score: 2 // below any exact hit
                });
            });
        }

        results.sort((a, b) => b.score - a.score);
        this.displayResults(results.slice(0, this.limit));
    }

    /**
     * @param {string} content
     * @returns {string} trimmed preview, ellipsis only if actually truncated
     */
    excerpt(content, max) {
        const limit = max || 200;
        const text = String(content).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        if (text.length <= limit) return text;
        return text.slice(0, limit).trimEnd() + '…';
    }

    /* ---------------------------------------------------------------- results */

    displayResults(results) {
        this.searchResults.textContent = ''; // clear, not innerHTML = ''

        if (results.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'search-no-results';
            empty.textContent = 'No notes found';
            this.searchResults.appendChild(empty);
            this.showResults();
            return;
        }

        const query = this.searchInput.value;

        results.forEach(result => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            item.setAttribute('role', 'option');
            item.dataset.noteId = result.id;

            const title = document.createElement('div');
            title.className = 'search-result-title';
            // Nodes, not an HTML string: assigning a string containing
            // "<mark>" to textContent would display the tag literally.
            title.appendChild(this.highlight(result.title, query));

            const content = document.createElement('div');
            content.className = 'search-result-content';
            content.appendChild(this.highlight(result.content, query));

            const meta = document.createElement('div');
            meta.className = 'search-result-meta';

            if (result.notebook) {
                const nb = document.createElement('span');
                nb.className = 'search-result-notebook';
                nb.textContent = this.notebookName(result.notebook);
                meta.appendChild(nb);
            }
            if (result.tags && result.tags.length > 0) {
                const tags = document.createElement('span');
                tags.className = 'search-result-tags';
                tags.textContent = result.tags.slice(0, 5).map(t => '#' + t).join(' ');
                meta.appendChild(tags);
            }

            item.append(title, content, meta);
            item.addEventListener('click', () => this.selectNote(result.id));
            this.searchResults.appendChild(item);
        });

        this.activeIndex = -1;
        this.showResults();
    }

    notebookName(id) {
        const book = this.storage.getNotebooks().find(b => b.id === id);
        return book ? book.name : 'Unfiled';
    }

    /**
     * Build a fragment with <mark> around each query match.
     *
     * Returns NODES rather than an HTML string. That matters twice over:
     *   - assigning an HTML string via textContent would display the <mark>
     *     tags literally instead of highlighting;
     *   - every piece of user text goes into a text node, so a note title
     *     containing markup can never become markup. No sanitiser needed,
     *     and no regex is built from user input, so there is no ReDoS or
     *     regex-injection surface here at all.
     *
     * @param {string} text
     * @param {string} query
     * @returns {DocumentFragment}
     */
    highlight(text, query) {
        const frag = document.createDocumentFragment();
        const str = String(text == null ? '' : text);
        const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);

        if (!terms.length || !str) {
            frag.appendChild(document.createTextNode(str));
            return frag;
        }

        // Collect match ranges, case-insensitively.
        const haystack = str.toLowerCase();
        const ranges = [];
        terms.forEach((term) => {
            let at = haystack.indexOf(term);
            while (at !== -1) {
                ranges.push([at, at + term.length]);
                at = haystack.indexOf(term, at + term.length);
            }
        });

        if (!ranges.length) {
            frag.appendChild(document.createTextNode(str));
            return frag;
        }

        // Sort and merge overlaps so nested/adjacent terms do not nest marks.
        ranges.sort((a, b) => a[0] - b[0]);
        const merged = [];
        ranges.forEach((r) => {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else merged.push([r[0], r[1]]);
        });

        let pos = 0;
        merged.forEach(([from, to]) => {
            if (from > pos) frag.appendChild(document.createTextNode(str.slice(pos, from)));
            const mark = document.createElement('mark');
            mark.textContent = str.slice(from, to);
            frag.appendChild(mark);
            pos = to;
        });
        if (pos < str.length) frag.appendChild(document.createTextNode(str.slice(pos)));

        return frag;
    }

    showResults() {
        this.searchResults.classList.add('active');
        this.searchResults.style.display = 'block';
        this.searchResults.setAttribute('aria-hidden', 'false');
    }

    hideResults() {
        this.searchResults.classList.remove('active');
        this.searchResults.style.display = 'none';
        this.searchResults.setAttribute('aria-hidden', 'true');
        this.activeIndex = -1;
    }

    onKeyDown(e) {
        const items = Array.from(
            this.searchResults.querySelectorAll('.search-result-item')
        );
        if (!items.length) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const next = this.activeIndex + delta;
            this.activeIndex = next < 0 ? items.length - 1
                : next >= items.length ? 0
                : next;
            items.forEach((el, i) => el.classList.toggle('active', i === this.activeIndex));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const target = this.activeIndex >= 0 ? items[this.activeIndex] : items[0];
            if (target) this.selectNote(target.dataset.noteId);
        } else if (e.key === 'Escape') {
            this.hideResults();
            this.searchInput.blur();
        }
    }

    selectNote(noteId) {
        if (!noteId || !this.notesById[noteId]) return;
        this.hideResults();
        this.searchInput.value = '';
        window.dispatchEvent(new CustomEvent('select-note', {
            detail: { id: noteId }
        }));
    }
}

window.NB = window.NB || {};
window.NB.SearchManager = SearchManager;
// NB.escapeHtml is intentionally NOT defined here. search.js no longer needs
// an escaper (highlight() builds nodes), and defining a second one that app.js
// then silently overwrote invited the two to drift apart.
//
// Instantiated by app.js, after the DOM is ready and storage exists.
