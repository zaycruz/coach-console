// A navigation tool for simulated users (and people): open a route on a deployed Patient 360, optionally click things and
// fill fields, then print where you ended up, what the page says, and what you can click next. Writes go to the test
// namespace (p360test cookie), so nothing reaches production storage.
//   node scripts/visit.mjs <base-url> <route> [--width 1440|390] [--click "<button/link text or CSS selector>"]...
//                          [--fill "<selector>=<text>"]... [--check "<selector>"]... [--shot <file.png>] [--wait <ms>]
// Example: node scripts/visit.mjs https://x.workers.dev today --click "Log outcome" --check "input[value=Nurse]" --click "Save"
import { chromium } from "playwright";
const [,, base, route, ...rest] = process.argv;
if (!base || !route) { console.error("usage: visit.mjs <base> <route> [--width N] [--click X]... [--fill sel=text]... [--check sel]... [--shot file] [--wait ms]"); process.exit(2); }
const opts = { width: 1440, steps: [], shot: "", wait: 400 };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i], v = rest[i + 1];
  if (k === "--width") { opts.width = Number(v); i++; }
  else if (k === "--click" || k === "--fill" || k === "--check") { opts.steps.push([k.slice(2), v]); i++; }
  else if (k === "--shot") { opts.shot = v; i++; }
  else if (k === "--wait") { opts.wait = Number(v); i++; }
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.width > 400 ? 900 : 844 } });
await ctx.addCookies([{ name: "p360test", value: "1", url: base }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const settle = async () => { await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.dataset.ready && !v.querySelector('[aria-busy="true"]'); }, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(opts.wait); };
await page.goto(`${base}/#${route.replace(/^#/, "")}`); await settle();
const find = (what) => {
  if (/^[.#\[]|^[a-z]+[.#\[]|^(button|a|input|select|textarea|dialog|summary)\b/.test(what)) return page.locator(what).first();
  return page.locator(`dialog[open] button:has-text("${what}"), dialog[open] a:has-text("${what}"), dialog[open] label:has-text("${what}"), button:has-text("${what}"), a:has-text("${what}"), summary:has-text("${what}"), label:has-text("${what}")`).first();
};
for (const [kind, what] of opts.steps) {
  try {
    if (kind === "click") { await find(what).click({ timeout: 8000 }); await settle(); console.log(`[click] ${what} → ${await page.evaluate(() => location.hash)}`); }
    else if (kind === "fill") { const [sel, ...t] = what.split("="); await page.fill(sel, t.join("=")); console.log(`[fill] ${sel}`); }
    else if (kind === "check") { await page.locator(what).first().check({ timeout: 8000 }); console.log(`[check] ${what}`); }
  } catch (e) { console.log(`[${kind}] ${what}: FAILED (${String(e.message).split("\n")[0]})`); }
}
const hash = await page.evaluate(() => location.hash);
const text = await page.evaluate(() => { const d = document.querySelector("dialog[open]"); const v = document.getElementById("view"); const t = (el) => (el ? el.innerText.replace(/\n{3,}/g, "\n\n").trim() : ""); return (d ? "=== OPEN SHEET ===\n" + t(d) + "\n=== PAGE ===\n" : "") + t(document.querySelector(".topbar")) + "\n" + t(v); });
const clickable = await page.evaluate(() => [...document.querySelectorAll("#view a, #view button, #view summary, dialog[open] button, dialog[open] label, .nav-link, #assistant-fab")].map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 60).filter((t, i, a) => a.indexOf(t) === i).slice(0, 80));
const toast = await page.locator("#toast").innerText().catch(() => "");
if (opts.shot) await page.screenshot({ path: opts.shot, fullPage: opts.width > 400 });
console.log(`=== AT ${hash} (${opts.width}px) ===\n${text.slice(0, 12000)}\n\n=== YOU CAN CLICK (use --click "<text>") ===\n${clickable.join(" | ")}${toast ? `\n=== TOAST === ${toast}` : ""}${errors.length ? `\n=== PAGE ERRORS === ${errors.join(" | ")}` : ""}`);
await browser.close();
