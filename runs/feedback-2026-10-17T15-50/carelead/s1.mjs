import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://patient-360.raava.dev", { waitUntil: "networkidle" });
await p.screenshot({ path: `${D}/01-home.png`, fullPage: true });
console.log(p.url());
console.log((await p.innerText("body")).slice(0, 3000));
await b.close();
