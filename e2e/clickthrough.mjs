// E2E click-through for the static prototype. Short-lived: opens prototype/index.html over file://,
// visits every screen and state at desktop and phone width, screenshots each, checks for console errors
// and horizontal page scroll, then follows the demo flow by clicking. Writes runs/<timestamp>/manifest.json.
// Run: npm run e2e   (exit code 1 if any check fails)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page0 = pathToFileURL(join(root, "prototype/index.html")).href;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(root, "runs", stamp);
mkdirSync(out, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();
const results = [];
let failed = 0;

async function open(vp, theme) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], colorScheme: theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(page0 + "#/today");
  await page.waitForSelector("#view > *");
  return { ctx, page, errors };
}

const { ctx: c0, page: p0 } = await open("desktop", "light");
const ids = await p0.evaluate(() => ({
  c3: MOCK.modules.c3.list[0].survivorId, c4: MOCK.modules.c4.list[0].survivorId, c5: MOCK.modules.c5.list[0].survivorId,
  call: MOCK.modules.c5.detail[MOCK.modules.c5.list[0].survivorId].charts.latestCallId,
}));
await c0.close();

const ROUTES = [
  ["today", "#/today", "Today"],
  ["survivor-demo", "#/s/demo", "Composite demo survivor"],
  ["survivor-c3", `#/s/c3/${ids.c3}`, "Bad Week Radar"],
  ["survivor-c4", `#/s/c4/${ids.c4}`, "Dose and Timing"],
  ["survivor-c5", `#/s/c5/${ids.c5}`, "Coach’s Copilot"],
  ["calls", "#/calls", "Calls"],
  ["call-review", `#/call/${ids.call}`, "Call review"],
  ["patient-demo", "#/patient/demo", "Survivor app"],
  ["care-team-c1", "#/care-team", "Care team risk"],
  ["research", "#/research", "Research"],
];
const STATES = ["ready", "loading", "empty", "error"];
const STATE_SCREENS = new Set(["today", "survivor-demo", "calls", "call-review", "patient-demo"]);

for (const vp of Object.keys(VIEWPORTS)) {
  for (const theme of ["light", "dark"]) {
    const { ctx, page, errors } = await open(vp, theme);
    for (const [name, hash, expect] of ROUTES) {
      for (const st of STATES) {
        if (st !== "ready" && !(STATE_SCREENS.has(name) && theme === "light")) continue;
        errors.length = 0;
        await page.goto(page0 + hash + `?state=${st}`);
        await page.waitForTimeout(120);
        const text = await page.locator("#view").innerText();
        const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const stateOk = st === "ready" ? true
          : st === "loading" ? (await page.locator('[aria-busy="true"]').count()) > 0
          : st === "empty" ? /Nothing here yet/.test(text)
          : /Couldn’t load/.test(text);
        const checks = { expectedText: text.toLowerCase().includes(expect.toLowerCase()), noHorizontalScroll: sw <= 0, noConsoleErrors: errors.length === 0, stateRendered: stateOk };
        const ok = Object.values(checks).every(Boolean);
        if (!ok) failed++;
        const file = `${name}--${st}--${vp}--${theme}.png`;
        await page.screenshot({ path: join(out, file), fullPage: true });
        results.push({ screen: name, hash, state: st, viewport: vp, theme, ok, checks, overflowPx: sw, errors: [...errors], screenshot: file });
        console.log(`${ok ? "PASS" : "FAIL"} ${name} ${st} ${vp} ${theme}${ok ? "" : " " + JSON.stringify({ checks, sw, errors })}`);
      }
    }
    await ctx.close();
  }
}

// Demo flow by clicking: morning triage -> top "act today" survivor -> review call -> flag banner -> survivor app.
const flow = [];
{
  const { ctx, page, errors } = await open("desktop", "light");
  const step = async (label, fn) => { let ok = true, note = ""; try { note = (await fn()) || ""; } catch (e) { ok = false; note = String(e); failed++; } flow.push({ label, ok, note }); console.log(`${ok ? "PASS" : "FAIL"} flow: ${label} ${note}`); };
  await step("Today shows an Act today group", async () => { await page.locator("#g-today").waitFor(); });
  await step("Open first Act today survivor", async () => { await page.locator(".r-row.s-today").first().click(); await page.locator("#panel-c5").waitFor(); return page.url().split("#")[1]; });
  await step("Survivor page shows flag banner and escalate", async () => { await page.locator("#panel-c5 .banner.alert").waitFor(); await page.getByRole("button", { name: "Escalate to care team" }).click(); await page.locator("#toast:not([hidden])").waitFor(); });
  await step("Open call review", async () => { await page.getByRole("link", { name: "Review call →" }).click(); await page.locator(".transcript .line.flagged").first().waitFor(); });
  await step("Jump to flagged line", async () => { await page.getByRole("link", { name: /Jump to line/ }).first().click(); });
  await page.screenshot({ path: join(out, "flow-call-review.png"), fullPage: false });
  await step("Filter roster to C4", async () => { await page.goto(page0 + "#/today"); await page.locator('[data-filter="c4"]').click(); const n = await page.locator(".r-row").count(); return `${n} rows`; });
  await step("Survivor app switches to Spanish", async () => { await page.goto(page0 + "#/patient/demo"); await page.locator('[data-lang="es"]').click(); await page.getByText("Su meta de esta semana").first().waitFor(); });
  await page.screenshot({ path: join(out, "flow-survivor-app-es.png"), fullPage: true });
  await step("No console errors during flow", async () => { if (errors.length) throw new Error(errors.join("; ")); });
  await ctx.close();
}

await browser.close();
const manifest = { run: stamp, page: "prototype/index.html", total: results.length, failed, flow, results };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${results.length} screen checks, ${flow.length} flow steps, ${failed} failed -> runs/${stamp}/manifest.json`);
process.exit(failed ? 1 : 0);
