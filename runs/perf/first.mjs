import { chromium } from "playwright";
const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
const t0 = Date.now(); const ev = [];
p.on("requestfinished", (r) => ev.push([Date.now() - t0, r.url().replace("https://patient-360.raava.dev", "").slice(0, 60)]));
await p.goto("https://patient-360.raava.dev/#today");
await p.waitForFunction(() => document.getElementById("view")?.dataset.ready && !document.querySelector('#view [aria-busy="true"]'));
console.log("ready", Date.now() - t0); ev.forEach((e) => console.log(e[0], e[1])); await b.close();
