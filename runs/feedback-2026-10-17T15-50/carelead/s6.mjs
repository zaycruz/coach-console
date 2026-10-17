import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const id of ["S9C1421D3","S8CF2CD79"]) {
  await p.goto(`https://patient-360.raava.dev/#care`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  await p.getByText(new RegExp(`^${id} ·`)).first().click();
  await p.waitForTimeout(2000);
  await p.getByText("More detail").first().click().catch(()=>{});
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${D}/06-patient-${id}.png`, fullPage: true });
  const t = await p.innerText("body");
  const i = t.indexOf("C1 · Hospital risk");
  console.log(`=== ${id} ${p.url()}\n`, t.slice(i, i+3000));
  // health chart
  await p.getByText("Health chart", { exact: true }).first().click(); await p.waitForTimeout(1200);
  const h = await p.innerText("body"); const k = h.indexOf("Ellie’s insight");
  console.log("--- health chart insight:\n", h.slice(k, k+900));
}
await b.close();
