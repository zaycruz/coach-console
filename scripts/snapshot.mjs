// Capture the live API responses into public/fallback-data.js: the saved copy the adapter falls back to
// when a module is down, and the whole data source of the shared Artifact (which may not call other hosts).
// Usage: node scripts/snapshot.mjs [baseUrl]
import { writeFileSync } from "node:fs";
const B = process.argv[2] || "https://patient-360.raava.dev";
const out = { __capturedAt: new Date().toISOString(), __source: B };
async function grab(path) {
  const r = await fetch(B + path);
  if (!r.ok) { console.warn(`skip ${path}: HTTP ${r.status}`); return null; }
  return (out[path] = await r.json());
}
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }
for (const m of ["c1", "c3", "c4", "c5"]) {
  const list = (await grab(`/api/${m}/survivors`)) || [];
  await pool(list.map((x) => `/api/${m}/survivors/${x.survivorId}`), 8, grab);
}
const calls = (await grab("/api/c5/calls")) || [];
await pool(calls.map((c) => `/api/c5/calls/${c.callId}`), 8, grab);
await grab("/api/c3/metrics");
await grab("/api/c1/metrics");
// Workers AI advice is slow (3-8 s); keep it for the first few glucose patients only.
const c4 = out["/api/c4/survivors"] || [];
await pool(c4.slice(0, 6).map((x) => `/api/c4/survivors/${x.survivorId}/advice`), 3, grab);
const js = `window.SNAPSHOT = ${JSON.stringify(out)};\n`;
writeFileSync(new URL("../public/fallback-data.js", import.meta.url), js);
console.log(`${Object.keys(out).length - 2} responses, ${(js.length / 1e6).toFixed(2)} MB, captured ${out.__capturedAt}`);
