import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/carelead";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`https://patient-360.raava.dev/#care`, { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
for (let k=0;k<3;k++){ const m=p.getByText(/^Show \d+ more of/); if(await m.count()){await m.first().click(); await p.waitForTimeout(500);} }
const t = await p.innerText("body");
const rows = t.split("\n").filter(l=>/^(Alert|Watch|Keep an eye on|On track)\t/.test(l) || /Acute care risk/.test(l));
console.log(rows.length); console.log(rows.slice(-30).join("\n"));
const tiers = {}; for (const l of t.split("\n")) { const m=l.match(/^(\w[\w ]*?)\t/); if(m) tiers[m[1]]=(tiers[m[1]]||0)+1; } console.log(tiers);
// model card
await p.getByText("Everything the model card holds").first().click(); await p.waitForTimeout(600);
const t2 = await p.innerText("body"); const i=t2.indexOf("Everything the model card holds");
const mc = t2.slice(i, i+200000);
for (const kw of ["auroc","AUROC","threshold","calibrat","brier","alert","watch","test"]) {
  const lines = mc.split("\n").filter(l=>l.toLowerCase().includes(kw.toLowerCase())).slice(0,8);
  console.log(`## ${kw}:`, lines.join(" | ").slice(0,900));
}
await p.getByText("Everything the model card holds").first().scrollIntoViewIfNeeded();
await p.screenshot({ path: `${D}/07-model-card.png` });
await b.close();
