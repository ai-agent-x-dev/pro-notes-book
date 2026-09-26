# pro-notes-book

A local-first Markdown notes app. No build step, no npm dependencies, no
framework — plain HTML, CSS, and classic scripts. Notes live in
`localStorage` on your own machine; nothing is sent anywhere.

## Features

- Markdown editor with a sanitised preview (toggle with `Ctrl+P`)
- Notebooks and tag filters
- Debounced full-text search across title, tags, and body, with highlighting
- Autosave, with a manual **Save** button and unsaved-change warning
- Formatting toolbar: bold, italic, heading, bulleted list, link
- Import/export as JSON
- Optional assistant panel with **local** commands — `summarize`, `outline`,
  `tags`, `stats`, `title`, `find <term>`, `help` — no API key, no network call
- Dark UI, responsive down to mobile widths

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Save the open note |
| `Ctrl+P` | Toggle preview |
| `Ctrl+K` | Focus search |
| `Ctrl+Alt+N` | New note (`Ctrl+N` is reserved by the browser) |
| `Ctrl+B` | Bold selection (editor only) |
| `Ctrl+I` | Italic selection (editor only) |

The heading, list, and link formats are toolbar-only; they have no shortcut.

## Structure

```
pro-notes-book/
├── index.html              # single entry point
├── manifest.json           # PWA metadata (name, icons, theme colour)
├── sw.js                   # service worker: precache + offline shell
├── favicon.ico
├── LICENSE                 # MIT (this project only; see the note at the end)
├── styles/
│   ├── main.css            # theme tokens, layout, editor, preview
│   └── components.css      # buttons, search results, notebook list, agent panel
├── scripts/
│   ├── storage.js          # localStorage wrapper + import/export
│   ├── search.js           # indexing, matching, highlight rendering
│   ├── agents.js           # local assistant commands
│   └── app.js              # wiring, rendering, keyboard shortcuts
├── assets/
│   ├── fonts/              # self-hosted Inter (variable woff2) + its OFL
│   ├── icons/              # favicon.svg + PWA icons
│   └── vendor/             # marked + DOMPurify, self-hosted (see VENDORED.md)
├── _worker.js              # Cloudflare Pages ONLY — inert on GitHub Pages
└── README.md
```

Scripts are **classic scripts** (not ES modules), loaded in dependency order
from `index.html`:

```html
<script src="scripts/storage.js"></script>
<script src="scripts/search.js"></script>
<script src="scripts/agents.js"></script>
<script src="scripts/app.js"></script>
```

`agents.js` scopes its class inside an IIFE and exports it as
`NB.AgentManager`, so the others must reference it through the `NB` namespace
rather than as a bare global.

## Running locally

```bash
cd ~/Desktop/pro-notes-book
python3 -m http.server 8000
# open http://localhost:8000
```

A static server is required. Opening `index.html` over `file://` will not work:
browsers block module and worker loads from that scheme.

## Deploying to GitHub Pages

1. Commit, then push to a GitHub repository. Create the repository **empty** —
   do not tick *Add a README*, *Add a .gitignore* or *Choose a license*, or the
   push will be rejected as non-fast-forward because the histories are unrelated.
2. Repository → **Settings** → **Pages** → Source: **Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. Live at `https://<user>.github.io/<repo>/`.

Because this is a *project* site rather than a user site, every internal path
must be **relative** (`styles/main.css`, `./scripts/app.js`) — a root-absolute
path like `/styles/main.css` returns 404 under the `/<repo>/` prefix. All
current asset references already follow this rule.

### Why there is no `.nojekyll`

GitHub Pages runs Jekyll by default, and Jekyll's ignore rules silently drop
every path beginning with `_` or `.`. The empty `.nojekyll` file would switch
that off — it is deliberately **not** here, for two reasons.

Jekyll cannot alter this site either way. It only applies templating to files
carrying YAML front matter, and no committed file has any, so everything is
published verbatim regardless. So the file would buy correctness we already
have.

And leaving Jekyll on keeps the public surface smaller: `_worker.js` and
`.gitignore` are *not* deployed. Neither is needed at runtime, and neither
belongs in a public web root — `.gitignore` in particular is only ever a
developer-side gate, and GitHub Pages builds from the committed tree anyway, so
it protects the repository regardless of what the site serves.

Worth knowing if this ever changes: dropping `.nojekyll` in publishes
everything in the repository, dotfiles included. A real `.env` must then be
kept off the published branch, not merely gitignored.

### `_worker.js` is not used by GitHub Pages

`_worker.js` only executes on **Cloudflare Pages**. GitHub Pages has no
server-side runtime, so the file is simply ignored there. It is kept for the
optional Cloudflare deployment and for use as a same-origin `/api/agent` proxy.
To deploy to Cloudflare Pages instead:

```bash
npx wrangler pages deploy .
```

## Offline behaviour

The app is a real offline PWA. `sw.js` precaches the whole shell — markup,
styles, all four scripts, the manifest, the icons **and both Markdown
libraries** — so the first visit is enough and no later request is required.

