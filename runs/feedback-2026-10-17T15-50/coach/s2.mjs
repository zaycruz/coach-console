import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#today", { waitUntil: "networkidle" });
  await p.waitForTimeout(1000);
  await p.locator('a[href="#p-c5-P0002"]', { hasText: "Open" }).click();
  await p.waitForTimeout(2000);
  console.log("URL", p.url());
  await p.screenshot({ path: `${D}/02-patient-maria.png`, fullPage: true });
  console.log((await p.innerText("main").catch(() => p.innerText("body"))).slice(0, 6000));
  const els = await p.$$eval("main a, main button, main [role=tab], main input, main textarea", es => es.map(e => `${e.tagName} ${e.getAttribute("href")||""} | ${(e.innerText||e.value||e.placeholder||e.getAttribute("aria-label")||"").trim().slice(0,60)}`));
  console.log(els.join("\n"));
} finally { await b.close(); }
