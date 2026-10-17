import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${D}/x.wav`] });
const t0 = Date.now(); const ts = () => ((Date.now()-t0)/1000).toFixed(1)+"s";
try {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["microphone"], { origin: "https://patient-360.raava.dev" });
  const p = await ctx.newPage();
  p.on("console", m => { if (["error","warning"].includes(m.type())) console.log(ts(), "CONSOLE", m.type(), m.text().slice(0,200)); });
  p.on("response", r => { const u = r.url(); if (!/\.(js|css|png|svg|woff2?)$/.test(u) && !u.includes("fonts")) console.log(ts(), "NET", r.status(), r.request().method(), u.slice(0,120)); });
  await p.goto("https://patient-360.raava.dev/#live-c5-P0002", { waitUntil: "networkidle" });
  await p.waitForTimeout(6000);
  const handoff = await p.locator("main").innerText();
  console.log(ts(), "LAST CALL BLOCK:\n", handoff.slice(handoff.indexOf("Last call"), handoff.indexOf("Today’s call")));
  await p.screenshot({ path: `${D}/08-handoff-note.png` });

  // MIC
  await p.getByRole("button", { name: "Start mic" }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${D}/09-mic-on.png` });
  console.log(ts(), "mic buttons:", await p.$$eval("main button", es => es.map(e => e.innerText.trim()).filter(Boolean).join(" | ")));
  await p.waitForTimeout(14000);
  console.log(ts(), "after 15s mic, lines area:\n", (await p.locator("main").innerText()).split("Add line")[1]?.slice(0, 1500));
  await p.screenshot({ path: `${D}/10-mic-transcribed.png`, fullPage: true });
  const stop = p.getByRole("button", { name: /Stop mic|Stop/ }).first();
  if (await stop.count()) { await stop.click(); console.log(ts(), "stopped mic"); }
  await p.waitForTimeout(2000);

  // TYPED LINES
  const input = p.getByPlaceholder("Or type what was said, press Enter");
  const say = async (who, txt, lang) => {
    await p.getByRole("button", { name: who, exact: true }).click();
    if (lang) await p.locator("main select").selectOption({ label: lang });
    await input.fill(txt); await input.press("Enter");
    await p.waitForTimeout(2500);
  };
  await say("Coach", "Last time you told me you get out of breath walking to the kitchen. Is that still happening?");
  await say("Patient", "Yes, and now my ankles are swollen and I feel dizzy when I stand up.");
  await say("Coach", "It sounds like you've been worried about this and still trying to keep going.");
  await say("Patient", "Sí, mija, tengo miedo. No quiero molestar al doctor.", "Spanish");
  await say("Coach", "Entiendo. ¿Le parece bien si hablo hoy con su equipo de cuidado?", "Spanish");
  await say("Patient", "Okay, that's fine. Thank you.", "English");
  await say("Coach", "What feels doable for bedtime this week?");
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${D}/11-typed-lines.png`, fullPage: true });
  const m = await p.locator("main").innerText();
  console.log(ts(), "AFTER TYPING:\n", m.slice(m.indexOf("Today’s call")).slice(0, 4000));

  // END & SAVE
  const end = p.getByRole("button", { name: "End and save call" });
  console.log(ts(), "end disabled?", await end.isDisabled());
  await end.click();
  await p.waitForTimeout(6000);
  console.log(ts(), "URL after save", p.url());
  await p.screenshot({ path: `${D}/12-after-save.png`, fullPage: true });
  console.log((await p.locator("main").innerText()).slice(0, 3500));
} finally { await b.close(); }
