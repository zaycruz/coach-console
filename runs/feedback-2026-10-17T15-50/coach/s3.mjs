import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle" });
  await p.waitForTimeout(1000);
  await p.getByRole("link", { name: "Coaching calls" }).first().click();
  await p.waitForTimeout(2000);
  console.log("URL", p.url());
  await p.screenshot({ path: `${D}/03-coaching-tab.png`, fullPage: true });
  console.log((await p.innerText("main").catch(() => p.innerText("body"))).slice(0, 7000));
  // other tabs quickly
  for (const t of ["Hospital risk", "Rough weeks", "Glucose"]) {
    await p.locator("main").getByRole("link", { name: t }).first().click();
    await p.waitForTimeout(1200);
    const txt = await p.innerText("main");
    console.log("=== TAB", t, p.url(), "\n", txt.slice(0, 900));
  }
  await p.screenshot({ path: `${D}/04-glucose-tab.png`, fullPage: false });
} finally { await b.close(); }
