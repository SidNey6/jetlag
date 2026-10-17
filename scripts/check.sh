#!/bin/sh
# Syntaxprüfung aller ES-Module (node --check versteht ESM nur bei .mjs)
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
fail=0
for f in js/*.js js/ui/*.js sw.js; do
  [ -f "$f" ] || continue
  target="$tmp/$(basename "$f" .js).mjs"
  cp "$f" "$target"
  # Status von node selbst auswerten – eine Pipe dahinter würde ihn verschlucken
  if ! out=$(node --check "$target" 2>&1); then
    echo "$f:"
    echo "$out" | sed "s#[^ ]*$(basename "$target")#$f#" | head -6
    fail=1
  fi
done
rm -rf "$tmp"
if [ $fail -ne 0 ]; then
  echo "Syntaxfehler gefunden"
  exit 1
fi
echo "Syntax aller Module ok"

# Eine Versionsnummer an drei Stellen: App, Service Worker und version.json (Update-Hinweis
# der Android-App)
app=$(sed -n "s/.*__JL_VERSION__ = '\(v[0-9.]*\)'.*/\1/p" js/main.js)
sw=$(sed -n "s/^const VERSION = '\(v[0-9.]*\)'.*/\1/p" sw.js)
datei=$(sed -n 's/.*"version": *"\(v[0-9.]*\)".*/\1/p' version.json)
if [ "$app" != "$sw" ] || [ "$app" != "$datei" ]; then
  echo "Versionen passen nicht zusammen: main.js $app, sw.js $sw, version.json $datei"
  exit 1
fi
echo "Version $app überall gleich"
