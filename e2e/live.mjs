// E2E against the deployed Patient 360 (live module data). Writes runs/<ts>/ with screenshots + manifest.json.
// Checks: every screen renders from live data at desktop and phone width, light and dark; the roster count equals
// the three list endpoints; the module status chips say "live"; one call review gets live Copilot tags; and with
// C3 forced down (its API requests aborted in the browser) the app falls back to the saved copy and keeps working.
// Usage: node e2e/live.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const B = process.argv[2] || "https://patient-360.raava.dev";
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = new URL(`../runs/${ts}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const checks = [];
const ok = (name, pass, detail = "") => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

const j = async (p) => (await fetch(B + p)).json();
const [l3, l4, l5, calls] = await Promise.all([j("/api/c3/survivors"), j("/api/c4/survivors"), j("/api/c5/survivors"), j("/api/c5/calls")]);
const total = l3.length + l4.length + l5.length;
const ids = { c3: l3[0].survivorId, c4: l4[0].survivorId, c5: l5[0].survivorId };
const flaggedCall = calls.find((c) => c.flags.length) || calls[0];
ok("list endpoints answer", total > 0, `c3 ${l3.length}, c4 ${l4.length}, c5 ${l5.length}`);

const ROUTES = [
  ["today", "Today"],
  [`p-${ids.c3}`, "Health chart"], [`p-${ids.c3}.c3`, "What to do"],
  [`p-${ids.c4}`, "Health chart"], [`p-${ids.c4}.c4`, "What to do"],
  [`p-${ids.c5}`, "Health chart"], [`p-${ids.c5}.c5`, "Calls"],
  [`p-${ids.c4}.c3`, "Not enrolled"], [`p-${ids.c4}.c1`, "Hospital risk isn"],
  ["calls", "Calls"], [`call-${flaggedCall.callId}`, "Transcript"],
  [`app-${ids.c4}`, "Good morning"], [`app-${ids.c3}`, "Good morning"],
  ["care", "Hospital risk"], ["research", "Research"],
  ["today~error", "Couldn"], ["today~empty", "Nothing here yet"], ["today~loading", ""],
];
const browser = await chromium.launch();
const manifest = { base: B, ts, total, ids, call: flaggedCall.callId, shots: [] };

async function newPage(opts, abortC3 = false) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|net::ERR_FAILED|status of 404/.test(m.text())) errors.push(m.text()); });
  if (abortC3) await page.route("**/api/c3/**", (r) => r.abort());
  return { ctx, page, errors };
}
async function settle(page) {
  await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.dataset.ready && !v.querySelector('[aria-busy="true"]') || (location.hash.includes("~loading")); }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// 1. every screen, desktop + phone, light + dark
for (const [w, h, scheme] of [[1280, 900, "light"], [390, 844, "light"], [1280, 900, "dark"], [390, 844, "dark"]]) {
  const { ctx, page, errors } = await newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
  for (const [route, text] of ROUTES) {
    if (scheme === "dark" && route.includes("~")) continue;
    await page.goto(`${B}/#${route}`);
    await settle(page);
    const body = await page.locator("#view").innerText();
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    const name = `${route.replace(/[^a-z0-9.~-]/gi, "_")}_${w}_${scheme}.png`;
    await page.screenshot({ path: dir + name, fullPage: w > 400 || route.startsWith("p-") });
    manifest.shots.push(name);
    ok(`${route} @${w} ${scheme}`, (!text || body.toLowerCase().includes(text.toLowerCase())) && !hscroll && !errors.length, [hscroll && "horizontal scroll", errors.length && errors.join(" | "), text && !body.toLowerCase().includes(text.toLowerCase()) && `missing "${text}"`].filter(Boolean).join("; "));
    errors.length = 0;
  }
  if (w === 1280 && scheme === "light") {
    // 2. roster count and live sources
    await page.goto(`${B}/#today`); await settle(page);
    const count = Number(await page.locator(".roster").getAttribute("data-count"));
    ok("roster count = c3 + c4 + c5 list endpoints", count === total, `${count} vs ${total}`);
    const src = await page.locator(".mode .src").evaluateAll((els) => els.map((e) => e.className));
    ok("C3, C4, C5 chips say live", src.slice(0, 3).every((c) => c.includes("s-live")), src.join(" | "));
    ok("C3 and C4 rows carry tags", (await page.locator('.r-row[data-pid^="c4-"] .tag').count()) > 0 && (await page.locator('.r-row[data-pid^="c3-"] .tag').count()) > 0);
    // pills navigate between the patient's views
    await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
    await page.locator(".pill", { hasText: "Glucose" }).click(); await settle(page);
    ok("pill click opens the program view", (await page.evaluate(() => location.hash)) === `#p-${ids.c4}.c4` && (await page.locator(".do").count()) > 0, await page.evaluate(() => location.hash));
    ok("advice sits beside its chart", (await page.locator(".do .do-visual svg.chart").count()) >= 2);
    // 3. live Copilot on one call
    await page.goto(`${B}/#call-${flaggedCall.callId}`); await settle(page);
    await page.locator("[data-run]").click();
    await page.waitForFunction(() => document.querySelectorAll(".tag.live").length >= 4, null, { timeout: 90000 }).catch(() => {});
    const liveTags = await page.locator(".tag.live").count();
    ok("live Copilot tags arrive from /api/c5/turn", liveTags >= 4, `${liveTags} tagged lines`);
    await page.waitForFunction(() => !document.querySelector("[data-run][disabled]"), null, { timeout: 180000 }).catch(() => {});
    const agree = await page.locator("#agree").innerText().catch(() => "");
    ok("agreement with supervisor computed", /%/.test(agree), agree.replace(/\s+/g, " "));
    await page.screenshot({ path: dir + "call-live-copilot_1280.png", fullPage: true });
    manifest.shots.push("call-live-copilot_1280.png");
    manifest.copilot = { liveTags, agree };
  }
  await ctx.close();
}

