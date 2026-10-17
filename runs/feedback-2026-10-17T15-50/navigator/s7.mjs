import { chromium } from "playwright";
import { ask, panelText } from "./lib2.mjs";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}});
await p.waitForTimeout(75000);
await p.goto("https://patient-360.raava.dev", {waitUntil:"networkidle"});
await ask(p, "which patients in the glucose program are out of range?", "22-glucose-list.png");
await p.waitForTimeout(20000);
await ask(p, "open the first one's glucose tab", "23-glucose-open.png");
await p.waitForTimeout(20000);
// click the suggested chip instead of typing
await p.getByRole('button',{name:'What does time in range mean?'}).click().catch(e=>console.log('chip missing'));
await p.waitForTimeout(10000);
const t = await panelText(p); console.log("\nCHIP ANSWER:", t.slice(t.lastIndexOf('time in range mean?')).slice(0,700));
await p.screenshot({path:"24-tir-chip.png"});
await b.close();
