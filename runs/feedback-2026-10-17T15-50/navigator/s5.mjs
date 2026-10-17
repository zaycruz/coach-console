import { chromium } from "playwright";
import { ask, panelText } from "./lib2.mjs";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}});
await p.waitForTimeout(40000); // let the rate limit cool
await p.goto("https://patient-360.raava.dev", {waitUntil:"networkidle"});
await ask(p, "is it safe to take ibuprofen after a kidney cancer surgery?", "13-medical-retry.png");
await ask(p, "who has the worst glucose control?");
await ask(p, "show me the glucose tab for the first one", "14-glucose-tab.png");
await ask(p, "open Rosa");
await ask(p, "who needs a call today?", "15-calls-today.png");
await ask(p, "start a call with the second one");
await p.reload({waitUntil:"networkidle"});
const vis = await p.locator('input[aria-label="Ask Ellie"]').isVisible();
console.log("\nAFTER RELOAD url", p.url(), "panel visible", vis);
if (!vis) { await p.getByRole('button',{name:'Ask Ellie'}).click(); await p.waitForTimeout(500); }
console.log("history kept after reload:", (await panelText(p)).includes("ibuprofen"));
await p.screenshot({path:"16-after-reload.png"});
await b.close();
