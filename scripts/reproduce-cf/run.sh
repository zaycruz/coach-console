#!/bin/sh
# Trigger the Cloudflare-hosted E2E reproduction and wait for it. Needs URL and RUN_TOKEN (see src/index.js).
# Writes the final /status JSON to ${OUT:-result.json}. Only short curl calls run on this machine.
set -eu
: "${URL:?set URL to the deployed worker URL}" "${RUN_TOKEN:?set RUN_TOKEN}"
OUT=${OUT:-result.json}
H="authorization: Bearer $RUN_TOKEN"
curl -fsS -X POST -H "$H" "$URL/run"; echo
while :; do
  sleep 5   # short polls keep the Durable Object (and so its container) active
  curl -fsS -H "$H" "$URL/status" > "$OUT.tmp" || continue
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(new Date().toISOString(),(s.phases||"").trim().split("\n").pop()||"booting");if(s.running===false&&s.stopped){console.log("container stopped:",s.stopped);process.exit(2)}process.exit(s.done?0:1)' "$OUT.tmp" && break || { [ $? -eq 2 ] && exit 1; true; }
done
mv "$OUT.tmp" "$OUT"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("exit",s.exit,s.sha);console.log((s.e2e||"").split("\n").filter(l=>/passed, .* failed/.test(l)).join("\n"))' "$OUT"
curl -fsS -X POST -H "$H" "$URL/destroy"; echo
