export const panelText = (p) => p.evaluate(()=>{const i=document.querySelector('input[aria-label="Ask Ellie"]'); if(!i) return '(no panel)'; let e=i; for(let n=0;n<6&&e;n++){e=e.parentElement; if(e && e.innerText.length>200) break;} return e?e.innerText:'';});
export async function ask(p, q, shot) {
  const inp = p.locator('input[aria-label="Ask Ellie"]');
  if (!(await inp.isVisible())) { await p.getByRole('button',{name:'Ask Ellie'}).click(); await p.waitForTimeout(500); }
  const before = await panelText(p);
  const t0 = Date.now();
  await inp.fill(q); await inp.press("Enter");
  let last = '', stable = 0;
  for (let i=0;i<60;i++) { await p.waitForTimeout(500); const now = await panelText(p); if (now===last && now!==before && !/thinking|…$/i.test(now.slice(-200))) { if(++stable>=4) break; } else stable=0; last=now; }
  const after = await panelText(p);
  const dt = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`\n=== Q: ${q}  (${dt}s)  URL: ${p.url()}`);
  console.log("NEW:", after.startsWith(before.replace(/\nWho is most[\s\S]*$/,'').slice(0,50)) ? after.slice(Math.max(0, before.indexOf('\nWho is most')>0? before.indexOf('\nWho is most')-0:0)) : after);
  if (shot) await p.screenshot({path:shot});
}
