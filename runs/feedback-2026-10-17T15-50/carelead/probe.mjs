import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`https://patient-360.raava.dev/#care`, { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
await p.getByText("Ask Ellie").first().click(); await p.waitForTimeout(800);
console.log(await p.evaluate(()=>[...document.querySelectorAll('input,textarea,[contenteditable]')].map(e=>e.outerHTML.slice(0,200)).join("\n")));
await p.screenshot({ path: "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead/probe.png" });
await b.close();
