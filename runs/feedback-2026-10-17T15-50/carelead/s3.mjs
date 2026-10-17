import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://patient-360.raava.dev/#care", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
for (const t of ["What raises or lowers risk across everyone","Fairness check by group","Caveats"]) {
  await p.getByText(t).first().click(); await p.waitForTimeout(600);
}
const sec = p.getByText("What raises or lowers risk across everyone").first();
await sec.scrollIntoViewIfNeeded();
await p.screenshot({ path: `${D}/03-model-panels.png`, fullPage: true });
const body = await p.innerText("body");
const i = body.indexOf("What raises or lowers");
console.log(body.slice(i, i+8000));
await b.close();
