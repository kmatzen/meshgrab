#!/usr/bin/env bash
# Build a Chrome Web Store upload zip containing only runtime files.
# Dev files (selftest, docs, this script) are excluded from the package.
set -euo pipefail

cd "$(dirname "$0")"

# Chrome Web Store limits that the upload validator enforces, checked here so a
# violation surfaces before you burn a round trip through the dashboard.
python3 - <<'PY'
import json, sys
m = json.load(open("manifest.json"))
limits = {"name": 75, "description": 132, "version": 20}
bad = [(k, len(m[k]), v) for k, v in limits.items() if k in m and len(m[k]) > v]
for k, got, cap in bad:
    print(f"manifest.{k} is {got} chars, exceeds the {cap} character limit", file=sys.stderr)
if bad:
    sys.exit(1)
print("manifest limits ok: " + ", ".join(f"{k}={len(m[k])}/{v}" for k, v in limits.items() if k in m))
PY

OUT="meshgrab-$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])').zip"

rm -f "$OUT"
zip -qr "$OUT" \
  manifest.json \
  background.js \
  sites.js \
  hooks.js \
  bridge.js \
  popup.html \
  popup.js \
  icons

echo "$OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'
