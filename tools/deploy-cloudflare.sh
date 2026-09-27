#!/bin/sh
# Deploy to Cloudflare Pages, with _worker.js serving /api/agent.
#
# One-time setup (see README, "Connecting Claude"):
#   npx wrangler login
#   npx wrangler pages project create pro-notes-book --production-branch main
#   npx wrangler pages secret put ANTHROPIC_API_KEY --project-name pro-notes-book
#   npx wrangler pages secret put AGENT_PASSPHRASE  --project-name pro-notes-book
#
# Usage: tools/deploy-cloudflare.sh [project-name]
set -eu

cd "$(dirname "$0")/.."
PROJECT="${1:-pro-notes-book}"

tools/assemble-site.sh --with-worker
npx wrangler pages deploy _site --project-name "$PROJECT" --branch main
