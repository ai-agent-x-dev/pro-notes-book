# Pro Notes Book

### → [Open the app in your browser](https://ai-agent-x-dev.github.io/pro-notes-book/)

<sub>https://ai-agent-x-dev.github.io/pro-notes-book/</sub>

A local-first Markdown notes app. Your notes stay in your own browser — there is
no account and no server-side copy. The one exception is opt-in: if you deploy
your own copy with [Claude connected](#connecting-claude), the assistant sends
the prompts you type, with the open note, to Claude.

No build step, no npm install, no framework. Plain HTML, CSS, and JavaScript.
Clone it, serve the folder, and it runs.

---

## Quick start

**Just use it:** open the [live site](https://ai-agent-x-dev.github.io/pro-notes-book/).
Nothing to install, and it works offline once loaded.

**Run your own copy:**

```bash
git clone https://github.com/ai-agent-x-dev/pro-notes-book.git
cd pro-notes-book
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

Any static file server works (`npx serve`, `php -S`, nginx, …).

> **Why a server and not double-clicking `index.html`?** Browsers block service
> workers and some script loads on the `file://` scheme. Opening the file
> directly will appear to work and then fail in confusing ways. Serve it instead.

Any port works. Nothing needs installing to run it — there are no dependencies
to install at all.

---

## Using it

1. **Write.** Pick a notebook (or *All notes*) and type. The preview pane shows
   rendered Markdown; `Ctrl+P` toggles it.
2. **Save.** Saving is automatic two seconds after you stop typing, and again
   whenever the tab is hidden or closed. `Ctrl+S` forces it. If a save fails
   (for example, storage is full) closing the tab warns you.
3. **Find things.** `Ctrl+K` focuses search. It looks through titles, tags, and
   note bodies, and ranks exact phrase matches first.
4. **Organise.** Notebooks group notes; tags are comma-separated per note and
   filter the list.
5. **Back it up.** *Export* writes a single JSON file containing every note.
   Do this periodically — see [Where your data lives](#where-your-data-lives).

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Save the open note |
| `Ctrl+P` | Toggle the Markdown preview |
| `Ctrl+K` | Focus search |
| `Ctrl+Alt+N` | New note (`Ctrl+N` is reserved by the browser) |
| `Ctrl+B` | Bold the selection (editor only) |
| `Ctrl+I` | Italicise the selection (editor only) |

### Install as an app

The site is a PWA. In Chrome or Edge, use **Install** in the address bar; in
Firefox, **Install** from the menu. It then launches in its own window, gets an
icon, and works with no network connection.

### The assistant panel

An optional panel. These **local** commands run entirely in your browser, with
no API key and no network request:

| Command | Does |
| --- | --- |
| `summarize` | First lines of the current note |
| `outline` | Headings as an outline |
| `tags` | Tags used in the current note |
| `stats` | Note, word, and character counts |
| `title` | Suggests a title from the first line |
| `find <term>` | Searches your notes |
| `lock` | Forgets the Claude passphrase on this device |
| `help` | Lists the commands |

On the public GitHub Pages site that is all it does. On a copy deployed to
Cloudflare Pages with Claude connected, anything that is not a local command
("what am I missing in this plan?") goes to Claude, together with the note you
have open. The panel's hint line tells you which mode you are in. See
[Connecting Claude](#connecting-claude).

---

## Where your data lives

**In `localStorage`, in the one browser profile you are using.** Consequences
worth knowing before you trust it with anything:

- Notes are **per browser, per device**. Your phone and your laptop have
  separate, unsynchronised sets. The live site and a local clone also do not
  share notes. Tabs of the same browser *do* share them and update each other
  live; editing the same note in two tabs at once warns you, and the last save
  wins.
- Clearing site data, using a private window, or switching browser profile
  **deletes or hides your notes.** There is no server-side copy.
- **Export is your only backup.** Use *Export* regularly and keep the JSON file
  somewhere safe. *Import* reads that file back, merging into what is already
  there.
- The app has no analytics, no telemetry, and the browser makes no third-party
  request of any kind. With Claude connected, prompts reach Claude only through
  your own site's server, and only when you send one to the assistant.

---

## Features

- Markdown editor with a sanitised preview
- Notebooks and tag filters
- Debounced full-text search with match highlighting
- Autosave, plus a manual save button and an unsaved-changes guard
- Formatting toolbar: bold, italic, heading, bulleted list, link
- JSON import and export
- Local assistant commands (above)
- Dark theme, responsive down to mobile widths
- Works fully offline after the first visit

---

## Offline behaviour

The first visit precaches the whole app — markup, styles, all scripts, icons,
both Markdown libraries, and the font. After that it works with no network at
all, including a full reload.

| Request type | Strategy |
| --- | --- |
| Page navigations | network-first, falling back to the cached app |
| Precached files | cache-first, refreshed quietly in the background |
| Anything else | straight to the network, never cached |

When a new version is available the status bar offers
**"Update ready — click to reload"**, so an open tab is never swapped out from
under you.

Note that **the browser caches the app, not your notes**, and the two are
independent: clearing the cache is safe, but clearing site data is not.

---

## Project structure

```
pro-notes-book/
├── index.html          # entry point
├── manifest.json       # PWA metadata and icons
├── sw.js               # service worker: precache and offline shell
├── styles/
│   ├── main.css        # theme, layout, editor, preview
│   └── components.css  # buttons, lists, search results, assistant panel
├── scripts/
│   ├── storage.js      # localStorage wrapper, import/export
│   ├── search.js       # indexing, matching, highlighting
│   ├── agents.js       # assistant: local commands + /api/agent client
│   └── app.js          # wiring, rendering, shortcuts
├── assets/
│   ├── fonts/          # self-hosted Inter (variable) + its licence
│   ├── icons/          # favicon and PWA icons
│   └── vendor/         # marked and DOMPurify, self-hosted
├── tools/
│   ├── assemble-site.sh      # the allowlist of published files → _site/
│   └── deploy-cloudflare.sh  # Cloudflare Pages deploy, with _worker.js
├── _worker.js          # Cloudflare Pages only: headers + /api/agent
└── README.md
```

Scripts are **classic scripts**, not ES modules, loaded in dependency order from
`index.html`. `agents.js` exposes its class as `NB.AgentManager`, so the others
reach it through the `NB` namespace.

Third-party libraries and the font are vendored into the repository rather than
loaded from a CDN, because a service worker can only precache same-origin URLs —
a CDN-hosted library would leave the preview broken offline. The result is that
the app has **no third-party origin at all**.

---

## Deploying your own copy

The repository publishes itself: any push to `main` deploys via GitHub Actions
(`.github/workflows/pages.yml`). There is no build step because there is nothing
to build — the repository *is* the finished site.

To host it elsewhere, upload the folder as-is. It is a plain static site.

Two things to know if you adapt it:

- **Use relative paths.** Root-absolute paths like `/styles/main.css` break under
  a `/<repo>/` prefix. The current asset references are already relative.
- **Only allowlisted files are published.** `tools/assemble-site.sh` copies
  `index.html`, `manifest.json`, `sw.js`, `favicon.ico`, `LICENSE`, `assets/`,
  `scripts/` and `styles/` into `_site/`, and both deploys publish only that.
  Deploying through Actions bypasses Jekyll, so nothing else filters `_` or `.`
  paths: a new top-level file you want served must be added to that script.
  Even so, keep real secrets out of the repository entirely.
- **Actions are pinned to commit SHAs.** Update the SHA and its `# vX.Y.Z`
  comment together.

`_worker.js` only runs on **Cloudflare Pages**, where it sets real response
headers and serves `/api/agent`. GitHub Pages has no server-side runtime and
never receives the file.

---

## Connecting Claude

The assistant can answer free-form questions about your note through Claude.
That needs server-side code to hold the API key, because anything in the
browser is public. `_worker.js` is that code, and it runs on **Cloudflare
Pages** (free tier is fine). GitHub Pages cannot do this.

**The API key never reaches the browser.** The panel sends your prompt and the
open note to `/api/agent` on your own site. The Worker checks a passphrase and
then calls the Claude API with the key, which is stored as a Cloudflare secret.

### Set it up

You need a Cloudflare account, an Anthropic API key from
[console.anthropic.com](https://console.anthropic.com/), and Node.js for
`npx wrangler`.

```bash
npx wrangler login
npx wrangler pages project create pro-notes-book --production-branch main

# Paste each value when prompted; it never touches the repository.
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name pro-notes-book
npx wrangler pages secret put AGENT_PASSPHRASE  --project-name pro-notes-book

tools/deploy-cloudflare.sh
```

Open the `*.pages.dev` URL wrangler prints, open the assistant, and ask
something. It asks for the passphrase once per device.

**Choose a strong passphrase.** It is the only thing between the internet and
your API credit. Generate one with `openssl rand -base64 24`.

### Optional settings

Set these as plain variables in the Cloudflare dashboard (*Settings →
Variables*):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MODEL` | `claude-opus-5` | Claude model ID |
| `AGENT_EFFORT` | `medium` | `low` … `max`: depth of reasoning vs. cost and speed |
| `AGENT_MAX_TOKENS` | `8192` | Longest reply, capped at 32000 |

The model is always chosen by the server; a client cannot request another one.
A request the model declines is retried automatically on Anthropic's
recommended fallback model.

### Protect your spend

- Set a **monthly spend limit** in the Anthropic Console. It is the hard
  backstop whatever else happens.
- Add a Cloudflare **rate limiting rule** for the path `/api/agent`
  (*Security → WAF*), for example 20 requests per minute per IP.
- For the strongest option, put the whole site behind **Cloudflare Access**, so
  only your own login can reach it at all.

### Develop locally

Put the secrets in a `.dev.vars` file in the repository root (gitignored, never
published):

```
ANTHROPIC_API_KEY=...
AGENT_PASSPHRASE=...
```

Then run `tools/assemble-site.sh --with-worker && npx wrangler pages dev _site`.

### What gets sent

Only when you send a prompt that is not a local command: that prompt, plus the
title and text of the note you have open. Nothing else: no other notes, no
settings, no history of earlier questions. Each question stands alone.

---

## Security notes

- **The Claude API key lives only in Cloudflare secrets.** The browser holds a
  passphrase for your Worker, never the key, and Export never includes it. The
  Worker compares the passphrase in constant time, accepts same-origin JSON
  only, caps prompt and note size, fixes the model server-side, and never
  forwards Anthropic's error bodies to the browser.

- **Your notes are only as private as the web origin they live on.**
  `localStorage` is shared by every page on the same origin, and on GitHub
  Pages the origin is the whole account (`<user>.github.io`), not the
  `/pro-notes-book/` folder. Any other project published under the same
  account can read and overwrite these notes. For anything sensitive, serve the
  app from its own origin: a custom domain, or a local clone.

- All user-supplied text is rendered with `textContent`, and Markdown preview
  HTML is sanitised by DOMPurify. Links get `rel="noopener noreferrer"`.
- Search highlighting builds DOM nodes instead of an HTML string, so a note
  title containing markup can never be executed as markup.
- A strict `Content-Security-Policy` is set to `'self'` only — there is no
  `unsafe-inline`, because the app has no inline script or style.
- Storage writes are wrapped: a full quota or corrupt value reports into the
  status line rather than throwing away the save.
- Imports are normalised and length-capped, colliding ids are re-keyed, and a
  note can never be left pointing at a notebook that does not exist.
- **Images are deliberately not rendered in the preview.** A remote `<img>` is a
  tracking beacon that reports when a note was read, and it cannot work offline.
  To enable images, add `img`/`src` back to `ALLOWED_TAGS`/`ALLOWED_ATTR` in
  `renderMarkdown()` and relax `img-src` in the CSP.

---

## Tests

The project ships no test tooling, by design. It was developed against two
throwaway harnesses kept outside the repository so no `node_modules` ends up in
it: a jsdom suite (storage, import/export, search, preview sanitisation, edge
cases) and a Chromium suite via `puppeteer-core` (service worker registration,
precache contents, genuine offline reload, update prompt). Both deliberately
cover failure paths — quota exhaustion, corrupt JSON, hostile imports, and
prototype-pollution keys.

---

## License

This project is MIT licensed — see [LICENSE](LICENSE). That covers this
project's own code only.

The vendored components keep their own licences, shipped alongside them in
`assets/vendor/` and `assets/fonts/`:

| Library | Version | License |
| --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 15.0.7 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.4 | Apache-2.0 OR MPL-2.0 |
| [Inter](https://github.com/rsms/inter) | v20 (variable) | SIL OFL 1.1 |

DOMPurify is dual-licensed; comply with either Apache-2.0 or MPL-2.0. The
project's MIT licence does not extend to Inter, whose OFL text ships with it.
`assets/vendor/VENDORED.md` and `assets/fonts/VENDORED.md` record the source
URLs and SRI hashes each file was verified against.
