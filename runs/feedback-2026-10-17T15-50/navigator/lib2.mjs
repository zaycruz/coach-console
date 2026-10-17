import { panelText } from "./lib.mjs";
export { panelText };
export async function ask(p, q, shot) {
  const inp = p.locator('input[aria-label="Ask Ellie"]');
  if (!(await inp.isVisible())) { await p.getByRole('button',{name:'Ask Ellie'}).click(); await p.waitForTimeout(500); }
  const before = await panelText(p); const t0 = Date.now();
  await inp.fill(q); await inp.press("Enter");
  let last='', stable=0;
  for (let i=0;i<80;i++){ await p.waitForTimeout(500); const now=await panelText(p); if(now===last && now!==before && !now.includes("Thinking…")){ if(++stable>=4)break;} else stable=0; last=now; }
  const after = await panelText(p); const idx = after.lastIndexOf(q);
  console.log(`\n=== Q: ${q}  (${((Date.now()-t0)/1000).toFixed(1)}s)  URL: ${p.url()}\n` + after.slice(idx+q.length).replace(/\n(Open the first one|Start a call with them|Open the second one|Who [^\n]*\?|What does[^\n]*|Send)$/gm,'').trim() + `\n[chips: ${(after.match(/\n(Open the first one|Start a call with them|Open the second one|Who needs a call today\?|Who is most at risk of the hospital\?|What does time in range mean\?)/g)||[]).map(s=>s.trim()).join(' | ')}]`);
  if (shot) await p.screenshot({path:shot});
}
