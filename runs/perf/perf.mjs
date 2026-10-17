import { chromium } from "playwright";
const B = "https://patient-360.raava.dev";
const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
const reqs = []; p.on("requestfinished", async (r) => { const t = r.timing(); const s = await r.sizes().catch(() => ({})); reqs.push([r.url().replace(B, ""), Math.round(t.responseEnd), s.responseBodySize]); });
const ready = async () => p.waitForFunction(() => document.getElementById("view")?.dataset.ready && !document.querySelector('#view [aria-busy="true"]'), null, { timeout: 60000 });
for (const h of ["today", "patients", "p-c3-P02185", "p-c3-P02185.c3", "care", "calls", "live-c3-P02185"]) {
  const t0 = Date.now(); await p.goto(`${B}/#${h}`); await ready(); console.log(`ready ${h}: ${Date.now() - t0} ms`);
}
const t1 = Date.now(); await p.goto(`${B}/#p-c4-N0072`); await ready(); await p.waitForFunction(() => /check before|own summary/i.test(document.querySelector(".ellie-insight")?.textContent || ""), null, { timeout: 60000 }); console.log(`insight N0072: ${Date.now() - t1} ms`);
await p.locator("#ellie-fab").click();
for (const q of ["who is at most risk of hospitalization", "open up that first patient", "what is on this page?", "what does time in range mean?"]) {
  const n = await p.locator("#ellie-msgs .m.a").count(); const t = Date.now();
  await p.fill("#ellie-q", q); await p.press("#ellie-q", "Enter");
  await p.waitForFunction((n) => { const m = [...document.querySelectorAll("#ellie-msgs .m.a")]; return m.length > n && !/Thinking/.test(m[m.length - 1].textContent); }, n, { timeout: 90000 });
  console.log(`ellie "${q}": ${Date.now() - t} ms`);
}
reqs.sort((a, b) => b[1] - a[1]); console.log("slowest requests:"); reqs.slice(0, 12).forEach((r) => console.log(" ", r[1], "ms", r[2], "B", r[0].slice(0, 70)));
console.log("fallback-data fetched:", reqs.some((r) => r[0].includes("fallback-data")), "total requests", reqs.length);
await b.close();
