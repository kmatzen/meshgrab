#!/usr/bin/env bash
# Build a Chrome Web Store upload zip containing only runtime files.
# Dev files (selftest, docs, this script) are excluded from the package.
set -euo pipefail

cd "$(dirname "$0")"
OUT="meshgrab-$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])').zip"

rm -f "$OUT"
zip -qr "$OUT" \
  manifest.json \
  hooks.js \
  bridge.js \
  popup.html \
  popup.js \
  icons

echo "$OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'