Why the libraries and the font are vendored rather than loaded from a CDN: a
service worker can only precache same-origin URLs, so a CDN-hosted `marked`
would leave the preview pane broken offline and a CDN-hosted font would
reflow the UI on first load. `assets/vendor/` and `assets/fonts/` hold
byte-identical copies of what was previously pinned remotely — the scripts
verified against their SRI hashes — which leaves **no third-party origin in the
app at all**. The `Content-Security-Policy` is therefore entirely `'self'`,
with nothing to widen later.

| Request | Strategy |
| --- | --- |
| Navigations | network-first, falling back to the cached shell |
| Precached files | cache-first, refreshed quietly in the background |
| Anything else | straight to the network, never written to the cache |

Notes:

- `CACHE` in `sw.js` is versioned (`pro-notes-<VERSION>`). **Bump `VERSION`
  whenever you change a precached file** — that is what retires the old cache.
- Updates do not hijack an open tab. A new worker waits, and the status bar
  offers "Update ready — click to reload". (Do not add `skipWaiting()` to the
  `install` handler; it makes that prompt impossible to fire.)
- The font is precached too, which matters: without it the first offline load
  would render in the fallback and then reflow when the real font arrived.

## Deployment targets

**GitHub Pages** — static files only, so `_worker.js` does not run and no
response headers can be set. Most hardening therefore lives in the
`<meta http-equiv="Content-Security-Policy">` in `index.html`.

**Cloudflare Pages** — `_worker.js` runs and sends the real headers,
including `frame-ancestors`, which is ignored in a meta tag.

## Security notes

- Every render path for user-supplied text uses `textContent` or
  `createTextNode`. Markdown preview HTML is sanitised by DOMPurify, and the
  preview adds `rel="noopener noreferrer"` to links.
- Search highlighting builds DOM nodes rather than an HTML string, so note
  titles containing markup can never be interpreted as markup, and no regex is
  ever built from user input.
- `localStorage` writes are wrapped: a full quota or a corrupt value reports
  into the status line rather than throwing and losing the save path.
- Imports are normalised, not deeply validated. Strings are coerced and length
  capped, colliding ids are re-keyed on merge, and a note can never be left
  pointing at a notebook that does not exist.
- There is no API key in any client file. The assistant panel is local-only
  unless you point it at an endpoint, and both `agents.js` and
  `connect-src 'self'` refuse a cross-origin one.
- A strict CSP ships with no `unsafe-inline`: the document has no inline
  `<script>`, `<style>` or `style=""`, and the JS uses CSSOM for the few style
  changes it makes.
- **Images are not rendered in the preview.** A remote `<img>` is a tracking
  beacon that reports the exact time a note was read, a `data:` image survives
  `ALLOWED_URI_REGEXP` regardless and can quietly eat the storage quota, and
  neither works offline. To allow images, add `img` and `src` back to
  `ALLOWED_TAGS` / `ALLOWED_ATTR` in `renderMarkdown()` — and then also relax
  `img-src` in the CSP.

## Tests

The project itself has no build step and no test tooling, so there is nothing
to install here. During development the app was driven end-to-end by two
throwaway harnesses kept **outside** this folder (in `/tmp`), so no `node_modules`
ends up in the repository:

- **jsdom** — storage resilience, import/export, prototype-key handling,
  search, filtering, shortcuts, preview sanitisation, agent panel, and the
  `beforeunload` contract. Run in two modes: with the libraries absent
  (asserting the safe escaped fallback) and with the **actual vendored files**
  inlined, so the suite exercises the bytes that ship.
- **Chromium via puppeteer-core** — the parts jsdom cannot do at all: service
  worker registration and precache contents, a genuine offline reload, Markdown
  preview working with the network switched off, DOMPurify still sanitising
  offline, a same-origin 404 *not* overwriting the cached shell, and the
  service worker update prompt.

Both suites cover the failure paths deliberately: quota exhaustion, corrupt
JSON, hostile imports, `__proto__`/`constructor` keys, and `beforeunload` with
a failing write.

## License

This project is MIT licensed — see [LICENSE](LICENSE).

That covers **this project's own code only**. The two vendored libraries in
`assets/vendor/` keep their own licences and notices, which are shipped
alongside them in the same folder:

| Library | Version | License |
| --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 15.0.7 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.4 | Apache-2.0 OR MPL-2.0 |
| [Inter](https://github.com/rsms/inter) | v20 (variable) | SIL OFL 1.1 |

DOMPurify is dual-licensed; you may comply with either Apache-2.0 or MPL-2.0.
`assets/vendor/VENDORED.md` records the source URLs and the SRI hashes the
scripts were verified against; `assets/fonts/VENDORED.md` does the same for
the font, including how to re-verify an update.

The font is MIT-licensed *code* but OFL-licensed *type*. The project MIT licence
does not extend to it, which is why Inter's own OFL text ships alongside it.
