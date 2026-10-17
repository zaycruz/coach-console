import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const id = process.argv[2] || "S71188550";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`https://patient-360.raava.dev/#p-c1-${id}.c1`, { waitUntil: "networkidle" });
await p.waitForTimeout(2000);
await p.getByText("More detail").first().click().catch(()=>{});
await p.waitForTimeout(500);
const b0 = await p.innerText("main").catch(()=>p.innerText("body"));
const i = b0.indexOf("More detail"); console.log("=== MORE DETAIL\n", b0.slice(i, i+2500));
for (const tab of ["Health chart","Rough weeks","Glucose","Coaching calls"]) {
  await p.getByText(tab, { exact: true }).first().click();
  await p.waitForTimeout(1500);
  const f = `${D}/05-${id}-${tab.replace(/ /g,'-').toLowerCase()}.png`;
  await p.screenshot({ path: f, fullPage: true });
  const t = await p.innerText("body");
  const j = t.indexOf("Coaching calls\n");
  console.log(`=== ${tab} (${p.url()})\n`, t.slice(j, j+2500));
}
await b.close();
