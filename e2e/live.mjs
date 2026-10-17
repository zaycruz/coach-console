// E2E against the deployed Patient 360 (live module data). Writes runs/<ts>/ with screenshots + manifest.json.
// Checks: every screen renders from live data at desktop and phone width; the page stays light with square
// corners even when the OS asks for dark; the Patients count equals the four list endpoints and Today stays
// short; module chips say "live"; pills navigate; every program view ends in the raw response; a live call
// tags typed lines through Clef and saves, and the recap matches the record; Ellie opens pages and
// answers; with C3 forced down (its API requests aborted in the browser) the app falls back to the saved copy.
// Also: Health chart is a summary with Ellie's Insight; Hospital-risk rows open the patient; no Patient's app or nav icons;
// Ellie follow-ups ("open that first patient", "start a call with them"); Play-as-live demo; the mic records a spoken
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
  ["today", "Call today"], ["patients", "Patients"],
  [`p-${ids.c3}`, "Health chart"], [`p-${ids.c3}.c3`, "What to do"],
  [`p-${ids.c4}`, "Health chart"], [`p-${ids.c4}.c4`, "What to do"],
  [`p-${ids.c5}`, "Health chart"], [`p-${ids.c5}.c5`, "Calls"],
  [`p-${ids.c1}`, "Health chart"], [`p-${ids.c1}.c1`, "What to do"],
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
  // Today: one ranked queue across programs, each row with a reason, its data type and (when known) language.
  const tq = await (await fetch(`${B}/api/today`)).json();
  const qMods = new Set(tq.rows.map((r) => r.mod));
  ok("Today API: one queue with rows from C1, C3, C4 and C5", ["c1", "c3", "c4", "c5"].every((m) => qMods.has(m)), [...qMods].join(","));
  ok("Today API: every reason is 90 characters or less", tq.rows.every((r) => r.reason && r.reason.length <= 90), tq.rows.map((r) => r.reason.length).sort((x, y) => y - x)[0]);
  ok("Today API: C1 rows say real MEPS data, the rest synthetic", tq.rows.every((r) => (r.mod === "c1") === /MEPS/.test(r.data)));
  const todayRows = await page.locator(".today-list .t-row").count();
  const domMods = new Set(await page.locator(".today-list .t-row").evaluateAll((els) => els.map((e) => e.dataset.mod)));
  ok("Today page: rows from all four programs", todayRows >= 4 && domMods.size === 4, `${todayRows} rows, ${[...domMods].join(",")}`);
  ok("Today page: data-type chip on every row", (await page.locator(".today-list .t-row .chip-data").count()) === todayRows);
  ok("Today page: interpreter chip for a non-English patient", (await page.locator(".today-list .chip-lang.need").count()) > 0);
  ok("Today page: separate-cohorts line", /Four programs, four separate cohorts/.test(await page.locator(".cohorts").innerText().catch(() => "")));
  await shot(page, "today_1280.png");
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

  // live call: typed lines are tagged by Clef, then saved and shown as the next recap
  const before = (await j(`/api/calls/${quiet.survivorId}`)).length;
  await page.goto(`${B}/#live-${quiet.survivorId}`); await settle(page);
  for (const t of ["How have the last few days been for you?", "Honestly tired, but I want to get back to walking.", "It sounds like walking matters to you, even on tired days."]) {
    await page.fill("#typed", t); await page.press("#typed", "Enter");
  }
  await page.waitForFunction(() => document.querySelectorAll("#live-lines .tag.live").length >= 2, null, { timeout: 90000 }).catch(() => {});
  const tagged = await page.locator("#live-lines .tag.live").count();
  ok("live call: typed lines get Clef tags", tagged >= 2, `${tagged} of 3`);
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
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#ellie-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 90000 }).catch(() => {});
  const ans = await page.locator("#ellie-msgs .m.a").last().innerText();
  ok("Ellie answers from the patient on screen", /range|70|180/i.test(ans) && !/couldn/i.test(ans), ans.slice(0, 160).replace(/\s+/g, " "));
  await shot(page, "ellie_1280.png", false);
  await page.fill("#ellie-q", "fever 39 on chemo, what should the patient do?"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#ellie-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 30000 }).catch(() => {});
  const red = await page.locator("#ellie-msgs .m.a").last().innerText();
  ok("Ellie: red-flag question gets the emergency answer", /emergency|ER today|24-hour/i.test(red) && !/3021|rate limit|error/i.test(red), red.slice(0, 120).replace(/\s+/g, " "));
  manifest.ellie = ans;

  // Ellie: follow-ups resolve to the patients she just named; the panel closes
  await page.fill("#ellie-q", "who is at most risk of hospitalization"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction(() => { const m = [...document.querySelectorAll("#ellie-msgs .m.a")].pop(); return m && !/Thinking|retrying/.test(m.textContent); }, null, { timeout: 90000 }).catch(() => {});
  const firstCite = await page.locator("#ellie-msgs .m.a").last().locator('a[href^="#p-"]').first().getAttribute("href").catch(() => null);
  ok("Ellie names patients for a risk question", !!firstCite, firstCite || (await page.locator("#ellie-msgs .m.a").last().innerText()).slice(0, 160));
  await page.fill("#ellie-q", "open up that first patient"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction((h) => location.hash.startsWith(h), firstCite, { timeout: 60000 }).catch(() => {});
  const fh = await page.evaluate(() => location.hash);
  ok("Ellie follow-up: 'that first patient' opens the one she named", !!firstCite && fh.startsWith(firstCite), `${fh} vs ${firstCite}`);
  await settle(page);
  await page.fill("#ellie-q", "start a call with them"); await page.press("#ellie-q", "Enter");
  await page.waitForFunction(() => location.hash.startsWith("#live-"), null, { timeout: 60000 }).catch(() => {});
  ok("Ellie follow-up: 'start a call with them' opens the call", firstCite && (await page.evaluate(() => location.hash)) === "#live-" + firstCite.slice(3).split(".")[0], await page.evaluate(() => location.hash));
  await shot(page, "ellie-followup_1280.png", false);
  await page.locator("#ellie-close").click();
  ok("Ellie closes", await page.locator("#ellie").isHidden());

  // Health chart = summary + Ellie's Insight; detail lives in the pills
  await page.goto(`${B}/#p-${ids.c3}`); await settle(page);
  await page.waitForFunction(() => { const e = document.querySelector(".ellie-insight"); return e && /check before acting|program’s own (summary|record)/i.test(e.textContent); }, null, { timeout: 60000 }).catch(() => {});
  const ins = await page.locator(".ellie-insight").innerText().catch(() => "");
  ok("Health chart shows AI Insight, short and labelled", /^AI Insight/.test(ins.trim()) && /check before acting|own (summary|record)/i.test(ins) && ins.split(/\s+/).length < 90, ins.replace(/\s+/g, " ").slice(0, 200));
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
  ok("C3 down: banner says saved copy", /C3.*isn.t answering.*saved copy/i.test(banner), banner.replace(/\s+/g, " "));
  ok("C3 down: status chip turns amber", /s-fallback/.test(chip), chip);
  await shot(page, "fallback-c3-down_patients.png", false);
  await page.goto(`${B}/#p-${ids.c3}.c3`); await settle(page);
  const body = await page.locator("#view").innerText();
  ok("C3 down: patient page renders from the saved copy", /What to do/.test(body) && /saved copy/i.test(body) && (await page.locator("svg.chart").count()) > 0);
  await shot(page, "fallback-c3-down_patient.png");
  await page.goto(`${B}/#p-${ids.c4}.c4`); await settle(page);
  ok("C3 down: C4 pages stay live", (await page.locator(".mode .src", { hasText: "Glucose" }).getAttribute("class")).includes("s-live"));
  ok("C3 down: no page errors", !errors.length, errors.join(" | "));
  await ctx.close();
}

await browser.close();

// 5. the mic: Chromium's fake mic plays a spoken wav; Whisper must turn it into a line
{
  // A fixed clip (macOS `say`: "Hi, how have you been feeling since our last call?", 16 kHz mono WAV), so this runs on any OS.
  const wav = new URL("./fixtures/mic.wav", import.meta.url).pathname;
  const mb = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  const ctx = await mb.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
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
