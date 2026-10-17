import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://patient-360.raava.dev/#care", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.getByText("S71188550 · 85M · prostate").first().click();
await p.waitForTimeout(2500);
console.log(p.url());
await p.screenshot({ path: `${D}/04-patient-S71188550.png`, fullPage: true });
console.log((await p.innerText("body")).slice(0, 6000));
// list tabs/buttons
const tabs = await p.locator('[role=tab], button').allInnerTexts();
console.log("BUTTONS:", JSON.stringify(tabs));
await b.close();
