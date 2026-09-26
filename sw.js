/* sw.js — service worker.
 *
 * Goal: after the first visit the app works with the network switched off,
 * including the Markdown preview. That requires the two vendored libraries to
 * be precached too, not just the local shell, which is why they live in
 * assets/vendor/ instead of loading from a CDN.
 *
 * Strategy, per request type:
 *   - navigations  network-first, falling back to the cached shell. A fresh
 *                   copy when online, still-usable app when offline.
 *   - precached    cache-first. These are version-pinned, so a byte-identical
 *                   hit is correct and avoids a network round trip.
 *   - everything   cache-first with a background refresh (stale-while-
 *                   revalidate), so nothing unversioned is served stale
 *                   forever.
 *
 * CACHE is versioned. Bump it whenever a precached file changes; install then
 * drops every old cache in activate, which is what retires stale assets.
 */
/* v3: the shell gained a CSP, the vendored Markdown libraries, the
 * ?action=new shortcut handling, and a self-hosted Inter, so the v2 precache
 * must be retired. The font must be precached or the first offline load would
 * render with a fallback and then reflow when the real font arrived. */
const VERSION = 'v3';
const CACHE = `pro-notes-${VERSION}`;

/* Paths are relative to the worker's own location, not the page. Using
 * relative URLs here is what lets the same build work at /, at
 * /<user>.github.io/<repo>/, and in a subfolder without edits. */
const SHELL = [
    './',
    './index.html',
    './manifest.json',
    './favicon.ico',
    './assets/fonts/fonts.css',
    './assets/fonts/inter-latin-var.woff2',
    './styles/main.css',
    './styles/components.css',
    './scripts/storage.js',
    './scripts/search.js',
    './scripts/agents.js',
    './scripts/app.js',
    './assets/icons/favicon.svg',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/icons/icon-512-maskable.png',
    './assets/vendor/marked.min.js',
    './assets/vendor/purify.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // addAll is atomic: one 404 would leave the app half-cached and the
        // install would reject, so failures are per-file and logged. The
        // critical shell is asserted below.
        await Promise.all(SHELL.map(async (url) => {
            try {
                const res = await fetch(new Request(url, { cache: 'reload' }));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                await cache.put(url, res);
            } catch (err) {
                console.warn('[sw] could not precache', url, err);
            }
        }));

        // The app cannot boot without these; fail the install rather than
        // leave a cached shell that is missing its scripts.
        const required = ['./index.html', './scripts/app.js', './scripts/storage.js'];
        const missing = [];
        for (const url of required) {
            if (!(await cache.match(url))) missing.push(url);
        }
        if (missing.length) throw new Error('[sw] required files missing: ' + missing.join(', '));

        // NOTE: deliberately no skipWaiting() here.
        // Calling it during install would activate a new worker before the
        // page could ask the user, which makes the "Update ready — click to
        // reload" prompt in app.js a button that can never fire: its
        // controllerchange listener is registered after the event already
        // happened. The first install still activates immediately (there is no
        // existing controller to wait for); only UPDATES wait, which is the
        // point.
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        // Only ever touch this app's own caches. Wiping every cache on the
        // origin would delete CacheStorage belonging to other apps hosted
        // alongside this one.
        await Promise.all(keys.map((k) =>
            (k.startsWith('pro-notes-') && k !== CACHE) ? caches.delete(k) : null));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    // "skipWaiting" lets the page force an update after showing the user a
    // "reload to update" prompt.
    if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only GET is cacheable, and never touch cross-origin or non-HTTP schemes.
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch (err) {
        return;
    }
    if (url.origin !== self.location.origin) return;

    // Navigations: try the network so a deployed update is picked up, then
    // fall back to the cached shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            try {
                const fresh = await fetch(request);
                // Only overwrite the shell with an actual successful copy of
                // the shell. fetch() does NOT reject on a 404 or 500, so
                // without these guards a typo'd URL would cache its error page
                // as the app and break every later offline load.
                const shellPath = new URL('./index.html', self.location).pathname;
                if (fresh.ok && fresh.type === 'basic' && url.pathname === shellPath) {
                    cache.put('./index.html', fresh.clone());
                }
                return fresh;
            } catch (err) {
                return (await cache.match('./index.html'))
                    || (await cache.match('./'))
                    || new Response('Offline and no cached copy available.', {
                        status: 503,
                        headers: { 'Content-Type': 'text/plain' }
                    });
            }
        })());
        return;
    }

    // Everything else: serve the precached shell cache-first, and do not
    // blanket-cache anything else. A catch-all would happily store a
    // personalised, authenticated GET (say a same-origin /api/agent response)
    // under a URL that is not partitioned by cookie, and grow without limit.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request, { ignoreSearch: false });
        if (hit) {
            // Refresh quietly so an updated shell is picked up on the next
            // load even before the version is bumped.
            event.waitUntil((async () => {
                try {
                    const fresh = await fetch(request);
                    if (fresh.ok && fresh.type === 'basic') await cache.put(request, fresh.clone());
                } catch (err) { /* offline: the cached copy stands */ }
            })());
            return hit;
        }

        // Not precached: go to the network, and do not store the result.
        try {
            return await fetch(request);
        } catch (err) {
            return new Response('', { status: 504, statusText: 'Offline and not cached' });
        }
    })());
});
