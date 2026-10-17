import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}});
await p.goto("https://patient-360.raava.dev", {waitUntil:"networkidle"});
// Try keyboard shortcuts first, like Jen would
for (const k of ["/", "Control+k", "Meta+k", "?"]) {
  await p.keyboard.press(k); await p.waitForTimeout(400);
  const vis = await p.locator('input[aria-label="Ask Ellie"]').isVisible();
  const focused = await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName);
  console.log("key", k, "ellie visible:", vis, "focus:", focused);
  if (vis) break;
}
await p.screenshot({path:"02-after-shortcuts.png"});
const panelText = async () => p.evaluate(()=>{const i=document.querySelector('input[aria-label="Ask Ellie"]'); let e=i; for(let n=0;n<6&&e;n++){e=e.parentElement; if(e && e.innerText.length>200) break;} return e?e.innerText:'';});
if (!(await p.locator('input[aria-label="Ask Ellie"]').isVisible())) { await p.getByRole('button',{name:'Ask Ellie'}).click(); await p.waitForTimeout(600); }
console.log("focus after open:", await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName));
await p.screenshot({path:"03-ellie-open.png"});
console.log("PANEL:\n"+await panelText());
await b.close();
