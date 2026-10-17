#!/bin/sh
# Builds a snapshot-only copy for the claude.ai Artifact: the publisher wraps the page in its own
# doctype/head/body skeleton, so strip ours and the duplicate metas. The copy reads only the saved
# live responses (fallback-data.js) and calls no API; The AI assistant and live calls link to the live site.
# Usage: scripts/build_artifact.sh <outdir>
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-artifact}"
mkdir -p "$OUT"
grep -v -E '^<!doctype html>|^<html|^</html>|^<head>|^</head>|^<body>|^</body>|<meta ' public/index.html \
  | sed 's#<script src="adapters.js"></script>#<script>window.SNAPSHOT_ONLY = true;</script>\n<script src="fallback-data.js"></script>\n<script src="adapters.js"></script>#' > "$OUT/index.html"
cp public/styles.css public/adapters.js public/app.js public/call.js public/assistant.js public/fallback-data.js "$OUT/"
echo "$OUT ready"
