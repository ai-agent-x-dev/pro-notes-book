#!/bin/sh
# Deploy to Cloudflare Workers: the static site plus worker.js, which adds the
# security headers and serves /api/agent. Settings are in wrangler.jsonc.
#
# One-time setup (see README, "Connecting Claude"):
#   npx wrangler login
#   tools/deploy-cloudflare.sh
#   npx wrangler secret put ANTHROPIC_API_KEY
#   npx wrangler secret put AGENT_PASSPHRASE
#
# Usage: tools/deploy-cloudflare.sh
set -eu

cd "$(dirname "$0")/.."

tools/assemble-site.sh
npx wrangler deploy
