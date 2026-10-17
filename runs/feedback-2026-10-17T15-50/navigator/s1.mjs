import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}});
await p.goto("https://patient-360.raava.dev", {waitUntil:"networkidle"});
await p.screenshot({path:"01-home.png"});
console.log(await p.evaluate(()=>document.body.innerText.slice(0,3000)));
const els = await p.$$eval("button,a,input,textarea,[role=button]", es=>es.map(e=>`${e.tagName} ${e.getAttribute('aria-label')||''} | ${(e.innerText||e.placeholder||'').slice(0,50)}`));
console.log(els.join("\n"));
await b.close();
