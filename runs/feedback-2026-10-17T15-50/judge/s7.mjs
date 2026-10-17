import { chromium } from "playwright";
const wav = new URL("./x.wav", import.meta.url).pathname;
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${wav}`] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(["microphone"], { origin: "https://patient-360.raava.dev" });
const p = await ctx.newPage();
const errs = [];
p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
p.on("pageerror", e => errs.push("PAGEERR "+e.message));
await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle", timeout: 60000 });
await p.waitForTimeout(800);
await p.getByRole("link", { name: "Start call" }).or(p.getByRole("button", { name: "Start call" })).first().click();
await p.waitForTimeout(3000);
console.log("URL", p.url());
await p.screenshot({ path: "17-desktop-start-call.png" });
console.log("--- CALL\n", (await p.innerText("body")).slice(0, 3000));
const btns = await p.$$eval("button", es => es.map(e => e.innerText.trim()).filter(Boolean));
console.log("BTNS", btns.join(" | "));
// try to start mic
const start = p.getByRole("button", { name: /start|mic|listen|begin/i }).first();
if (await start.count()) { await start.click().catch(e=>console.log("clickerr",e.message)); }
await p.waitForTimeout(20000);
await p.screenshot({ path: "18-desktop-live-call-mic.png" });
console.log("--- AFTER MIC\n", (await p.innerText("body")).slice(0, 4000));
console.log("ERRS", errs.join("\n"));
await b.close();
