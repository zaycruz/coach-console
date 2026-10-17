// E2E against the deployed Patient 360 (live module data). Writes runs/<ts>/ with screenshots + manifest.json.
// Checks: every screen renders from live data at desktop and phone width; the page stays light with square
// corners even when the OS asks for dark; the Patients count equals the four list endpoints and Today stays
// short; module chips say "live"; pills navigate; every program view ends in the raw response; a live call
// tags typed lines through the Copilot and saves, and the recap matches the record; Ellie opens pages and
// answers; with C3 forced down (its API requests aborted in the browser) the app falls back to the saved copy.
// Not covered: the microphone (browser speech recognition needs a real mic and a person).
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
const [l1, l3, l4, l5, calls] = await Promise.all([j("/api/c1/survivors"), j("/api/c3/survivors"), j("/api/c4/survivors"), j("/api/c5/survivors"), j("/api/c5/calls")]);
const total = l1.length + l3.length + l4.length + l5.length;
const ids = { c1: l1[0].survivorId, c3: l3[0].survivorId, c4: l4[0].survivorId, c5: l5[0].survivorId };
const flaggedCall = calls.find((c) => c.flags.length) || calls[0];
const c5WithCall = calls.find((c) => c.survivorId)?.survivorId;
const latestFor = (pid) => calls.filter((c) => c.survivorId === pid).map((c) => c.date).sort().pop();
// A low-priority patient for the saved-call test, so the demo's top rows keep their real history.
const quiet = l3.filter((x) => x.status === "ok").pop() || l3[l3.length - 1];
ok("list endpoints answer", total > 0, `c1 ${l1.length}, c3 ${l3.length}, c4 ${l4.length}, c5 ${l5.length}`);

