import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#today", { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  const t = await p.locator("main").innerText().catch(() => p.innerText("body"));
  console.log("TODAY:\n", t.slice(0, 600));
  await p.screenshot({ path: `${D}/19-today-after-call.png` });
  await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: "Escalate to care team" }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${D}/20-escalate-click.png` });
  const body = await p.innerText("body");
  const i = body.search(/not connected|escalat|sent|logged/i);
  console.log("ESCALATE result:", body.slice(Math.max(0,i-100), i+300));
  // language of patient page in Spanish? any language toggle?
  console.log("lang toggles:", await p.$$eval("button, select", es => es.map(e => (e.innerText||"").trim()).filter(x => /espa|spanish|idioma|lang/i.test(x))));
} finally { await b.close(); }