// 4. C3 forced down: requests to /api/c3/* are aborted; the saved copy must take over
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 900 } }, true);
  await page.goto(`${B}/#today`); await settle(page);
  const count = Number(await page.locator(".roster").getAttribute("data-count"));
  const banner = await page.locator(".banner.warn").innerText().catch(() => "");
  const chip = await page.locator(".mode .src").first().getAttribute("class");
  ok("C3 down: roster still complete from the saved copy", count === total, `${count} vs ${total}`);
  ok("C3 down: banner says saved copy", /C3.*isn.t answering.*saved copy/i.test(banner), banner.replace(/\s+/g, " "));
  ok("C3 down: status chip turns amber", /s-fallback/.test(chip), chip);
  await page.screenshot({ path: dir + "fallback-c3-down_today.png", fullPage: false });
  await page.goto(`${B}/#p-${ids.c3}.c3`); await settle(page);
  const body = await page.locator("#view").innerText();
  ok("C3 down: patient page renders from the saved copy", /What to do/.test(body) && /saved copy/i.test(body) && (await page.locator("svg.chart").count()) > 0);
  await page.screenshot({ path: dir + "fallback-c3-down_patient.png", fullPage: true });
  await page.goto(`${B}/#p-${ids.c4}.c4`); await settle(page);
  ok("C3 down: C4 pages stay live", (await page.locator(".mode .src").nth(1).getAttribute("class")).includes("s-live"));
  ok("C3 down: no page errors", !errors.length, errors.join(" | "));
  manifest.shots.push("fallback-c3-down_today.png", "fallback-c3-down_patient.png");
  await ctx.close();
}

await browser.close();
manifest.checks = checks;
manifest.passed = checks.filter((c) => c.pass).length;
manifest.failed = checks.filter((c) => !c.pass).length;
writeFileSync(dir + "manifest.json", JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.passed} passed, ${manifest.failed} failed → runs/${ts}/`);
process.exit(manifest.failed ? 1 : 0);