const ROUTES = [
  ["today", "Start here"], ["patients", "Patients"],
  [`p-${ids.c3}`, "Health chart"], [`p-${ids.c3}.c3`, "What to do"],
  [`p-${ids.c4}`, "Health chart"], [`p-${ids.c4}.c4`, "What to do"],
  [`p-${ids.c5}`, "Health chart"], [`p-${ids.c5}.c5`, "Calls"],
  [`p-${ids.c1}`, "Health chart"], [`p-${ids.c1}.c1`, "What to do"],
  [`p-${ids.c4}.c3`, "Not enrolled"], [`p-${ids.c4}.c1`, "Not enrolled"],
  ["calls", "Calls"], [`call-${flaggedCall.callId}`, "Transcript"],
  [`live-${c5WithCall}`, "Last call"], [`live-${ids.c4}`, "No previous call"],
  [`app-${ids.c4}`, "Good morning"], [`app-${ids.c1}`, "Good morning"],
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
const shot = async (page, name, full = true) => { await page.screenshot({ path: dir + name, fullPage: full }); manifest.shots.push(name); };

// 1. every screen, desktop + phone (light only by design)
for (const [w, h] of [[1280, 900], [390, 844]]) {
  const { ctx, page, errors } = await newPage({ viewport: { width: w, height: h } });
  for (const [route, text] of ROUTES) {
    await page.goto(`${B}/#${route}`);
    await settle(page);
    const body = await page.locator("#view").innerText();
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    await shot(page, `${route.replace(/[^a-z0-9.~-]/gi, "_")}_${w}.png`, w > 400 || route.startsWith("p-"));
    const has = !text || body.toLowerCase().includes(text.toLowerCase());
    ok(`${route} @${w}`, has && !hscroll && !errors.length, [hscroll && "horizontal scroll", errors.length && errors.join(" | "), !has && `missing "${text}"`].filter(Boolean).join("; "));
    errors.length = 0;
  }
  if (w === 390) {
    await page.goto(`${B}/#p-${ids.c4}.c4`); await settle(page);
    const reach = await page.evaluate(() => [...document.querySelectorAll(".pills .pill")].every((p) => { p.scrollIntoView(); const r = p.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; }));
    ok("phone: every pill can be reached", reach);
  }
  await ctx.close();
}

// 2. look: light even when the OS asks for dark; square corners
{
  const { ctx, page } = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lum = (bg.match(/\d+/g) || [0, 0, 0]).slice(0, 3).reduce((a, b) => a + +b, 0) / 3;
  ok("stays light when the OS is dark", lum > 200, bg);
  const radii = await page.evaluate(() => [".card", ".btn", ".pill", ".kpi", ".tag"].map((s) => { const e = document.querySelector(s); return e ? s + " " + getComputedStyle(e).borderTopLeftRadius : s + " none"; }));
  ok("square corners on cards, buttons, pills, KPIs, tags", radii.every((r) => r.endsWith(" 0px")), radii.join(", "));
  await shot(page, "dark-os-light-page_1280.png", false);
  await ctx.close();
}

// 3. counts, sources, pills, drill-down, live call, Ellie
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${B}/#patients`); await settle(page);
  const count = Number(await page.locator(".roster").getAttribute("data-count"));
  ok("Patients count = c1 + c3 + c4 + c5 list endpoints", count === total, `${count} vs ${total}`);
  const src = await page.locator(".mode .src").evaluateAll((els) => els.map((e) => e.textContent + ":" + e.className));
  ok("C1, C3, C4, C5 chips say live", src.length === 4 && src.every((c) => c.includes("s-live")), src.join(" | "));
  for (const m of ["c3", "c4", "c1"]) {
    await page.locator(`[data-filter="${m}"]`).click(); await settle(page);
    ok(`${m} rows carry tags on Patients`, (await page.locator(`tr[data-pid^="${m}-"] .tag`).count()) > 0);
  }
  await page.locator(`[data-filter="all"]`).click();
  await page.goto(`${B}/#today`); await settle(page);
  const todayRows = await page.locator(".t-row").count();
  ok("Today stays short (8 rows or fewer)", todayRows > 0 && todayRows <= 8, `${todayRows} rows`);
  await page.locator(".t-row .btn.primary").first().click(); await settle(page);
  ok("Today: first action opens a call or the risk view", /#(live-|p-c1-)/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));

  await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
  await page.locator(".pill", { hasText: "Glucose" }).click(); await settle(page);
  ok("pill click opens the program view", (await page.evaluate(() => location.hash)) === `#p-${ids.c4}.c4` && (await page.locator(".do").count()) > 0, await page.evaluate(() => location.hash));
  ok("advice sits beside its chart", (await page.locator(".do .do-visual svg.chart").count()) >= 2);
  ok("program view ends in the full raw response", (await page.locator("details#raw summary").innerText()).includes("Everything this program sent"));
  await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
  await page.locator("a.kpi").first().click(); await settle(page);
  ok("KPI card drills into the program view", (await page.evaluate(() => location.hash)) === `#p-${ids.c4}.c4`);

  // glucose: a series with no readings is named, never drawn as a phantom legend line
  const n72 = await j("/api/c4/survivors/c4-N0072").catch(() => null);
  const empty = n72 && n72.charts && n72.charts.dailyProfile && n72.charts.dailyProfile.series.find((s) => s.values.every((v) => v == null));
  if (empty) {
    await page.goto(`${B}/#p-c4-N0072.c4`); await settle(page);
    ok("glucose: empty series says so instead of a phantom legend", (await page.locator("#view").innerText()).includes(`No readings yet for ${empty.label}`), empty.label);
  }

  // recap equals the record
  await page.goto(`${B}/#live-${c5WithCall}`); await settle(page);
  ok("recap date = latest call on record", (await page.locator("#recap").getAttribute("data-date")) === latestFor(c5WithCall), `${await page.locator("#recap").getAttribute("data-date")} vs ${latestFor(c5WithCall)}`);
  await page.waitForSelector("#recap-ai .ai-label", { timeout: 60000 }).catch(() => {});
  ok("AI hand-off note arrives, labelled as AI", (await page.locator("#recap-ai .ai-label").count()) === 1);
  await shot(page, "live-recap_1280.png");

  // live call: typed lines are tagged by the Copilot, then saved and shown as the next recap
  const before = (await j(`/api/calls/${quiet.survivorId}`)).length;
  await page.goto(`${B}/#live-${quiet.survivorId}`); await settle(page);
  for (const t of ["How have the last few days been for you?", "Honestly tired, but I want to get back to walking.", "It sounds like walking matters to you, even on tired days."]) {
    await page.fill("#typed", t); await page.press("#typed", "Enter");
  }
  await page.waitForFunction(() => document.querySelectorAll("#live-lines .tag.live").length >= 2, null, { timeout: 90000 }).catch(() => {});
  const tagged = await page.locator("#live-lines .tag.live").count();
  ok("live call: typed lines get Copilot tags", tagged >= 2, `${tagged} of 3`);
  await shot(page, "live-call-tagged_1280.png");
  await page.locator("#endcall").click();
  await page.waitForFunction(() => document.querySelector("#recap h2") && /Last call/.test(document.querySelector("#recap h2").textContent), null, { timeout: 30000 }).catch(() => {});
  let after = before;
  for (let k = 0; k < 18 && after === before && before < 20; k++) { await new Promise((r) => setTimeout(r, 5000)); after = (await j(`/api/calls/${quiet.survivorId}?t=${Date.now()}`)).length; } // KV read-after-write lags up to 60 s
  ok("live call: saved, and the recap now shows it", after === Math.min(before + 1, 20) && (await page.locator("#recap").innerText()).includes("Logged in Patient 360"), `${before} → ${after}`);
  manifest.savedCallPatient = quiet.survivorId;

  // Ellie: opens a page instantly, answers a question through the model
  await page.goto(`${B}/#today`); await settle(page);
  await page.locator("#ellie-fab").click();
  await page.fill("#ellie-q", "open glucose for N0072"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction(() => location.hash === "#p-c4-N0072.c4", null, { timeout: 15000 }).catch(() => {});
  ok("Ellie opens a patient's glucose page", (await page.evaluate(() => location.hash)) === "#p-c4-N0072.c4", await page.evaluate(() => location.hash));
  await settle(page);
  await page.fill("#ellie-q", "What does time in range mean for this patient?"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#ellie-msgs .m.a")].pop(); return m && !/Thinking/.test(m.textContent); }, null, { timeout: 90000 }).catch(() => {});
  const ans = await page.locator("#ellie-msgs .m.a").last().innerText();
  ok("Ellie answers from the patient on screen", /range|70|180/i.test(ans) && !/couldn/i.test(ans), ans.slice(0, 160).replace(/\s+/g, " "));
  await shot(page, "ellie_1280.png", false);
  manifest.ellie = ans;

  // call review still runs the live Copilot
  await page.goto(`${B}/#call-${flaggedCall.callId}`); await settle(page);
  await page.locator("[data-run]").click();
  await page.waitForFunction(() => document.querySelectorAll(".tag.live").length >= 4, null, { timeout: 90000 }).catch(() => {});
  const liveTags = await page.locator(".tag.live").count();
  ok("call review: live Copilot tags arrive", liveTags >= 4, `${liveTags} tagged lines`);
  await page.waitForFunction(() => !document.querySelector("[data-run][disabled]"), null, { timeout: 180000 }).catch(() => {});
  const agree = await page.locator("#agree").innerText().catch(() => "");
  ok("call review: agreement with supervisor computed", /%/.test(agree), agree.replace(/\s+/g, " "));
  await shot(page, "call-live-copilot_1280.png");
  manifest.copilot = { liveTags, agree };
  ok("no page errors in the flows", !errors.length, errors.join(" | "));
  await ctx.close();
}

// 4. C3 forced down: requests to /api/c3/* are aborted; the saved copy must take over
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 900 } }, true);
  await page.goto(`${B}/#patients`); await settle(page);
  const count = Number(await page.locator(".roster").getAttribute("data-count"));
  const banner = await page.locator(".banner.warn").innerText().catch(() => "");
  const chip = await page.locator(".mode .src", { hasText: "C3" }).getAttribute("class");
  ok("C3 down: Patients still complete from the saved copy", count === total, `${count} vs ${total}`);
  ok("C3 down: banner says saved copy", /C3.*isn.t answering.*saved copy/i.test(banner), banner.replace(/\s+/g, " "));
  ok("C3 down: status chip turns amber", /s-fallback/.test(chip), chip);
  await shot(page, "fallback-c3-down_patients.png", false);
  await page.goto(`${B}/#p-${ids.c3}.c3`); await settle(page);
  const body = await page.locator("#view").innerText();
  ok("C3 down: patient page renders from the saved copy", /What to do/.test(body) && /saved copy/i.test(body) && (await page.locator("svg.chart").count()) > 0);
  await shot(page, "fallback-c3-down_patient.png");
  await page.goto(`${B}/#p-${ids.c4}.c4`); await settle(page);
  ok("C3 down: C4 pages stay live", (await page.locator(".mode .src", { hasText: "C4" }).getAttribute("class")).includes("s-live"));
  ok("C3 down: no page errors", !errors.length, errors.join(" | "));
  await ctx.close();
}

await browser.close();
manifest.checks = checks;
manifest.passed = checks.filter((c) => c.pass).length;
manifest.failed = checks.filter((c) => !c.pass).length;
writeFileSync(dir + "manifest.json", JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.passed} passed, ${manifest.failed} failed → runs/${ts}/`);
process.exit(manifest.failed ? 1 : 0);
