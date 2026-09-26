/**
 * _worker.js — Cloudflare Pages Worker
 *
 * ⚠️  NOT USED BY GITHUB PAGES.
 * GitHub Pages has no server-side runtime: this file is inert there and will
 * not run. It is kept because Cloudflare Pages DOES execute it. If you deploy
 * to GitHub Pages, delete this file (or keep it as a reference).
 *
 * Its real value here is being the only place that can send RESPONSE HEADERS.
 * Most of the hardening in this app lives in the <meta http-equiv> CSP in
 * index.html, because GitHub Pages cannot set headers. This file is where the
 * rest of it — including frame-ancestors, which is ignored in a meta tag —
 * can actually be applied.
 *
 * It works with ES-module Workers (wrangler 3.x+):
 *   [project]/_worker.js
 *
 * Deploy locally with:  npx wrangler pages dev .
 */

// Keep this CSP in sync with the <meta http-equiv> one in index.html. It is
// duplicated deliberately: the meta tag covers GitHub Pages, this header
// covers Cloudflare Pages, and a browser enforces the intersection.
//
// Every source is 'self' because the app loads nothing from any other origin:
// the Markdown libraries are vendored and the font is self-hosted.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'"
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Only meaningful over HTTPS, which Cloudflare always serves.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
};

export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);

    // Rebuilding the Response is only safe for a body-bearing status. For
    // 204/304/101 `response.body` is null and `new Response(null, ...)` is
    // fine, but passing a body alongside those statuses throws — so return the
    // original untouched.
    const nullBody = [101, 103, 204, 205, 304].includes(response.status);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }

    if (nullBody) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
