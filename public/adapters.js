/* Patient 360 adapter layer: the only place that knows each module's response shape.
   - fetches /api/<module>/... from this Worker (which proxies the module Workers),
   - falls back to the saved copy (fallback-data.js, captured from the live APIs) when a module is down,
   - fills a missing top-level field from the saved copy, or else degrades, and records what was missing,
   - maps every module to one UI shape: roster rows and patient views made of panels (chart + its advice).
   Contract changes in a module should only ever touch this file. */
(function () {
  "use strict";
  const SNAP_ONLY = !!window.SNAPSHOT_ONLY;
  const TIMEOUT_MS = 10000;
  let fb = window.SNAPSHOT || null;
  const health = {}; // module -> { source: "live" | "fallback" | "down", error, at }
  const missing = {}; // module -> Set of "field (path kind)"

  async function loadFallback() {
    if (fb) return fb;
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "fallback-data.js"; s.onload = res; s.onerror = () => rej(new Error("saved copy not available")); document.head.appendChild(s); });
    fb = window.SNAPSHOT || {};
    return fb;
  }
  const modOfPath = (p) => p.split("/")[2];
  const note = (mod, what) => (missing[mod] = missing[mod] || new Set()).add(what);

  async function fetchJSON(path, required) {
    const mod = modOfPath(path);
    let err = null;
    if (!SNAP_ONLY) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        const r = await fetch(path, { signal: ctl.signal }); clearTimeout(t);
        const body = await r.json().catch(() => null);
        if (r.ok && body) {
          health[mod] = { source: "live", at: new Date().toISOString() };
          if (required) await fillMissing(mod, path, body, required);
          return body;
        }
        if (r.status === 404 && body && body.error) { const e = new Error(body.error); e.notFound = true; throw e; }
        err = new Error(`HTTP ${r.status}`);
      } catch (e) { if (e.notFound) throw e; err = err || new Error(e.name === "AbortError" ? "timed out" : e.message); }
    }
    let saved = null;
    try { saved = (await loadFallback())[path]; } catch (e) { /* no saved copy */ }
    health[mod] = { source: saved ? "fallback" : "down", error: err ? err.message : null, at: fb && fb.__capturedAt };
    if (!saved) throw new Error(SNAP_ONLY ? "This shared copy holds a sample only. Open the live site for every patient." : `${mod.toUpperCase()} is not answering (${err ? err.message : "no response"}) and there is no saved copy of this page.`);
    return saved;
  }

  async function fillMissing(mod, path, body, required) {
    const absent = required.filter((k) => body[k] == null);
    if (!absent.length) return;
    let saved = null;
    try { saved = (await loadFallback())[path]; } catch (e) { /* none */ }
    for (const k of absent) {
      if (saved && saved[k] != null) { body[k] = saved[k]; note(mod, `${k} (filled from saved copy)`); } else note(mod, `${k} (not provided)`);
    }
  }

  // ------------------------------------------------------------------ shared vocabulary
  const MODULES = {
    c1: { name: "Hospital risk", challenge: "C1", short: "Hospital risk", color: "var(--m-c1)", live: true },
    c3: { name: "Rough weeks", challenge: "C3", short: "Wearables", color: "var(--m-c3)", live: true },
    c4: { name: "Glucose", challenge: "C4", short: "Meals & glucose", color: "var(--m-c4)", live: true },
    c5: { name: "Coaching calls", challenge: "C5", short: "Calls", color: "var(--m-c5)", live: true },
  };
  // Triage: a "needs a person" line on a call is a same-day hand-off, so C5 alerts rank first.
  // C3 "urgent" (ER or hospital risk over its line) is also a same-day call.
  const triage = (mod, s, urgent) => ((mod === "c5" && s === "alert") || (mod === "c3" && urgent) ? "today" : s || "ok");
  const c3Urgent = (x) => (x.urgent != null ? !!x.urgent : /^urgent/i.test(x.headline || ""));
  const pct = (v, d = 0) => (v == null ? "–" : (v * 100).toFixed(d) + "%");
  const num = (v, d = 0) => (v == null || isNaN(v) ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const has = (o, ...ks) => o && ks.every((k) => o[k] != null);
  const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  // ------------------------------------------------------------------ roster
  async function roster() {
    const mods = ["c1", "c3", "c4", "c5"];
    const res = await Promise.allSettled(mods.map((m) => fetchJSON(`/api/${m}/survivors`)));
    const rows = [], failed = [];
    res.forEach((r, i) => {
      const m = mods[i];
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) { failed.push({ mod: m, error: r.reason ? r.reason.message : "bad response" }); return; }
      r.value.forEach((x) => rows.push(rosterRow(m, x)));
    });
    return { rows, failed };
  }

  function rosterRow(mod, x) {
    let tags = Array.isArray(x.tags) ? x.tags : null;
    if (!tags) { tags = deriveTags(mod, x); if (mod === "c3" || mod === "c1") note(mod, "tags[] on roster rows (derived from the headline)"); }
    return { id: x.survivorId, mod, name: patientName(x.displayName), status: x.status || "ok", tri: triage(mod, x.status, mod === "c3" && c3Urgent(x)), headline: x.headline || "", tags: tags.slice(0, 4), updatedAt: x.updatedAt };
  }
  const patientName = (n) => n || "Unnamed patient";

  function deriveTags(mod, x) {
    const t = [], h = x.headline || "";
    if (mod === "c3") {
      if (c3Urgent(x)) { const u = h.match(/hospital risk (\d+)%/i); t.push({ label: u ? `ER/hospital ${u[1]}%` : "Urgent", tone: "risk" }); }
      const r = h.match(/patch risk (\d+)%/i); if (r) t.push({ label: `Risk ${r[1]}%`, tone: x.status === "alert" ? "risk" : x.status === "watch" ? "warn" : "info" });
      const d = h.match(/driven by ([a-z ]+)/i); if (d) t.push({ label: sentence(d[1].trim()), tone: "warn" });
      if (/treatment calendar/i.test(h)) t.push({ label: "Treatment calendar", tone: "info" });
    }
    if (mod === "c1") {
      const r = h.match(/risk (\d+)%/i); if (r) t.push({ label: `Acute care ${r[1]}%`, tone: x.status === "alert" ? "risk" : x.status === "watch" ? "warn" : "info" });
      const d = h.match(/driven by ([^,;]+)/i); if (d) t.push({ label: sentence(d[1].trim()), tone: "warn" });
    }
    return t;
  }

  // ------------------------------------------------------------------ patient
  const REQUIRED = { c1: ["status", "headline", "evidence", "recommendations", "charts", "caveat"], c3: ["status", "headline", "evidence", "recommendations", "charts"], c4: ["status", "headline", "evidence", "recommendations", "charts"], c5: ["status", "headline", "recommendations", "charts"] };

  async function patient(id) {
    const mod = id.split("-")[0];
    if (!MODULES[mod] || !MODULES[mod].live) throw new Error("Unknown module in this link.");
    const d = await fetchJSON(`/api/${mod}/survivors/${encodeURIComponent(id)}`, REQUIRED[mod]);
    const base = { id, mod, name: patientName(d.displayName), status: d.status || "ok", tri: triage(mod, d.status, mod === "c3" && c3Urgent(d)), headline: d.headline || "", summary: d.summary || "", updatedAt: d.updatedAt, facts: facts(d.profile || {}), source: health[mod] && health[mod].source };
    if (!d.profile) note(mod, "profile (not provided)");
    const v = mod === "c1" ? c1View(d) : mod === "c3" ? c3View(d) : mod === "c4" ? c4View(d) : c5View(d);
    return { ...base, ...v, missing: [...(missing[mod] || [])] };
  }

  function facts(p) {
    const yes = (v) => (v === true ? "yes" : v === false ? "no" : v);
    return [["Age", p.age], ["Sex", p.sex], ["Cancer", p.cancerType], ["Stage", p.stage], ["Treatment", p.treatmentPlan], ["Where in treatment", p.context], ["Language", p.language], ["Lives alone", yes(p.livesAlone)], ["Device", p.device],
      ["Race/ethnicity", p.raceEthnicity], ["Insurance", p.insurance2017], ["Cancer types", Array.isArray(p.cancerTypes) ? p.cancerTypes.join(", ") : null], ["In treatment", p.currentTreatment], ["Region", p.region], ["Years since treatment", p.yearsSinceTreatment], ["Blood sugar at start", p.bloodSugarGroup], ["Trial arm", p.group], ["Work", p.workSchedule], ["Program focus", p.focus], ["Coach", p.coach]]
      .filter(([, v]) => v != null && v !== "");
  }

  // ---- C1 Care Team Risk
  function c1View(d) {
    const c = d.charts || {}, r = c.risk || {}, use = c.use2017 || {}, ev = d.evidence || [];
    const audName = { "care-team": "For the care team", coach: "For the coach", survivor: "For the patient" };
    const advice = (d.recommendations || []).filter((x) => x.audience !== "survivor").map((x, i) => ({ title: x.text, text: "", tag: audName[x.audience] || x.audience || "", tone: i === 0 && d.status === "alert" ? "risk" : "info" }));
    if ((d.recommendations || []).some((x) => !x.audience)) note("c1", "recommendations[].audience (not provided)");
    const drivers = (c.drivers || []).filter((x) => x && x.logitContribution != null);
    const riskBars = r.value != null ? { title: "Chance of an ER visit or hospital stay next year", note: "This patient against the average survivor and the tier lines.", rows: [
      { label: "This patient", value: r.value, text: pct(r.value), color: "var(--alert)" },
      r.baseRate != null && { label: "Average survivor", value: r.baseRate, text: pct(r.baseRate), color: "var(--ink-3)" },
      r.alertFrom != null && { label: "Alert line", value: r.alertFrom, text: pct(r.alertFrom), color: "var(--line-2)" },
    ].filter(Boolean) } : null;
    const driverBars = drivers.length ? { title: "What drives it", note: "Contribution to this person’s risk (model log-odds). Grey lowers it.", rows: drivers.map((x) => ({ label: x.label, value: Math.abs(x.logitContribution), text: (x.logitContribution > 0 ? "+" : "−") + num(Math.abs(x.logitContribution), 2), color: x.logitContribution > 0 ? "var(--m-c1-strong)" : "var(--ink-3)" })) } : null;
    const panels = [{ id: "risk", title: "Hospital risk next year", lead: d.caveat || "", bars: riskBars, bars2: driverBars, list: ev.filter((e) => e.kind !== "model").map((e) => e.text), advice }];
    const sc = c.scores || {};
    const scoreNames = { physical_score: "Physical health score", mental_score: "Mental health score", distress_k6: "Distress (K6)", depression_phq2: "Depression (PHQ-2)", pain: "Pain", fatigue: "Fatigue", financial_toxicity: "Money worries", cost_delay: "Delayed care for cost" };
    const rows = Object.entries(sc).map(([k, v]) => [scoreNames[k] || k, v == null ? "not answered" : num(v, 1)]);
    const useRows = [["ER visits", use.erVisits], ["Hospital stays", use.hospitalStays], ["Office visits", use.officeVisits], ["Prescription fills", use.rxFills]].filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
    if (rows.length || useRows.length) panels.push({ id: "survey", title: "2017 survey answers and care use", charts: [], advice: [], table: { head: ["Measure", "2017"], rows: [...useRows, ...rows] } });
    return {
      tags: [{ label: `Acute care ${pct(d.risk)}`, tone: d.status === "alert" ? "risk" : d.status === "watch" ? "warn" : "info" }, ...drivers.filter((x) => x.logitContribution > 0).slice(0, 3).map((x) => ({ label: x.label, tone: "warn" }))],
      kpis: [{ value: pct(d.risk), label: "ER or hospital stay, next year", sub: r.baseRate != null ? `average survivor ${pct(r.baseRate)}` : "", good: d.status === "alert" ? false : d.status === "ok" ? true : null }, use.erVisits != null && { value: String(use.erVisits), label: "ER visits last year", sub: "most survivors had none", good: use.erVisits === 0 ? true : null }, use.hospitalStays != null && { value: String(use.hospitalStays), label: "Hospital stays last year", sub: "", good: use.hospitalStays === 0 ? true : null }].filter(Boolean),
      panels, evidence: null, patientAdvice: (d.recommendations || []).filter((x) => x.audience === "survivor").map((x) => x.text),
      footnote: (d.profile && d.profile.dataSource ? d.profile.dataSource + ". " : "") + (d.caveat || ""),
    };
  }

  // ---- C3 Bad Week Radar
  const C3_SIGNALS = {
    sleep: { key: "sleepHours", title: "Sleep", unit: "hours a night", d: 1, words: /sleep|nap|night/i },
    resting_heart_rate: { key: "restingHeartRate", title: "Resting heart rate", unit: "bpm", d: 0, words: /heart rate|pulse/i },
    steps: { key: "steps", title: "Steps", unit: "per day", d: 0, words: /step|walk|activity|moving/i },
    hrv_rmssd_ms: { key: "hrv", title: "Heart rate variability", unit: "ms", d: 0, words: /variability|hrv/i },
    skin_temp: { key: "skinTempChange", title: "Skin temperature", unit: "°C vs usual", d: 1, words: /fever|temperature|infection/i },
  };
  function c3View(d) {
    const c = d.charts || {}, ev = d.evidence || [], recs = (d.recommendations || []).map((r) => ({ title: r.action, text: r.why, tag: r.urgency, tone: r.urgency === "today" ? "risk" : r.urgency === "within 2 days" ? "warn" : "info" }));
    const x = (c.dates || []).map((t) => String(t).slice(5));
    const doses = (c.doseDays || []).map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const series = (key, label, color = "var(--m-c3)") => ({ values: c[key] || [], color, label });
    const used = new Set();
    const take = (re) => recs.filter((r) => !used.has(r) && re.test(r.title + " " + r.text)).map((r) => (used.add(r), r));
    const signalPanels = ev.filter((e) => C3_SIGNALS[e.signal] && c[C3_SIGNALS[e.signal].key]).map((e) => {
      const s = C3_SIGNALS[e.signal];
      return { id: e.signal, title: s.title, lead: e.text, charts: [{ x, series: [series(s.key, s.title)], ticks: doses, h: 170, title: `${s.title}, last 42 days`, note: `${s.unit} · ticks = treatment days`, d: s.d }], advice: take(s.words) };
    });
    const riskAdvice = recs.filter((r) => !used.has(r));
    if (!has(d, "risk")) note("c3", "risk (not provided)");
    const risk = {
      id: "risk", title: "Chance of a rough patch in the next 7 days", lead: d.summary,
      charts: c.risk ? [{ x, series: [series("risk", "Rough patch, 7 days"), c.urgentRisk && { values: c.urgentRisk, color: "var(--alert)", label: "ER or hospital, 7 days" }].filter(Boolean), refs: d.thresholds ? [{ y: d.thresholds.alert, label: "alert", color: "var(--ink-2)" }, { y: d.thresholds.watch, label: "watch" }] : [], ticks: doses, min: 0, h: 220, pct: true, title: "Forecast, last 42 days", note: "ticks = treatment days" }] : [],
      bars: ev.length ? { title: "What drives it", note: "How far the risk would drop if each signal were back at their usual. Grey = treatment calendar.", rows: ev.map((e) => ({ label: e.label, value: e.riskShare || 0, text: "+" + pct(e.riskShare), color: e.signal === "schedule" ? "var(--ink-3)" : "var(--m-c3)" })) } : null,
      advice: riskAdvice,
    };
    const shownKeys = new Set(signalPanels.map((p) => C3_SIGNALS[p.id].key));
    const rest = Object.values(C3_SIGNALS).filter((s) => !shownKeys.has(s.key) && c[s.key]).map((s) => ({ x, series: [series(s.key, s.title, "var(--ink-3)")], ticks: doses, h: 120, title: s.title, note: s.unit, d: s.d }));
    if (c.watchWornHours) rest.push({ x, series: [series("watchWornHours", "Watch worn", "var(--ink-3)")], h: 120, title: "Watch worn", note: "hours a day" });
    if (c.selfReportedFeeling) rest.push({ x, series: [{ values: c.selfReportedFeeling, color: "var(--ink-3)", label: "Daily check-in", dots: true }], min: 1, max: 5, h: 120, title: "Daily check-in, 1–5", note: "context only, not a model input" });
    const panels = [risk, ...signalPanels];
    if (rest.length) panels.push({ id: "other", title: "Other signals", lead: "Near their usual, or not used in this forecast.", charts: rest, small: true, advice: [] });
    const lastWear = (c.watchWornHours || []).slice(-7).filter((v) => v != null);
    return {
      tags: [c3Urgent(d) && { label: `ER/hospital ${pct(d.urgentRisk)}`, tone: "risk" }, { label: `Rough patch ${pct(d.risk)}`, tone: d.status === "alert" ? "risk" : d.status === "watch" ? "warn" : "info" }, ...ev.filter((e) => e.signal !== "schedule").slice(0, 3).map((e) => ({ label: `${e.label} ${e.change || ""}`.trim(), tone: "warn" }))].filter(Boolean),
      kpis: [d.urgentRisk != null && { value: pct(d.urgentRisk), label: "ER or hospital risk, 7 days", sub: d.thresholds && d.thresholds.urgent != null ? `urgent line ${pct(d.thresholds.urgent, 1)}` : "", good: d.urgent ? false : null }, { value: pct(d.risk), label: "Rough-patch risk, 7 days", sub: d.thresholds ? `alert line ${pct(d.thresholds.alert, 1)}` : "", good: d.thresholds && d.risk != null ? (d.risk >= d.thresholds.alert ? false : d.risk < d.thresholds.watch ? true : null) : null }, { value: pct(d.scheduleRisk), label: "From treatment calendar alone", sub: "what the schedule predicts", good: null }, lastWear.length && { value: num(lastWear.reduce((a, b) => a + b, 0) / lastWear.length, 1) + " h", label: "Watch worn a day", sub: "last 7 days; forecast needs ~12 h", good: lastWear.reduce((a, b) => a + b, 0) / lastWear.length >= 12 }].filter(Boolean),
      panels, evidence: null,
      footnote: "Forecast from wearable signals against the person’s own usual plus the treatment calendar. No self-reports. Synthetic cohort.",
    };
  }

  // ---- C4 Dose and Timing
  const C4_CHART_FOR = { talk_to_team: ["daily"], walk: ["walk", "walkDose"], late_dinner: ["dinner"], overnight_fast: ["fast"] };
  const C4_CHART_BY_EVIDENCE = [[/^(tir|tbr|tar|mean_glucose|gmi|status)/, "daily"], [/walk/, "walk"], [/late|dinner/, "dinner"], [/fast/, "fast"]];
  function c4View(d) {
    const c = d.charts || {}, evById = Object.fromEntries((d.evidence || []).map((e) => [e.id, e]));
    const basisName = { personal: "Their own meals", cohort: "Whole program", trial: "Randomized trial", rule: "Safety rule" };
    const charts = {};
    if (has(c.dailyProfile, "hours", "series")) {
      const dp = c.dailyProfile;
      charts.daily = { x: dp.hours.map((h) => (h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : h - 12 + "p")), series: dp.series.map((s, i) => ({ values: s.values, color: i ? "var(--m-c4)" : "var(--ink-3)", dash: !i && dp.series.length > 1, label: s.label })), yband: dp.targetRange || [70, 180], h: 220, title: "Blood sugar by hour of day", note: "mg/dL · shaded band = target 70–180", xcount: 8 };
    }
    const mins = (o) => (o.minutes || []).map((m) => m + "m");
    if (has(c.dinnerResponse, "minutes", "you")) {
      const r = c.dinnerResponse;
      charts.dinner = { x: mins(r), series: [{ values: r.you.early, color: "var(--m-c3)", label: `Their dinners before 8 pm (${r.you.nEarly ?? "?"})` }, { values: r.you.late, color: "var(--m-c4)", label: `Their dinners 8 pm or later (${r.you.nLate ?? "?"})` }, r.cohort && { values: r.cohort.early, color: "var(--m-c3)", dash: true, label: "Program, early" }, r.cohort && { values: r.cohort.late, color: "var(--m-c4)", dash: true, label: "Program, late" }].filter(Boolean), h: 200, title: "Rise after dinner", note: "mg/dL above the pre-meal reading" };
    }
    if (has(c.walkResponse, "minutes", "you")) {
      const r = c.walkResponse;
      charts.walk = { x: mins(r), series: [{ values: r.you.noWalk, color: "var(--ink-3)", label: `No walk (${r.you.nNoWalk ?? "?"})` }, { values: r.you.walk, color: "var(--m-c5)", label: `Walked after (${r.you.nWalk ?? "?"})` }, r.cohort && { values: r.cohort.noWalk, color: "var(--ink-3)", dash: true, label: "Program, no walk" }, r.cohort && { values: r.cohort.walk, color: "var(--m-c5)", dash: true, label: "Program, walked" }].filter(Boolean), h: 200, title: "Rise after meals, with and without a walk", note: "mg/dL above the pre-meal reading" };
    }
    if (has(c.walkDose, "bins", "est")) {
      const w = c.walkDose;
      charts.walkDose = { x: w.bins, series: [{ values: w.est, color: "var(--m-c5)", label: "Change vs no walk", dots: true, band: w.lo && w.hi ? [w.lo, w.hi] : null }], refs: [{ y: 0, label: "no walk" }], h: 170, title: "How long a walk? Whole program, same person", note: "mg/dL vs no walk · band = 95% CI" };
    }
    if (has(c.overnightFast, "hours", "morningGlucose") && c.overnightFast.hours.length) {
      const o = c.overnightFast.hours.map((h, i) => [h, c.overnightFast.morningGlucose[i]]).sort((a, b) => a[0] - b[0]);
      charts.fast = { x: o.map((p) => p[0].toFixed(1) + "h"), series: [{ values: o.map((p) => p[1]), color: "var(--m-c4)", dots: true, label: "Next-morning sugar" }], h: 180, title: "Overnight fast vs next-morning sugar", note: `${o.length} nights · mg/dL`, xcount: 5 };
    }
    const titles = { daily: "Blood sugar through the day", walk: "Walking after meals", walkDose: "Walking after meals", dinner: "Dinner timing", fast: "Overnight fast" };
    const panels = [], placed = new Set();
    for (const r of d.recommendations || []) {
      let keys = C4_CHART_FOR[r.id];
      if (!keys) { const k = (r.evidenceIds || []).map((id) => (C4_CHART_BY_EVIDENCE.find(([re]) => re.test(id)) || [])[1]).find(Boolean); keys = k ? [k] : []; }
      keys = keys.filter((k) => charts[k]);
      const adv = { title: r.title, text: r.text, tag: basisName[r.basis] || r.basis, tone: r.basis === "rule" ? "risk" : "info", evidence: (r.evidenceIds || []).map((id) => evById[id]).filter(Boolean).slice(0, 3) };
      const existing = panels.find((p) => keys.length && p.keys.join() === keys.join());
      if (existing) { existing.advice.push(adv); continue; }
      keys.forEach((k) => placed.add(k));
      panels.push({ id: r.id, keys, title: keys.length ? titles[keys[0]] : r.title, charts: keys.map((k) => charts[k]), advice: [adv] });
    }
    for (const k of Object.keys(charts)) if (!placed.has(k)) { placed.add(k); panels.push({ id: k, keys: [k], title: titles[k], charts: [charts[k]], advice: [] }); }
    const ck = c.checkups;
    if (has(ck, "metrics", "week0")) {
      const names = { hba1c_pct: "HbA1c (%)", fasting_glucose_mg_dl: "Fasting glucose (mg/dL)", weight_kg: "Weight (kg)" };
      panels.push({ id: "checkups", title: "Check-ups", charts: [], advice: [], table: { head: ["Check-up", "Week 0", "Week 12"], rows: ck.metrics.map((m, i) => [names[m] || m, num(ck.week0[i], 1), ck.week12 && ck.week12[i] != null ? num(ck.week12[i], 1) : "left early"]) } });
    }
    const kp = (id, label, sub, goodFn, dp = 0) => { const e = evById[id]; return e && e.value != null ? { value: num(e.value, dp) + (e.unit === "%" ? "%" : ""), label, sub, good: goodFn ? goodFn(e.value) : null } : null; };
    const scopeName = { person: "Their data", cohort: "Whole program", trial: "Randomized trial", real: "Real people (CGMacros, NHANES)" };
    const evidence = ["person", "cohort", "trial", "real"].map((s) => ({ group: scopeName[s], open: s === "person", rows: (d.evidence || []).filter((e) => e.scope === s).map((e) => ({ label: e.label, caveat: e.caveat, value: e.value == null ? "–" : `${num(e.value, 1)} ${e.unit || ""}`, ci: e.ci ? `${num(e.ci[0], 1)} to ${num(e.ci[1], 1)}` : "", n: e.n ?? "" })) })).filter((g) => g.rows.length);
    let tags = d.tags;
    if (!Array.isArray(tags)) { note("c4", "tags[] (not provided)"); tags = []; }
    return {
      tags, reasons: d.statusReasons || [],
      kpis: [kp("tir", "Time in range", "target over 70%, ideal 90%+", (v) => (v >= 90 ? true : v < 70 ? false : null)), kp("tbr70", "Lows (below 70)", "target under 4%", (v) => v <= 4, 1), kp("mean_glucose", "Average sugar", "mg/dL, target 154 or less", (v) => v <= 154), kp("late_share", "Late dinners", "share at 8 pm or later", null), kp("fast_avg", "Overnight fast", "hours, average", null, 1)].filter(Boolean),
      panels, evidence, footnote: d.dataNote || "",
    };
  }

  // ---- C5 Coach's Copilot
  function c5View(d) {
    const calls = (d.charts && d.charts.calls) || [];
    const flagLines = calls.reduce((s, c) => s + (c.flags ? c.flags.length : 0), 0);
    const scored = [...calls].reverse().filter((c) => c.score != null);
    const recs = (d.recommendations || []).map((r) => ({ title: r.action, text: r.why || "", tag: r.urgency, tone: r.urgency === "today" ? "risk" : "info" }));
    const panels = [{ id: "calls", title: "Calls", lead: "Supervisor-labelled. Open a call to run the live Copilot on it.", calls, charts: scored.length > 1 ? [{ x: scored.map((c) => "Call " + c.callNumber), series: [{ values: scored.map((c) => c.score), color: "var(--m-c5)", label: "Coach score", dots: true }], refs: [{ y: 60, label: "target 60" }], min: 0, max: 100, h: 150, title: "Coach score by call", note: "out of 100" }] : [], advice: recs }];
    const flags = (d.evidence || []).filter((e) => String(e.kind || "").startsWith("flag"));
    if (flags.length) panels.push({ id: "concerns", title: "Lines that need a person", lead: "From the supervisor’s labels.", list: flags.map((e) => e.text), charts: [], advice: [] });
    return {
      tags: Array.isArray(d.tags) ? d.tags : [flagLines ? { label: flagLines === 1 ? "1 line needs a person" : `${flagLines} lines need a person`, tone: "risk" } : null, calls[0] && calls[0].score != null ? { label: `Score ${calls[0].score}`, tone: calls[0].score < 60 ? "warn" : "good" } : null, { label: `${calls.length} call${calls.length === 1 ? "" : "s"}`, tone: "info" }].filter(Boolean),
      kpis: [calls[0] && { value: `${calls[0].score ?? "–"}`, label: "Coach score, latest call", sub: "target 60 or more", good: calls[0].score == null ? null : calls[0].score >= 60 }, { value: String(flagLines), label: "Lines that need a person", sub: "supervisor labels", good: flagLines === 0 }, { value: String(calls.length), label: "Calls on file", sub: "", good: null }].filter(Boolean),
      panels, evidence: null, footnote: "Calls and labels from the Copilot’s supervisor-labelled set. Synthetic participants.",
    };
  }

  // ------------------------------------------------------------------ calls and advice
  const calls = () => fetchJSON("/api/c5/calls");
  const call = (id) => fetchJSON(`/api/c5/calls/${encodeURIComponent(id)}`);
  async function advice(id) {
    const mod = id.split("-")[0];
    if (mod === "c4") {
      try { const a = await fetchJSON(`/api/c4/survivors/${encodeURIComponent(id)}/advice`); if (a && Array.isArray(a.items) && a.items.length) return a.items.map((i) => ({ id: i.id, title: i.title, text: i.text, rule: /talk_to_team|overnight_fast/.test(i.id) && /care team/i.test(i.text), source: i.source })); } catch (e) { /* fall through to templates */ }
    }
    return null;
  }

  window.Adapter = { MODULES, roster, patient, calls, call, advice, health, missing, triage };
})();
