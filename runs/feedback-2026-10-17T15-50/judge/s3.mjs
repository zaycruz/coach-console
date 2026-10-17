import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errs = [];
p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
p.on("pageerror", e => errs.push("PAGEERR "+e.message));
await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle", timeout: 60000 });
await p.waitForTimeout(1000);
// Hospital risk tab
await p.getByRole("tab", { name: /Hospital risk/ }).or(p.locator("main >> text=Hospital risk").first()).first().click();
await p.waitForTimeout(1200);
await p.screenshot({ path: "05-phone-maria-hosprisk-tab.png", fullPage: true });
console.log("--- HOSP TAB\n", (await p.innerText("main").catch(()=>p.innerText("body"))).slice(0, 2500));
// full detail link
await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle" });
await p.waitForTimeout(800);
await p.locator("text=Full Coaching calls detail").click();
await p.waitForTimeout(1500);
console.log("URL", p.url());
await p.screenshot({ path: "06-phone-maria-calls-detail.png", fullPage: true });
console.log("--- DETAIL\n", (await p.innerText("main").catch(()=>p.innerText("body"))).slice(0, 5000));
// Escalate
await p.goto("https://patient-360.raava.dev/#p-c5-P0002", { waitUntil: "networkidle" });
await p.waitForTimeout(800);
await p.locator("text=Escalate to care team").click();
await p.waitForTimeout(1500);
await p.screenshot({ path: "07-phone-escalate.png" });
console.log("--- ESC\n", (await p.innerText("body")).slice(0, 2500));
console.log("ERRS", errs.join("\n"));
await b.close();
