// Screenshot every Patient 360 route at desktop (1440) and phone (390), full page, for design review.
// Usage: node scripts/shoot.mjs <baseUrl|local> <outDir> [--api https://patient-360.raava.dev]
//   baseUrl  a deployed site, e.g. https://patient-360.raava.dev
//   local    serve this worktree's public/ on an ephemeral port and proxy /api/* to --api (default: the live site).
//            The server lives only as long as this command: it is closed in `finally`.
// Each shot is also swept for text that must never render (undefined, NaN, null, [object Object], raw JSON)
// and, at 390 px, for horizontal scroll. Findings go to <outDir>/sweep.json and the console.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const API = flag("--api", "https://patient-360.raava.dev");
const [baseArg = "local", outArg] = args;
const out = outArg || `runs/polish-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
mkdirSync(out, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav" };
function localServer(root) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = { ...req.headers }; delete headers.host; delete headers["accept-encoding"]; delete headers.connection;
        const r = await fetch(API + url.pathname + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
        const buf = Buffer.from(await r.arrayBuffer());
        const h = Object.fromEntries([...r.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)));
        res.writeHead(r.status, h); res.end(buf); return;
      }
      const p = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      const data = await readFile(join(root, p));
      res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream", "cache-control": "no-store" }); res.end(data);
    } catch (e) { res.writeHead(e.code === "ENOENT" ? 404 : 502, { "content-type": "text/plain" }); res.end(String(e.message || e)); }
  });
}

let server = null, browser = null;
const findings = [];
try {
  let B = baseArg.replace(/\/$/, "");
  if (baseArg === "local") {
    server = localServer(new URL("../public/", import.meta.url).pathname);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    B = `http://127.0.0.1:${server.address().port}`;
    console.log(`local ${B} (public/ + /api → ${API})`);
  }
  const calls = await (await fetch(API + "/api/c5/calls")).json();
  const call = (calls.find((c) => c.flags && c.flags.length) || calls[0]).callId;
  const ROUTES = [
    "today", "today~loading", "today~empty", "today~error",
    "patients", "patients~loading", "patients~error",
    "calls", `call-${call}`, "calls~error",
    "care", "care~empty", "inbox", "research",
    "p-c1-S71188550", "p-c1-S71188550.c1", "p-c3-P03000", "p-c3-P03000.c3", "p-c4-N0072", "p-c4-N0072.c4", "p-c5-P0002", "p-c5-P0002.c5",
    "p-c4-N0072.c3", "p-c3-NOPE", "nowhere",
  ];
  browser = await chromium.launch();
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: process.env.SCHEME || "light" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    for (const route of ROUTES) {
      await page.goto(`${B}/#${route}`);
      await page.waitForFunction(() => { const v = document.getElementById("view"); return (v && v.dataset.ready && !v.querySelector('[aria-busy="true"]')) || location.hash.includes("~loading"); }, null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(route.startsWith("p-") && !route.includes(".") ? 1500 : 500);
      const name = `${route.replace(/[^a-z0-9.~-]/gi, "_")}_${w}.png`;
      await page.screenshot({ path: join(out, name), fullPage: true });
      const s = await page.evaluate(() => {
        const v = document.getElementById("view");
        const clone = v.cloneNode(true); clone.querySelectorAll(".kv-tbl, .raw").forEach((e) => e.remove());
        const t = clone.innerText || clone.textContent || "";
        const bad = (t.match(/\b(undefined|NaN|null)\b|\[object Object\]|^\s*[{[]"|at \w+ \(.*:\d+:\d+\)/gm) || []).slice(0, 5);
        return { bad, hscroll: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      // Phone: scroll to the end and prove the Ellie button and tab bar cover nothing interactive.
      if (w < 500 && !route.includes("~loading")) {
        const ov = await page.evaluate(async () => {
          window.scrollTo(0, document.documentElement.scrollHeight); await new Promise((r) => setTimeout(r, 300));
          const fab = document.getElementById("ellie-fab"), bar = document.querySelector(".rail");
          const covers = [fab, bar].filter(Boolean).map((e) => e.getBoundingClientRect());
          const hit = [...document.querySelectorAll("#view a, #view button, #view input, #view select, #view tr")].filter((e) => { if (e.checkVisibility && !e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return false; const r = e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight && covers.some((c) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top); });
          const fr = fab && fab.getBoundingClientRect(), br = bar && bar.getBoundingClientRect();
          return { hit: hit.map((e) => (e.textContent || e.tagName).trim().slice(0, 30)), fabAboveBar: !fr || !br || fr.bottom <= br.top };
        });
        await page.screenshot({ path: join(out, name.replace(".png", "_bottom.png")) });
        if (ov.hit.length) s.bad.push(`covered at bottom: ${ov.hit.join(" | ")}`);
        if (!ov.fabAboveBar) s.bad.push("Ellie button overlaps the tab bar");
      }
      const issue = [s.bad.length && `text: ${s.bad.join(", ")}`, s.hscroll && "horizontal scroll", errs.length && `errors: ${errs.join(" | ")}`].filter(Boolean);
      if (issue.length) findings.push({ route, w, issue });
      console.log(`${issue.length ? "WARN" : "ok  "} ${name}${issue.length ? " · " + issue.join("; ") : ""}`);
      errs.length = 0;
    }
    await ctx.close();
  }
  writeFileSync(join(out, "sweep.json"), JSON.stringify({ base: baseArg === "local" ? `local public/ + ${API}` : B, at: new Date().toISOString(), routes: ROUTES, findings }, null, 2));
  console.log(`\n${findings.length} finding(s) → ${out}`);
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
