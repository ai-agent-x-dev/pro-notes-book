#!/bin/sh
# Assemble the files that are actually published into ./_site.
#
# This is an ALLOWLIST and the single source of truth for it: the GitHub
# Pages workflow and the Cloudflare deploy both call this script. Anything not
# listed here stays private, including .gitignore, README.md, tools/ and any
# local secrets file such as .dev.vars. A new top-level file that should be
# served must be added below.
#
# Usage: tools/assemble-site.sh [--with-worker]
#   --with-worker  also copy _worker.js (Cloudflare Pages only; GitHub Pages
#                  must never receive it)
set -eu

cd "$(dirname "$0")/.."

rm -rf _site
mkdir _site
# cp fails, and with it the deploy, if any listed file is missing.
cp -r index.html manifest.json sw.js favicon.ico LICENSE \
      assets scripts styles _site/

if [ "${1:-}" = "--with-worker" ]; then
    cp _worker.js _site/
fi

echo "assembled _site/ ($(find _site -type f | wc -l | tr -d ' ') files)"
