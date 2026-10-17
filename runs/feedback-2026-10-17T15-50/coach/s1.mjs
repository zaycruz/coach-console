import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  console.log("URL", p.url(), "TITLE", await p.title());
  await p.screenshot({ path: `${D}/01-landing.png`, fullPage: true });
  console.log((await p.innerText("body")).slice(0, 3000));
  const els = await p.$$eval("a,button,[role=tab],input,select", es => es.map(e => `${e.tagName} ${e.getAttribute("href")||""} | ${(e.innerText||e.value||e.placeholder||e.getAttribute("aria-label")||"").trim().slice(0,60)}`));
  console.log(els.slice(0, 80).join("\n"));
} finally { await b.close(); }
