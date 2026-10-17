// E2E against the deployed Patient 360 (live module data). Writes runs/<ts>/ with screenshots + manifest.json.
// Checks: every screen renders from live data at desktop and phone width; the page stays light with square
// corners even when the OS asks for dark; the Patients count equals the four list endpoints and Today stays
// short; module chips say "live"; pills navigate; every program view ends in the raw response; a live call
// tags typed lines through Clef and saves, and the recap matches the record; AI assistant opens pages and
// answers; with C3 forced down (its API requests aborted in the browser) the app falls back to the saved copy.
// Also: Health chart is a summary with AI Insight; Hospital-risk rows open the patient; no Patient's app or nav icons;
// AI assistant follow-ups ("open that first patient", "start a call with them"); Play-as-live demo; the mic records a spoken
// clip (Chromium fake mic fed a `say` wav) and Whisper transcribes it into a line.
// Usage: node e2e/live.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const B = process.argv[2] || "https://patient-360.raava.dev";
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = new URL(`../runs/${ts}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const checks = [];
const ok = (name, pass, detail = "") => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

// Everything this test writes (saved calls, hand-offs) goes to the "test:" namespace: cookie in the browser, header here.
const TEST_COOKIE = { name: "p360test", value: "1", url: B };
const j = async (p) => (await fetch(B + p, { headers: { "x-p360-test": "1" } })).json();
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
  ["today", "Call today"], ["patients", "Patients"],
  [`p-${ids.c3}`, "Health chart"], [`p-${ids.c3}.c3`, "How sure"],
  [`p-${ids.c4}`, "Health chart"], [`p-${ids.c4}.c4`, "How sure"],
  [`p-${ids.c5}`, "Health chart"], [`p-${ids.c5}.c5`, "Calls"],
  [`p-${ids.c1}`, "Health chart"], [`p-${ids.c1}.c1`, "How sure"],
  [`p-${ids.c4}.c3`, "Not enrolled"], [`p-${ids.c4}.c1`, "Not enrolled"],
  ["calls", "Calls"], [`call-${flaggedCall.callId}`, "Transcript"],
  [`live-${c5WithCall}`, "Last call"], [`live-${ids.c4}`, "No previous call"],
  ["care", "Hospital risk"], ["research", "Research"],
  ["today~error", "Couldn"], ["today~empty", "Nothing here yet"], ["today~loading", ""],
];
const browser = await chromium.launch();
const manifest = { base: B, ts, total, ids, call: flaggedCall.callId, shots: [] };

async function newPage(opts, abortC3 = false) {
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([TEST_COOKIE]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|net::ERR_FAILED|status of 404|status of 429/.test(m.text())) errors.push(m.text()); });
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
  // One corner radius per component, from the token sheet (POLISH.md); a component not on this page is skipped.
  ok("consistent corners on cards, buttons, pills, KPIs, tags", radii.filter((r) => !r.endsWith(" none")).every((r) => r.endsWith(" 0px")), radii.join(", "));
  await shot(page, "dark-os-light-page_1280.png", false);
  await ctx.close();
}

// 3. counts, sources, pills, drill-down, live call, AI assistant
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${B}/#patients`); await settle(page);
  const count = Number(await page.locator(".roster").getAttribute("data-count"));
  ok("Patients count = c1 + c3 + c4 + c5 list endpoints", count === total, `${count} vs ${total}`);
  const src = await page.locator(".mode .src").evaluateAll((els) => els.map((e) => e.textContent + ":" + e.className));
  ok("C1, C3, C4, C5 chips say live", src.length === 4 && src.every((c) => c.includes("s-live")), src.join(" | "));
  const optToday = await page.locator('a.fpill[href="#patients-today"]').first().innerText().catch(() => "");
  // A patient handed off or logged in this test namespace leaves Call today on the page; the API queue does not know about hand-offs.
  const handedIds = new Set((await j("/api/handoffs")).map((h) => h.patientId));
  const apiToday = (await j("/api/today")).rows.filter((r) => r.horizon === "today" && !handedIds.has(r.id)).length;
  ok("Patients 'Act today' count = Today queue count (one list everywhere)", new RegExp(`\\b${apiToday}\\b`).test(optToday), `${optToday} vs ${apiToday}`);
  for (const m of ["c3", "c4", "c1"]) {
    await page.locator(`[data-filter="${m}"]`).click(); await settle(page);
    // One line per row: no tag clusters. Real · MEPS is the only tag, on hospital-risk rows, because real is the exception.
    ok(`${m} rows on Patients: one line, no tag cluster`, (await page.locator(`tr[data-pid^="${m}-"] .tag`).count()) === 0 && (m !== "c1" || (await page.locator(`tr[data-pid^="c1-"] .tag-real`).count()) > 0));
  }
  await page.locator(`[data-filter="all"]`).click();
  await page.goto(`${B}/#today`); await settle(page);
  // Today: one ranked queue across programs, each row with a reason, its data type and (when known) language.
  const tq = await (await fetch(`${B}/api/today`)).json();
  const qMods = new Set(tq.rows.map((r) => r.mod));
  ok("Today API: one queue with rows from C1, C3, C4 and C5", ["c1", "c3", "c4", "c5"].every((m) => qMods.has(m)), [...qMods].join(","));
  ok("Today API: every row has a whole reason, never cut with \"…\"", tq.rows.every((r) => r.reason && !/…/.test(r.reason)), (tq.rows.find((r) => /…/.test(r.reason || "")) || {}).reason || "");
  ok("Today API: C1 rows say real MEPS data, the rest synthetic", tq.rows.every((r) => (r.mod === "c1") === /MEPS/.test(r.data)));
  // Patients handed off in this test namespace have left Call today; the rest of the week sits behind "Show more", so expand it first.
  await page.locator("[data-week-more]").click({ timeout: 2000 }).then(() => settle(page)).catch(() => {});
  const todayRows = await page.locator(".queue .q-row").count();
  const domMods = new Set(await page.locator(".queue .q-row").evaluateAll((els) => els.map((e) => e.dataset.mod)));
  // One fixed rule: every coaching-call medical or distress flag is on Call today (unless handed off in this test namespace).
  const safetyPids = [...new Set(calls.filter((c) => (c.flags || []).some((f) => f.kind === "medical" || f.kind === "distress")).map((c) => c.survivorId))];
  const todayIds = new Set(tq.rows.filter((r) => r.horizon === "today").map((r) => r.id));
  const missing = safetyPids.filter((id) => !todayIds.has(id) && !handedIds.has(id));
  ok("Today API: every coaching-call medical/distress flag is Call today", missing.length === 0, `${safetyPids.length} flagged patients, missing: ${missing.join(", ") || "none"}`);
  const stale = tq.rows.filter((r) => r.mod === "c5" && r.horizon === "today" && /months ago|years ago/.test(String(r.reason)));
  ok("Today API: stale coaching-call flags read 'Close the loop' with the same reason format", stale.every((r) => /^Close the loop · (Medical concern|Distress), call \d+, .+ ago: “/.test(String(r.reason))), stale.map((r) => r.reason.slice(0, 50)).join(" | ") || "none stale");
  const apiMods = new Set(tq.rows.filter((r) => !handedIds.has(r.id)).map((r) => r.mod));
  ok("Today page: rows from every program the queue holds", todayRows >= 4 && [...apiMods].every((m) => domMods.has(m)), `${todayRows} rows, ${[...domMods].join(",")} vs ${[...apiMods].join(",")}`);
  const nowN = tq.rows.filter((r) => r.horizon === "today" && !handedIds.has(r.id)).length;
  ok("Today API: Act today holds red flags only, no glucose rows", !tq.rows.some((r) => r.horizon === "today" && r.mod === "c4"), `${nowN} today`);
  ok("Today page: hero count matches the API's Act today rows", new RegExp(`\\b${nowN}\\b`).test(await page.locator(".today-hero, .t-hero, h1, .hero").first().innerText().catch(() => "")) || (await page.getByText(new RegExp(`^${nowN}$`)).count()) > 0, `${nowN}`);
  // Provenance once: Real · MEPS on every hospital-risk row and nowhere else; no "Synthetic" tag on rows (the page chrome says it once).
  ok("Today page: Real · MEPS on hospital-risk rows only, no Synthetic tags", (await page.locator(".q-row[data-mod=c1] .tag-real").count()) === (await page.locator(".q-row[data-mod=c1]").count()) && (await page.locator(".q-row:not([data-mod=c1]) .tag-real").count()) === 0 && (await page.locator(".q-row .chip-data").count()) === 0);
  ok("Today page: interpreter chip names the language", /Interpreter · (Spanish|Kreyòl)/.test(await page.locator(".queue .chip-lang.need").first().innerText().catch(() => "")));
  ok("Today page: the cohort note is a ? popover, not a banner", /Four programs, four separate cohorts/.test(await page.locator(".pill-synthetic").getAttribute("title")) && (await page.locator(".cohorts").count()) === 0);
  ok("Today page: one count line, no KPI boxes", (await page.locator(".counts").count()) === 1 && (await page.locator(".stat-strip, .summary").count()) === 0);
  // One primary per region: Start call is filled only on Call today rows; every row still has Start call and Log outcome.
  const todayNow = await page.locator("#today-now .q-row").count();
  ok("Today page: every row is numbered with an owner chip and two actions; the primary button sits only on the lead Call today row", (await page.locator(".q-row .q-n").count()) === todayRows && ((await page.locator(".q-row .chip-own").count()) === todayRows || (await page.locator("#today-now .sub-s").innerText()).includes("Owner:")) && (await page.locator(".q-row a.btn").count()) === todayRows && (await page.locator(".q-row [data-log]").count()) === todayRows && (await page.locator("#today-now .q-row:first-child .btn.primary").count()) === 1 && (await page.locator(".q-row .btn.primary").count()) === 1 && todayNow > 0, `1 primary (lead row) of ${todayRows}`);
  const domWhy = await page.locator(".queue .q-row .q-why").allInnerTexts();
  ok("Today page: no reason truncated with \"…\" (rows wrap)", domWhy.length > 0 && !domWhy.some((t) => /…/.test(t)), domWhy.find((t) => /…/.test(t)) || `${domWhy.length} reasons`);
  await shot(page, "today_1280.png");
  await page.locator(".q-row .btn.primary").first().click(); await settle(page);
  ok("Today: first action opens a call or the risk view", /#(live-|p-c1-)/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));

  await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
  await page.locator(".pill", { hasText: "Glucose" }).click(); await settle(page);
  ok("pill click opens the program view (hero, charts, How sure; no actions)", (await page.evaluate(() => location.hash)) === `#p-${ids.c4}.c4` && (await page.locator(".hero-card").count()) === 1 && (await page.locator("#sure").count()) === 1 && (await page.locator(".do, .plan-list, .next-acts").count()) === 0, await page.evaluate(() => location.hash));
  ok("the tab shows the full charts, each with its lead sentence", (await page.locator("#view .card svg.chart").count()) >= 2 && (await page.locator(".tile, .gauge").count()) === 0);
  ok("program view ends in the full raw response", (await page.locator("details#raw summary").innerText()).includes("Everything this program sent"));
  await page.goto(`${B}/#p-${ids.c4}`); await settle(page);
  await page.locator("a.tile").first().click(); await settle(page);
  ok("Health chart tile drills into the program view", (await page.evaluate(() => location.hash)) === `#p-${ids.c4}.c4`);

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

  // live call: typed lines are tagged by Clef, then saved and shown as the next recap
  const before = (await j(`/api/calls/${quiet.survivorId}`)).length;
  await page.goto(`${B}/#live-${quiet.survivorId}`); await settle(page);
  // Coach and patient alternate in the typed box, starting with the coach. Five coach lines, so the call has a score.
  const typed = ["How have the last few days been for you?", "Honestly tired, but I want to get back to walking.",
    "It sounds like walking matters to you, even on tired days.", "Yes. I used to walk every morning.",
    "What would a first short walk look like this week?", "Maybe ten minutes after lunch.",
    "Ten minutes after lunch feels doable to you.", "I think so.",
    "Would it help to plan which days?", "Sure.", "You know what works for your body best."];
  for (const t of typed.slice(0, 3)) { await page.fill("#typed", t); await page.press("#typed", "Enter"); }
  await page.waitForFunction(() => document.querySelectorAll("#live-lines .tag.live").length >= 2, null, { timeout: 90000 }).catch(() => {});
  const tagged = await page.locator("#live-lines .tag.live").count();
  ok("live call: typed lines get Clef tags", tagged >= 2, `${tagged} of 3`);
  await shot(page, "live-call-tagged_1280.png");
  // The rest go in fast and End call is pressed at once, while Clef tags are still in flight (zay: "coach score drops").
  for (const t of typed.slice(3)) { await page.fill("#typed", t); await page.press("#typed", "Enter"); }
  await page.locator("#endcall").click();
  await page.waitForFunction(() => document.querySelector("#recap h2") && /Last call/.test(document.querySelector("#recap h2").textContent), null, { timeout: 30000 }).catch(() => {});
  let after = before;
  for (let k = 0; k < 18 && after === before && before < 20; k++) { await new Promise((r) => setTimeout(r, 5000)); after = (await j(`/api/calls/${quiet.survivorId}?t=${Date.now()}`)).length; } // KV read-after-write lags up to 60 s
  ok("live call: saved, and the recap now shows it", after === Math.min(before + 1, 20) && (await page.locator("#recap").innerText()).includes("Logged in Patient 360"), `${before} → ${after}`);
  // The saved score is the live formula over every saved line: End call waited for the tags in flight, so none dropped out.
  const mine = (await j(`/api/calls/${quiet.survivorId}?t=${Date.now()}`)).filter((x) => x && Array.isArray(x.lines) && x.lines.length === typed.length).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const rescored = mine ? await page.evaluate((ls) => window.P360.liveScore(ls.map((l) => ({ speaker: l.speaker, live: l.tag ? { tag: l.tag } : null }))), mine.lines) : undefined;
  const untagged = mine ? mine.lines.filter((l) => !l.tag).length : -1;
  ok("live call: every line saved with its Clef tag, none dropped at End call", untagged === 0, mine ? `${untagged} of ${mine.lines.length} untagged` : "saved call not found");
  ok("live call: saved coach score equals the live score of the same lines", !!mine && mine.score != null && mine.score === rescored, mine ? `saved ${mine.score} · live formula ${rescored}` : "saved call not found");
  manifest.savedCallPatient = quiet.survivorId;

  // AI assistant: opens a page instantly, answers a question through the model
  await page.goto(`${B}/#today`); await settle(page);
  await page.locator("#assistant-fab").click();
  await page.fill("#assistant-q", "open glucose for N0072"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction(() => location.hash === "#p-c4-N0072.c4", null, { timeout: 15000 }).catch(() => {});
  ok("AI assistant opens a patient's glucose page", (await page.evaluate(() => location.hash)) === "#p-c4-N0072.c4", await page.evaluate(() => location.hash));
  await settle(page);
  await page.fill("#assistant-q", "What does time in range mean for this patient?"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#assistant-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 90000 }).catch(() => {});
  const ans = await page.locator("#assistant-msgs .m.a").last().innerText();
  ok("AI assistant answers from the patient on screen", /range|70|180/i.test(ans) && !/couldn/i.test(ans), ans.slice(0, 160).replace(/\s+/g, " "));
  await shot(page, "assistant_1280.png", false);
  await page.fill("#assistant-q", "fever 39 on chemo, what should the patient do?"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#assistant-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 30000 }).catch(() => {});
  const red = await page.locator("#assistant-msgs .m.a").last().innerText();
  ok("AI assistant: red-flag question gets the emergency answer", /emergency|ER today|24-hour/i.test(red) && !/3021|rate limit|error/i.test(red), red.slice(0, 120).replace(/\s+/g, " "));
  manifest.assistant = ans;

  // AI assistant: follow-ups resolve to the patients it just named; the panel closes
  await page.fill("#assistant-q", "who is at most risk of hospitalization"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#assistant-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 90000 }).catch(() => {});
  const firstCite = await page.locator("#assistant-msgs .m.a").last().locator('a[href^="#p-"]').first().getAttribute("href").catch(() => null);
  ok("AI assistant names patients for a risk question", !!firstCite, firstCite || (await page.locator("#assistant-msgs .m.a").last().innerText()).slice(0, 160));
  await page.fill("#assistant-q", "open up that first patient"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction((h) => location.hash.startsWith(h), firstCite, { timeout: 60000 }).catch(() => {});
  const fh = await page.evaluate(() => location.hash);
  ok("AI assistant follow-up: 'that first patient' opens the one it named", !!firstCite && fh.startsWith(firstCite), `${fh} vs ${firstCite}`);
  await settle(page);
  await page.fill("#assistant-q", "start a call with them"); await page.press("#assistant-q", "Enter");
  await page.waitForFunction(() => location.hash.startsWith("#live-"), null, { timeout: 60000 }).catch(() => {});
  ok("AI assistant follow-up: 'start a call with them' opens the call", firstCite && (await page.evaluate(() => location.hash)) === "#live-" + firstCite.slice(3).split(".")[0], await page.evaluate(() => location.hash));
  await shot(page, "assistant-followup_1280.png", false);
  await page.locator("#assistant-close").click();
  ok("AI assistant closes", await page.locator("#assistant").isHidden());

  // No old assistant name anywhere in the rendered page (zay: "remove all ellie language").
  for (const r of ["today", "patients", "p-x-L1", "calls"]) {
    await page.goto(`${B}/#${r}`); await settle(page);
    await page.waitForFunction(() => { const e = document.querySelector(".assistant-insight"); return !e || (e.dataset.state && e.dataset.state !== "loading"); }, null, { timeout: 45000 }).catch(() => {});
    const hits = await page.evaluate(() => (document.documentElement.outerHTML.match(/.{0,40}ellie.{0,40}/gi) || []).slice(0, 3));
    ok(`#${r}: rendered DOM has no "ellie"`, hits.length === 0, hits.join(" | "));
  }
  // The old /api/ellie alias is gone: only /api/assistant answers.
  const oldRoute = await fetch(`${B}/api/ellie`, { method: "POST", headers: { "content-type": "application/json", "x-p360-test": "1" }, body: JSON.stringify({ question: "Who needs a call today?" }) });
  ok("/api/ellie no longer answers", oldRoute.status !== 200, `HTTP ${oldRoute.status}`);

  // One fact, one place: every tile number appears exactly once on its overview; no patient second person anywhere we write.
  const voice = [];
  for (const pid of ["x-L1", "c4-N0072", "c3-P03000", "c1-S71188550", "c5-P0002"]) {
    await page.goto(`${B}/#p-${pid}`); await settle(page);
    await page.waitForFunction(() => !document.querySelector("#view .is-loading, #view [aria-busy=true]"), null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => { const e = document.querySelector(".assistant-insight"); return e && e.dataset.state && e.dataset.state !== "loading"; }, null, { timeout: 45000 }).catch(() => {});
    // The tile's number with its unit ("1 line", "10.3%"), counted as a whole token (not inside "13" or "21.0%").
    const nums = (await page.locator("#view .tile .t-num").allInnerTexts()).map((n) => n.replace(/\s+/g, " ").trim()), text = await page.locator("#view").innerText();
    const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rep = nums.filter((n) => n && n !== "Not recorded").map((n) => [n, (text.replace(/\s+/g, " ").match(new RegExp(`(?<![\\d.])${esc(n)}(?![\\d])`, "g")) || []).length]).filter(([, k]) => k !== 1);
    ok(`${pid} overview: each tile number appears exactly once`, nums.length > 0 && rep.length === 0, rep.length ? rep.map(([n, k]) => `${n}×${k}`).join(", ") : nums.join(", "));
    for (const tab of ["", ".c1", ".c3", ".c4", ".c5"]) {
      if (tab && !(pid.startsWith("x-") || pid.startsWith(tab.slice(1)))) continue;
      if (tab) { await page.goto(`${B}/#p-${pid}${tab}`); await settle(page); }
      // Our copy only: quoted patient words, the coach's translated call script and call transcripts are theirs.
      const mine = await page.locator("#view").evaluate((v) => { const c = v.cloneNode(true); c.querySelectorAll(".handout, .c-row, blockquote, .calls-list, .t-quote, .hypo-tr, details#raw").forEach((e) => e.remove()); return c.innerText.replace(/“[^”]*”/g, ""); });
      const hit = (mine.match(/[^.\n]{0,40}\byour? \w+[^.\n]{0,30}/gi) || []).filter((m) => /\byour /i.test(m));
      if (hit.length) voice.push(`${pid}${tab}: ${hit[0].trim()}`);
    }
  }
  for (const r of ["today", "patients"]) { await page.goto(`${B}/#${r}`); await settle(page); const t = (await page.locator("#view").innerText()).replace(/“[^”]*”/g, ""); const h = t.match(/[^.\n]{0,40}\byour [^.\n]{0,30}/i); if (h) voice.push(`${r}: ${h[0].trim()}`); }
  ok("Clinician voice: no \"your \" in our copy (overviews, tabs, Today, Patients)", voice.length === 0, voice.slice(0, 3).join(" | "));

  // Health chart = summary + AI Insight; detail lives in the pills
  await page.goto(`${B}/#p-${ids.c3}`); await settle(page);
  await page.waitForFunction(() => { const e = document.querySelector(".assistant-insight"); return e && /check before acting|program’s own (summary|record)/i.test(e.textContent); }, null, { timeout: 60000 }).catch(() => {});
  const ins = await page.locator(".assistant-insight").innerText().catch(() => "");
  ok("Health chart shows the brief: one labelled headline, no bullets", /^Why now/.test(ins.trim()) && /AI summary|own summary/i.test(ins) && ins.split(/\s+/).length < 60 && (await page.locator(".assistant-insight li").count()) === 0, ins.replace(/\s+/g, " ").slice(0, 200));
  ok("Health chart has one Plan with owner and due chips and no Do next", (await page.locator(".plan-list li").count()) > 0 && (await page.locator(".plan-list .chip-own").count()) === (await page.locator(".plan-list li").count()) && (await page.locator(".do-next, .next-acts").count()) === 0);
  ok("Health chart has no raw dump (that lives in the program tab)", (await page.locator("details#raw").count()) === 0);
  await shot(page, "health-chart-insight_1280.png");

  // Hospital risk: the whole row opens the patient's C1 view
  await page.goto(`${B}/#care`); await settle(page);
  await page.locator(`tr.row-link[data-href$=".c1"] td.hl`).first().click(); await settle(page);
  ok("Hospital risk: clicking a row opens that patient's C1 view", /^#p-c1-.+\.c1$/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
  ok("no Patient's app link and no nav icons", (await page.locator('a[href^="#app"]').count()) === 0 && (await page.locator(".nav-link .ico").count()) === 0);

  // Play a stored call as if live
  await page.goto(`${B}/#calls`); await settle(page);
  await page.locator("[data-play]").first().click(); await settle(page);
  await page.waitForFunction(() => document.querySelectorAll("#live-lines .line, #live-lines [data-line], #live-lines > div:not(.live-empty)").length >= 3, null, { timeout: 30000 }).catch(() => {});
  const played = await page.locator("#live-lines > *:not(.live-empty)").count();
  const box = await page.locator("#live-lines").evaluate((e) => getComputedStyle(e).overflowY + " " + e.clientHeight);
  ok("Play as live: lines stream into a fixed scrolling box", played >= 3 && /auto|scroll/.test(box) && parseInt(box.split(" ")[1]) < 900, `${played} lines, ${box}`);
  await shot(page, "play-as-live_1280.png", false);
  await page.locator("#replaystop").click().catch(() => {});

  // call review still runs Clef live
  await page.goto(`${B}/#call-${flaggedCall.callId}`); await settle(page);
  await page.locator("[data-run]").click();
  await page.waitForFunction(() => document.querySelectorAll(".tag.live").length >= 4, null, { timeout: 90000 }).catch(() => {});
  const liveTags = await page.locator(".tag.live").count();
  ok("call review: live Clef tags arrive", liveTags >= 4, `${liveTags} tagged lines`);
  await page.waitForFunction(() => !document.querySelector("[data-run][disabled]"), null, { timeout: 180000 }).catch(() => {});
  const agree = await page.locator("#agree").innerText().catch(() => "");
  ok("call review: agreement with supervisor computed", /%/.test(agree), agree.replace(/\s+/g, " "));
  await shot(page, "call-live-clef_1280.png");
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
  const chip = await page.locator(".mode .src", { hasText: "Rough weeks" }).getAttribute("class");
  ok("C3 down: Patients still complete from the saved copy", count === total, `${count} vs ${total}`);
  ok("C3 down: banner says saved copy", /Rough weeks.*isn.t answering.*saved copy/i.test(banner), banner.replace(/\s+/g, " "));
  ok("C3 down: status chip turns amber", /s-fallback/.test(chip), chip);
  await shot(page, "fallback-c3-down_patients.png", false);
  await page.goto(`${B}/#p-${ids.c3}.c3`); await settle(page);
  const body = await page.locator("#view").innerText();
  ok("C3 down: patient page renders from the saved copy", /How sure/.test(body) && /saved copy/i.test(body) && (await page.locator("svg.chart").count()) > 0);
  await shot(page, "fallback-c3-down_patient.png");
  await page.goto(`${B}/#p-${ids.c4}.c4`); await settle(page);
  ok("C3 down: C4 pages stay live", (await page.locator(".mode .src", { hasText: "Glucose" }).getAttribute("class")).includes("s-live"));
  ok("C3 down: no page errors", !errors.length, errors.join(" | "));
  await ctx.close();
}

// What a judge sees (no test cookie): test calls never reach #calls, and no saved call is listed twice.
{
  const clean = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await clean.newPage();
  await page.goto(`${B}/#calls`); await page.waitForSelector("#view[data-ready]", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
  const logged = await page.locator("#view .c-row").evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, " ").trim()).filter((t) => /Logged in Patient 360/.test(t)));
  const dup = logged.length - new Set(logged).size;
  ok("#calls: no duplicate 'Logged in Patient 360' rows, no test data", dup === 0 && !logged.some((t) => /P00949/.test(t) && /Marisol/.test(t)), `${logged.length} logged rows, ${dup} duplicates`);
  const pub = await (await fetch(`${B}/api/calls`)).json();
  ok("API without the test marker returns no test records", Array.isArray(pub) && !pub.some((x) => x.test), `${pub.length} entries`);
  await clean.close();
}
await browser.close();

// 5. the mic: Chromium's fake mic plays a spoken wav; Whisper must turn it into a line
{
  // A fixed clip (macOS `say`: "Hi, how have you been feeling since our last call?", 16 kHz mono WAV), so this runs on any OS.
  const wav = new URL("./fixtures/mic.wav", import.meta.url).pathname;
  const mb = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  const ctx = await mb.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  await ctx.addCookies([TEST_COOKIE]);
  const page = await ctx.newPage();
  await page.goto(`${B}/#live-${quiet.survivorId}`); await settle(page);
  await page.locator("#mic").click();
  await page.waitForFunction(() => /feel|call/i.test(document.getElementById("live-lines")?.innerText || ""), null, { timeout: 60000 }).catch(() => {});
  const heard = await page.locator("#live-lines").innerText();
  ok("mic: a spoken line is recorded and transcribed", /feel|call/i.test(heard), heard.replace(/\s+/g, " ").slice(0, 160));
  await shot(page, "mic-transcribed_1280.png", false);
  await page.locator("#mic").click().catch(() => {});
  await mb.close();
}
manifest.checks = checks;
manifest.passed = checks.filter((c) => c.pass).length;
manifest.failed = checks.filter((c) => !c.pass).length;
writeFileSync(dir + "manifest.json", JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.passed} passed, ${manifest.failed} failed → runs/${ts}/`);
process.exit(manifest.failed ? 1 : 0);
