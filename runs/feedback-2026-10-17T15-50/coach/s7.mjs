import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#live-c5-P0002", { waitUntil: "networkidle" });
  await p.waitForTimeout(12000);
  const m = await p.locator("main").innerText();
  console.log("LIVE PAGE LAST CALL (fresh browser):\n", m.slice(m.indexOf("Last call"), m.indexOf("Today’s call")));
  await p.screenshot({ path: `${D}/13-recap-fresh-reload.png` });
  // full transcript expand
  await p.getByText(/Full transcript/).first().click();
  await p.waitForTimeout(800);
  const m2 = await p.locator("main").innerText();
  console.log("EXPANDED:\n", m2.slice(m2.indexOf("Full transcript"), m2.indexOf("Full transcript") + 1500));
  // patient page
  await p.goto("https://patient-360.raava.dev/#p-c5-P0002.c5", { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  await p.screenshot({ path: `${D}/14-patient-c5-after.png`, fullPage: true });
  console.log("PATIENT C5:\n", (await p.locator("main").innerText()).slice(0, 2000));
  // Calls list
  await p.goto("https://patient-360.raava.dev/#calls", { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  await p.screenshot({ path: `${D}/15-calls-list.png` });
  console.log("CALLS:\n", (await p.locator("main").innerText()).slice(0, 2000));
  // Today
  await p.goto("https://patient-360.raava.dev/#today", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  console.log("TODAY first rows:\n", (await p.locator("main").innerText()).slice(0, 700));
} finally { await b.close(); }
