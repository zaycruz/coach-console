import { chromium } from "playwright";
const [,, base, outDir, ...routes] = process.argv;
const browser = await chromium.launch();
for (const [w,h] of [[1440,900],[390,844]]) {
  const ctx = await browser.newContext({ viewport:{width:w,height:h} });
  await ctx.addCookies([{ name:"p360test", value:"1", url: base }]);
  const page = await ctx.newPage();
  for (const r of routes) {
    await page.goto(`${base}/#${r}`);
    await page.waitForFunction(() => { const v=document.getElementById("view"); return v && v.dataset.ready && !v.querySelector('[aria-busy="true"]'); }, null, {timeout:30000}).catch(()=>{});
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/${r.replace(/[^a-z0-9.-]/gi,"_")}_${w}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log("done");
