import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`https://patient-360.raava.dev/#p-c5-P0002.c5`, { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
await p.screenshot({ path: `${D}/11-maria-coaching-tab.png`, fullPage: true });
const h = await p.innerText("body"); const k=h.indexOf("Coaching calls\n"); console.log(h.slice(k, k+4000));
await b.close();
