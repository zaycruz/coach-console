import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${D}/x.wav`] });
try {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["microphone"], { origin: "https://patient-360.raava.dev" });
  const p = await ctx.newPage();
  p.on("console", m => { if (m.type() === "error") console.log("CONSOLE ERR", m.text()); });
  await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  await p.getByRole("link", { name: "Start call" }).first().click();
  await p.waitForTimeout(2500);
  console.log("URL", p.url());
  await p.screenshot({ path: `${D}/07-start-call.png`, fullPage: true });
  console.log((await p.innerText("main").catch(() => p.innerText("body"))).slice(0, 5000));
  const els = await p.$$eval("main a, main button, main input, main textarea, main select, main [role=radio]", es => es.map(e => `${e.tagName} ${e.getAttribute("href")||""} | ${(e.innerText||e.value||e.placeholder||e.getAttribute("aria-label")||"").trim().slice(0,60)} ${e.disabled?"[disabled]":""}`));
  console.log(els.join("\n"));
} finally { await b.close(); }
