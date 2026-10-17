import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errs = [];
p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
p.on("pageerror", e => errs.push("PAGEERR "+e.message));
await p.goto("https://patient-360.raava.dev/#p-c5-P0002.c5", { waitUntil: "networkidle", timeout: 60000 });
await p.waitForTimeout(800);
await p.locator("summary", { hasText: "Lines that need a person" }).click();
await p.waitForTimeout(800);
const det = p.locator("details", { hasText: "Lines that need a person" }).first();
await det.scrollIntoViewIfNeeded();
await det.screenshot({ path: "08-phone-flagged-line.png" }).catch(async()=>p.screenshot({path:"08-phone-flagged-line.png"}));
console.log("--- DETAILS\n", (await det.innerText()).slice(0,3000));
// Patients list
await p.locator("nav >> text=Patients").last().click().catch(()=>p.goto("https://patient-360.raava.dev/#patients"));
await p.waitForTimeout(1500);
await p.screenshot({ path: "09-phone-patients.png" });
console.log("--- PATIENTS\n", (await p.innerText("main").catch(()=>p.innerText("body"))).slice(0, 2500));
// Hospital risk
await p.goto("https://patient-360.raava.dev/#care", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.screenshot({ path: "10-phone-hospital-risk.png", fullPage: true });
console.log("--- CARE\n", (await p.innerText("main").catch(()=>p.innerText("body"))).slice(0, 3000));
// Calls
await p.goto("https://patient-360.raava.dev/#calls", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.screenshot({ path: "11-phone-calls.png" });
console.log("--- CALLS\n", (await p.innerText("main").catch(()=>p.innerText("body"))).slice(0, 2500));
console.log("ERRS", errs.join("\n"));
await b.close();
