#!/bin/sh
# Syntaxprüfung aller ES-Module (node --check versteht ESM nur bei .mjs)
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
fail=0
for f in js/*.js js/ui/*.js sw.js; do
  [ -f "$f" ] || continue
  cp "$f" "$tmp/$(basename "$f" .js).mjs"
  if ! node --check "$tmp/$(basename "$f" .js).mjs" 2>&1 | head -3; then fail=1; fi
done
rm -rf "$tmp"
[ $fail -eq 0 ] && echo "Syntax aller Module ok"
