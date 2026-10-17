import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#today", { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  console.log("TODAY:\n", (await p.innerText("body")).slice(150, 700));
  await p.goto("https://patient-360.raava.dev/#calls", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const row = p.locator("text=Osvaldo · call 5 · Spanish").first().locator("xpath=ancestor::*[.//button or .//a][1]");
  await row.getByText("Play as live").click();
  await p.waitForTimeout(3000);
  console.log("URL", p.url());
  await p.screenshot({ path: `${D}/16-play-live-start.png` });
  await p.waitForTimeout(40000);
  await p.screenshot({ path: `${D}/17-play-live-40s.png`, fullPage: true });
  const m = await p.locator("main").innerText();
  console.log("PLAY 40s:\n", m.slice(0, 4500));
  console.log("buttons:", await p.$$eval("main button", es => es.map(e => e.innerText.trim()).filter(Boolean).join(" | ")));
  // Hand off button if present
  const h = p.getByRole("button", { name: "Hand off to care team" }).first();
  if (await h.count()) {
    await h.click(); await p.waitForTimeout(3000);
    await p.screenshot({ path: `${D}/18-handoff-click.png` });
    const t = await p.locator("body").innerText();
    console.log("AFTER HANDOFF CLICK snippet:\n", t.slice(0, 1500));
  } else console.log("no handoff button visible yet");
} finally { await b.close(); }
