#!/bin/sh
# Assemble the files that are actually published into ./_site.
#
# This is an ALLOWLIST and the single source of truth for it: the GitHub
# Pages workflow and the Cloudflare deploy both call this script. Anything not
# listed here stays private, including .gitignore, README.md, tools/,
# worker.js, wrangler.jsonc and any local secrets file such as .dev.vars. A new top-level file that should be
# served must be added below.
#
# worker.js is deliberately not copied: on Cloudflare it runs as the Worker's
# script and must not also be served as a public file.
#
# Usage: tools/assemble-site.sh
set -eu

cd "$(dirname "$0")/.."

rm -rf _site
mkdir _site
# cp fails, and with it the deploy, if any listed file is missing.
cp -r index.html manifest.json sw.js favicon.ico LICENSE \
      assets scripts styles _site/

echo "assembled _site/ ($(find _site -type f | wc -l | tr -d ' ') files)"
