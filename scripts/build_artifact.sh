#!/bin/sh
# Builds artifact/ for publishing as a claude.ai Artifact: the publisher wraps the page in its own
# doctype/head/body skeleton, so strip ours and the duplicate metas. Assets are copied unchanged.
set -eu
cd "$(dirname "$0")/.."
mkdir -p artifact
grep -v -E '^<!doctype html>|^<html|^</html>|^<head>|^</head>|^<body>|^</body>|<meta ' prototype/index.html > artifact/index.html
cp prototype/styles.css prototype/app.js prototype/mock-data.js artifact/
echo "artifact/ ready"
