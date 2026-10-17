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
    // Linked demo records (x-L1..x-L5): one record from each program joined for the demo. Not a program; never in ALL.
    x: { name: "All four programs", challenge: "Linked", short: "Linked", color: "var(--ink-3)", live: false },
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
    const [res, ctx] = await Promise.all([Promise.allSettled(mods.map((m) => fetchJSON(`/api/${m}/survivors`))), context()]);
    const rows = [], failed = [];
    res.forEach((r, i) => {
      const m = mods[i];
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) { failed.push({ mod: m, error: r.reason ? r.reason.message : "bad response" }); return; }
      r.value.forEach((x) => rows.push(overlay(rosterRow(m, x), ctx)));
    });
    return { rows, failed, handoffs: ctx.handoffs, saved: ctx.saved };
  }

  // ------------------------------------------------------------------ closing the loop: call quotes, saved calls, hand-offs
  /* Today, Patients and the patient page all read one overlay on top of the module rows:
     - C5 labelled calls: the patient's own flagged words and when they were flagged (not "concern at 06:18 in call 5"),
     - calls saved in Patient 360 (GET /api/calls index): the newest is the latest call; a safety flag makes the patient Act today,
     - hand-offs (GET /api/handoffs): newer than the concern -> off Act today, tagged "Handed off by <coach> HH:MM".
     KV reads can lag a write by up to a minute, so this session's own saves and hand-offs live in `local` and merge by id. */
  const local = { calls: {}, handoffs: [] }; // calls: patientId -> full saved records, newest first
  const SAFETY = { medical: "Medical concern", distress: "Emotional distress", social: "Unmet basic need" };
  const getNoStore = (p) => (SNAP_ONLY ? Promise.resolve([]) : fetch(p, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).then((j) => (Array.isArray(j) ? j : [])).catch(() => []));
  const mergeById = (fetched, mine) => [...mine.filter((x) => !fetched.some((f) => f.id === x.id)), ...fetched].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const savedEntry = (s) => ({ id: s.id, pid: s.pid, name: s.name, at: s.at, coach: s.coach, score: s.score, lines: Array.isArray(s.lines) ? s.lines.length : s.lines, flags: Array.isArray(s.flags) ? s.flags : (s.lines || []).filter((l) => l.flag && l.flag !== "none").map((l) => ({ flag: l.flag, text: l.text })) });
  let c5calls = null;
  async function context() {
    const [calls, saved, hand] = await Promise.all([c5calls || (c5calls = fetchJSON("/api/c5/calls").catch(() => ((c5calls = null), []))), getNoStore("/api/calls"), getNoStore("/api/handoffs")]);
    return { calls: Array.isArray(calls) ? calls : [], saved: mergeById(saved.map(savedEntry), Object.values(local.calls).flat().map(savedEntry)), handoffs: mergeById(hand, local.handoffs) };
  }
  const remember = {
    call: (rec) => { (local.calls[rec.pid] = local.calls[rec.pid] || []).unshift(rec); },
    handoff: (h) => { local.handoffs.unshift(h); },
  };
  const ago = (iso) => {
    const t = Date.parse(String(iso || "").length <= 10 ? iso + "T12:00:00" : iso); if (isNaN(t)) return "";
    const d = (Date.now() - t) / 864e5;
    return new Date(t).toDateString() === new Date().toDateString() ? "today" : d < 2 ? "yesterday" : d < 45 ? `${Math.round(d)} days ago` : d < 548 ? `${Math.round(d / 30.4)} months ago` : `${(d / 365).toFixed(1).replace(/\.0$/, "")} years ago`;
  };
  // The patient's words, minus the "Oh, before you go," lead-in, so the symptom comes first.
  const shortQ = (s, n = 90) => { s = String(s || "").replace(/\s+/g, " ").trim().replace(/^(oh,?\s+)?before you go,?\s+(oh,?\s+)?(and\s+)?/i, ""); s = s.charAt(0).toUpperCase() + s.slice(1); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "").replace(/[,;:.]$/, "") + "…" : s; };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const handoffLabel = (h) => `Handed off by ${h.coach} ${new Date(h.at).toDateString() === new Date().toDateString() ? hhmm(h.at) : new Date(h.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + hhmm(h.at)}`;

  // Mutates and returns a roster row or patient view: concern {kind,text,at,where,by,fresh}, reason, age, lastSaved, handoff, prio.
  function overlay(r, ctx) {
    const er = (String(r.headline).match(/ER or hospital risk (\d+(?:\.\d+)?)%/i) || [])[1];
    if (r.mod === "c5" && r.status === "alert") {
      const fl = ctx.calls.filter((c) => c.survivorId === r.id && c.flags && c.flags.length).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start))[0];
      if (fl) { const f = fl.flags[0]; r.concern = { kind: SAFETY[f.kind] ? f.kind : "medical", text: f.text, at: fl.date, where: `call ${fl.callNumber}`, by: fl.coach && fl.coach.name }; }
    }
    const saved = ctx.saved.filter((s) => s.pid === r.id);
    if (saved[0]) r.lastSaved = saved[0];
    const fresh = saved.find((s) => (s.flags || []).some((x) => SAFETY[x.flag]));
    if (fresh) { const f = fresh.flags.find((x) => SAFETY[x.flag]); r.concern = { kind: f.flag, text: f.text, at: fresh.at, where: "a call logged in Patient 360", by: fresh.coach, fresh: true }; r.tri = "today"; }
    if (r.concern) {
      const c = r.concern, k = SAFETY[c.kind] || "Concern";
      r.reason = `${k}: “${shortQ(c.text)}”`;
      r.age = `flagged ${ago(c.at)}`;
      r.headline = `${k}: “${shortQ(c.text, 160)}” Raised on ${c.where}${c.by ? ` (coach ${c.by})` : ""}, ${r.age}.`;
    } else if (r.updatedAt) r.age = `data from ${ago(r.updatedAt)}`;
    const h = ctx.handoffs.find((x) => x.patientId === r.id);
    if (h && h.at >= (r.concern ? String(r.concern.at) : "")) {
      r.handoff = { ...h, label: handoffLabel(h) };
      if (r.tri === "today") r.tri = "alert";
      r.tags = [{ label: r.handoff.label, tone: "good" }, ...(r.tags || [])];
    }
    // Rank inside a status: urgent ER/hospital risk first (highest first), then call concerns (newest first), then the rest.
    r.prio = r.mod === "c3" && er && r.tri === "today" ? -er : r.concern ? 101 - Date.parse(String(r.concern.at).length <= 10 ? r.concern.at + "T12:00:00" : r.concern.at) / 1e13 : 200;
    return r;
  }
  // A call saved in Patient 360, in the labelled-call row shape (app.js callRow), for the Coaching calls tab and the Calls list.
  // Short spoken name: "María López · …" -> "María López"; "85M · prostate · S71188550" -> "S71188550".
  const shortName = (n) => { const p = String(n || "").split(" · ").map((x) => x.trim()); return /^\d/.test(p[0]) ? p[p.length - 1] : p[0]; };
  const savedAsCall = (s) => ({ callId: s.id, saved: true, href: `#live-${s.pid}`, survivorId: s.pid, participantName: shortName(s.name || s.pid), coach: { name: s.coach }, date: s.at, language: "", goalTopic: "", callNumber: "", week: "",
    flags: (s.flags || []).map((f) => ({ kind: f.flag, text: f.text })), lines: s.lines, score: s.score, status: (s.flags || []).some((f) => SAFETY[f.flag]) ? "alert" : "ok" });

  function rosterRow(mod, x) {
    let tags = Array.isArray(x.tags) ? x.tags : null;
    if (!tags) { tags = deriveTags(mod, x); if (mod === "c3" || mod === "c1") note(mod, "tags[] on roster rows (derived from the headline)"); }
    // A C5 call flag older than 30 days is an alert to review, not a same-day call.
    const stale = mod === "c5" && !(Date.now() - Date.parse(x.updatedAt) < 30 * 864e5);
    return { id: x.survivorId, mod, name: patientName(x.displayName), status: x.status || "ok", tri: x.careTeamToday === true ? "today" : stale && x.status === "alert" ? "alert" : triage(mod, x.status, mod === "c3" && c3Urgent(x)), headline: x.headline || "", tags: tags.slice(0, 4), updatedAt: x.updatedAt };
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
      const d = h.match(/driven by ([^,;]+)/i); if (d) t.push({ label: sentence(d[1].trim()), tone: "warn" });
    }
    return t;
  }

  // ------------------------------------------------------------------ patient
  const REQUIRED = { c1: ["status", "headline", "evidence", "recommendations", "charts", "caveat"], c3: ["status", "headline", "evidence", "recommendations", "charts"], c4: ["status", "headline", "evidence", "recommendations", "charts"], c5: ["status", "headline", "recommendations", "charts"] };

  // get(memberId): how a linked record loads its members (the app passes its memo so members are fetched once).
  async function patient(id, get) {
    const mod = id.split("-")[0];
    if (mod === "x") return linkedPatient(id, get);
    if (!MODULES[mod] || !MODULES[mod].live) throw new Error("Unknown module in this link.");
    // The record, the program's model card and the call overlay load in parallel.
    const [d, m, ctx] = await Promise.all([fetchJSON(`/api/${mod}/survivors/${encodeURIComponent(id)}`, REQUIRED[mod]), mod === "c1" ? c1Metrics() : mod === "c3" ? c3Metrics() : null, context()]);
    // Same-day care-team flags outrank the tier: C1 red flags from the survey, C4 frequent lows or very high average.
    const careToday = (mod === "c1" && d.redFlags && d.redFlags.careTeamToday === true) || (mod === "c4" && d.careTeamFlag && d.careTeamFlag.today === true);
    const base = { id, mod, name: patientName(d.displayName), status: d.status || "ok", tri: careToday ? "today" : triage(mod, d.status, mod === "c3" && c3Urgent(d)), headline: d.headline || "", summary: d.summary || "", updatedAt: d.updatedAt, facts: facts(d.profile || {}), identity: identity(d.profile || {}), source: health[mod] && health[mod].source };
    if (!d.profile) note(mod, "profile (not provided)");
    const v = mod === "c1" ? c1View(d, m) : mod === "c3" ? c3View(d, m) : mod === "c4" ? c4View(d) : c5View(d);
    v.fit = v.fit || { tone: "neutral", text: mod === "c4" ? "Subgroup performance not yet measured for the glucose program." : "No split by language yet; Kreyòl (Haitian Creole) calls are not supported." };
    const out = overlay({ ...base, ...v, raw: d, missing: [...(missing[mod] || [])] }, ctx);
    // Calls saved in Patient 360 join the labelled calls on the Coaching calls tab, newest first.
    const mine = ctx.saved.filter((s) => s.pid === id);
    const pn = mod === "c5" && mine.length && out.panels.find((x) => x.id === "calls");
    if (pn) {
      pn.calls = [...mine.map(savedAsCall), ...(pn.calls || [])];
      out.kpis.forEach((k) => { if (k.label === "Calls on file") { k.value = String(pn.calls.length); k.sub = `${mine.length} logged in Patient 360`; } });
      out.tags = out.tags.map((t) => (/^\d+ calls?$/.test(t.label) ? { ...t, label: `${pn.calls.length} calls` } : t));
    }
    return out;
  }

  // One identity line: age, sex, cancer, language. Missing parts are left out, never "undefined".
  function identity(p) {
    const cap = (v) => (v == null || v === "" ? null : String(v)[0].toUpperCase() + String(v).slice(1));
    const cancer = p.cancerType || (Array.isArray(p.cancerTypes) ? p.cancerTypes.join(", ") : null);
    return { age: p.age != null ? String(p.age) : null, sex: cap(p.sex), cancer: cancer ? cap(cancer) + " cancer" : null, language: p.language || null };
  }
  const IDENTITY_KEYS = ["Age", "Sex", "Cancer", "Cancer types", "Language"];

  function facts(p) {
    const yes = (v) => (v === true ? "yes" : v === false ? "no" : v);
    return [["Age", p.age], ["Sex", p.sex], ["Cancer", p.cancerType], ["Stage", p.stage], ["Treatment", p.treatmentPlan], ["Where in treatment", p.context], ["Language", p.language], ["Lives alone", yes(p.livesAlone)], ["Device", p.device],
      ["Race/ethnicity", p.raceEthnicity], ["Insurance", p.insurance2017], ["Cancer types", Array.isArray(p.cancerTypes) ? p.cancerTypes.join(", ") : null], ["In treatment", p.currentTreatment], ["Region", p.region], ["Years since treatment", p.yearsSinceTreatment], ["Blood sugar at start", p.bloodSugarGroup], ["Trial arm", p.group], ["Work", p.workSchedule], ["Program focus", p.focus], ["Coach", p.coach]]
      .filter(([, v]) => v != null && v !== "");
  }

  // ------------------------------------------------------------------ hero: the view's one number (Whoop pattern)
  /* Every program view returns one `hero`, rendered the same way on its tab, on the Health chart and on a linked tile:
     { label, value, unit, st: {tone: red|amber|green|neutral, glyph, word}, compare, means, todo, source, caveat?,
       top?: {tone, text} (a same-day driver that outranks the number), spark?: {values, band?, ref?, pct?, d?, note}, bar? }.
     The status word is judged against the number's own line, so it never contradicts the number. */
  const NR = "Not recorded";
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const ST = { red: (w) => ({ tone: "red", glyph: "●", word: w }), redW: (w) => ({ tone: "red", glyph: "▲", word: w }), amber: (w) => ({ tone: "amber", glyph: "▲", word: w }), green: (w) => ({ tone: "green", glyph: "✓", word: w }), none: (w) => ({ tone: "neutral", glyph: "–", word: w || "No reading" }) };
  const firstSentence = (t) => { const m = String(t || "").match(/^.*?[.!?](?=\s|$)/); return m ? m[0] : String(t || ""); };
  const restOf = (t) => String(t || "").slice(firstSentence(t).length).trim();
  const lastN = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);
  const quant = (vals, q) => { const a = vals.filter(isNum).sort((x, y) => x - y); if (!a.length) return null; const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
  const mean = (vals) => { const a = vals.filter(isNum); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };

  // ---- C1 Care Team Risk
  // "S71188550 · 85M · prostate" → "85M · prostate · S71188550": who the person is first, the ID second. Real names are left alone.
  const demoName = (n) => { const p = String(n || "").split(" · "); return p.length > 1 && /\d/.test(p[0]) && !/\s/.test(p[0]) ? [...p.slice(1), p[0]].join(" · ") : patientName(n); };
  // C1 headlines say "Acute care risk 70% for 2018"; 2018 is the data year, so name the horizon instead.
  const c1Headline = (h) => String(h || "").replace(/^Acute care risk/i, "ER or hospital risk").replace(/ for 2018\b/g, " in the next 12 months");
  // A fairness group the model is unreliable for, whatever its n: ranking near or below chance, or O/E CI excluding 1.
  const fairFlag = (g) => !!g && ((g.auroc != null && g.auroc < 0.6) || (Array.isArray(g.oeCi95) && (g.oeCi95[0] > 1 || g.oeCi95[1] < 1)));
  let c1m = null;
  const c1Metrics = () => (c1m = c1m || metrics("c1").catch(() => (c1m = null)));
  let c3m = null;
  const c3Metrics = () => (c3m = c3m || metrics("c3").catch(() => (c3m = null)));
  function c1Groups(p, m) {
    if (!p || !m || !Array.isArray(m.fairness)) return [];
    const lc = (s) => String(s ?? "").toLowerCase(), a = p.age;
    const band = a == null ? "" : a < 50 ? "18-49" : a < 65 ? "50-64" : a < 75 ? "65-74" : "75+";
    const cancers = (Array.isArray(p.cancerTypes) ? p.cancerTypes : [p.cancerType]).map(lc);
    return m.fairness.filter((g) => g.attribute === "race_ethnicity" ? g.group === p.raceEthnicity : g.attribute === "sex" ? lc(g.group) === lc(p.sex) : g.attribute === "insurance" ? g.group === p.insurance2017 : g.attribute === "age" ? !!band && String(g.group).startsWith(band) : g.attribute === "cancer_type" ? cancers.includes(lc(g.group)) : false);
  }
  function c1View(d, m) {
    const c = d.charts || {}, r = c.risk || {}, use = c.use2017 || {}, ev = d.evidence || [];
    const audName = { "care-team": "For the care team", coach: "For the coach", survivor: "To pass on to the patient" };
    // Care-team and coach advice first; advice the program wrote for the patient follows, for the clinician to pass on.
    const recs = d.recommendations || [];
    const advice = [...recs.filter((x) => x.audience !== "survivor"), ...recs.filter((x) => x.audience === "survivor")].map((x, i) => ({ title: x.text, text: "", tag: audName[x.audience] || x.audience || "", tone: i === 0 && d.status === "alert" ? "risk" : "info" }));
    if ((d.recommendations || []).some((x) => !x.audience)) note("c1", "recommendations[].audience (not provided)");
    const drivers = (c.drivers || []).filter((x) => x && x.logitContribution != null);
    // Fairness: if the model validated poorly for this patient's group, say so before anyone acts on the score.
    const weak = c1Groups(d.profile, m).filter(fairFlag);
    let caution = weak.length ? { groups: weak.map((g) => g.group), label: `Caution: model weak for ${weak[0].group}`, text: weak.map((g) => `${g.group}: AUROC ${num(g.auroc, 2)}${g.auroc < 0.4 ? " (worse than chance: the ranking is inverted)" : g.auroc < 0.6 ? " (at or near chance)" : ""}, O/E ${num(g.oe, 2)}, ${g.n} people`).join("; ") } : null;
    // C1's own per-patient fairness flags (t-0004 contract) win over our metrics-derived guess:
    // weak-ranking / under- / over-predicted = caution chip; too-small = a softer note.
    const ff = Array.isArray(d.fairnessFlags) ? d.fairnessFlags : null;
    if (ff) {
      const strong = ff.filter((f) => /weak-ranking|under-predicted|over-predicted/.test(f.flag)), soft = ff.filter((f) => f.flag === "too-small");
      caution = strong.length ? { groups: strong.map((f) => f.group), label: `Caution: less reliable for ${strong[0].group}`, text: strong.map((f) => f.text).join("; ") }
        : soft.length ? { groups: soft.map((f) => f.group), soft: true, label: `Few ${soft[0].group} in training`, text: soft.map((f) => f.text).join("; ") } : null;
    }
    if (caution && !caution.soft) advice.unshift({ title: "Check this score by hand before acting on it", text: `In validation the model was unreliable for this patient’s group. ${caution.text}. Use the drivers and the record, not the score alone.`, tag: "Model caution", tone: "warn" });
    // Headline names the real top driver; health spending is called out as a cost proxy for need.
    const cost = (x) => /spending|cost/i.test(x.label), low = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
    const pos = drivers.filter((x) => x.logitContribution > 0).sort((a, b) => b.logitContribution - a.logitContribution);
    let headline = c1Headline(d.headline);
    if (pos.length) headline = headline.replace(/(driven by|mostly from) [^,;.]+/i, `driven most by ${low(pos[0].label)}${cost(pos[0]) ? " (a cost proxy for need)" : ""}${cost(pos[0]) && pos[1] ? `, then ${low(pos[1].label)}` : ""}`);
    const riskBars = r.value != null ? { title: "Chance of an ER visit or hospital stay in the next 12 months", note: "This patient against the average patient and the tier lines.", rows: [
      { label: "This patient", value: r.value, text: pct(r.value), color: "var(--alert)" },
      r.baseRate != null && { label: "Average patient", value: r.baseRate, text: pct(r.baseRate), color: "var(--ink-3)" },
      r.alertFrom != null && { label: "Alert line", value: r.alertFrom, text: pct(r.alertFrom), color: "var(--line-2)" },
    ].filter(Boolean) } : null;
    const driverBars = drivers.length ? { title: "What drives it", note: `Contribution to this person’s risk (model log-odds). Grey lowers it.${drivers.some(cost) ? " Health spending is a cost proxy for need, not a cause." : ""}`, rows: drivers.map((x) => ({ label: x.label + (cost(x) ? " (cost proxy)" : ""), value: Math.abs(x.logitContribution), text: (x.logitContribution > 0 ? "+" : "−") + num(Math.abs(x.logitContribution), 2), color: x.logitContribution > 0 ? "var(--m-c1-strong)" : "var(--ink-3)" })) } : null;
    const panels = [{ id: "risk", title: "Hospital risk, next 12 months", lead: [d.riskWords, d.caveat].filter(Boolean).join(". ").replace(/\.\./g, "."), bars: riskBars, bars2: driverBars, list: ev.filter((e) => e.kind !== "model").map((e) => e.text), advice }];
    const sc = c.scores || {};
    const scoreNames = { physical_score: "Physical health score", mental_score: "Mental health score", distress_k6: "Distress (K6)", depression_phq2: "Depression (PHQ-2)", pain: "Pain", fatigue: "Fatigue", financial_toxicity: "Money worries", cost_delay: "Delayed care for cost" };
    const rows = Object.entries(sc).map(([k, v]) => [scoreNames[k] || k, v == null ? "not answered" : num(v, 1)]);
    const useRows = [["ER visits", use.erVisits], ["Hospital stays", use.hospitalStays], ["Office visits", use.officeVisits], ["Prescription fills", use.rxFills]].filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
    if (rows.length || useRows.length) panels.push({ id: "survey", title: "Survey answers and care use (data year 2017)", charts: [], advice: [], table: { head: ["Measure", "Data year 2017"], rows: [...useRows, ...rows] } });
    // Red-flag routing first (C1 redFlags): the symptoms that mean "call today" whatever the tier, then this
    // patient's survey-based follow-ups and any social-needs referral.
    const rf = d.redFlags || null;
    if (rf && (rf.banner || (rf.callTodayIf || []).length)) {
      const sn = rf.socialNeeds && rf.socialNeeds.needed ? [{ title: rf.socialNeeds.text, text: "", tag: "Social needs" }] : [];
      panels.unshift({ id: "redflags", title: rf.careTeamToday ? "Call the care team today" : "Red flags: call the care team or go to the ER today",
        lead: [rf.banner, rf.callTodayText, rf.asOf && `(${rf.asOf}.)`].filter(Boolean).join(" "), list: rf.callTodayIf || [], charts: [],
        advice: [...(rf.fromSurvey || []).map((x) => ({ title: x.text, text: "", tag: x.urgency === "today" ? "Today" : x.urgency === "this-week" ? "This week" : "From the survey" })), ...sn],
        asOf: rf.asOf || "" });
    }
    const fin = m && m.finalModel ? m.finalModel.key : null, fm = m && m.metrics ? (fin && m.metrics[fin]) || m.metrics.logistic : null;
    const dev = m && m.data ? m.data.devSurvivors : null;
    const rv = isNum(d.risk) ? d.risk : r.value, alertAt = r.alertFrom ?? (d.thresholds && d.thresholds.alert), watchAt = r.watchFrom ?? (d.thresholds && d.thresholds.watch);
    const careTeam = recs.find((x) => x.audience === "care-team") || recs[0];
    const hero = {
      label: "ER or hospital stay, next 12 months", value: isNum(rv) ? pct(rv) : NR,
      st: !isNum(rv) ? ST.none() : isNum(alertAt) && rv >= alertAt ? ST.redW("High tier") : isNum(watchAt) && rv >= watchAt ? ST.amber("Middle tier") : ST.green("Low tier"),
      compare: isNum(r.baseRate) ? `Average patient ${pct(r.baseRate)}${isNum(alertAt) ? ` · high tier (top of three risk groups) from ${pct(alertAt)}` : ""}` : "",
      means: d.riskWords ? `${sentence(d.riskWords)}.`.replace(/\.\.$/, ".") + (pos.length ? ` Driven most by ${low(pos[0].label)}${cost(pos[0]) ? " (a cost proxy for need)" : ""}.` : "") : "No plain-words reading from this program.",
      todo: careTeam ? careTeam.text : "No action from this program right now.",
      caveat: d.caveat || "",
      top: rf && rf.careTeamToday ? { tone: "red", text: rf.banner || "Call the care team today." } : caution && !caution.soft ? { tone: "amber", text: `${caution.label}. ${caution.text}.` } : null,
      source: `Real survivor (MEPS 2017 survey), scored by the deployed model as an unseen patient${fm && fm.auroc ? `. Model AUROC ${num(fm.auroc.value, 2)} (how well it ranks who ends up in hospital; 0.5 = chance, 1 = perfect), 95% CI ${num(fm.auroc.ci95[0], 2)}–${num(fm.auroc.ci95[1], 2)} (the range the true value likely sits in), cross-validated${dev ? ` on ${dev} patients` : ""}` : ""}.`,
    };
    const fit = caution && !caution.soft ? { tone: "amber", text: `Less reliable for ${caution.groups.join(", ")}: check this score by hand. ${caution.text}.` }
      : caution ? { tone: "neutral", text: `${caution.label}: wide uncertainty for this group. ${caution.text}.` }
      : m && Array.isArray(m.fairness) ? { tone: "green", text: "No reliability gap found for this patient's age, sex, race, insurance or cancer groups (cross-validated: tested on patients held back from training, in turns)." }
      : { tone: "neutral", text: "Subgroup check not available right now (the model card did not load)." };
    return {
      name: demoName(d.displayName), headline, caution, forEllie: d.forEllie || "", hero, fit,
      tags: [caution && { label: caution.label, tone: caution.soft ? "info" : "warn" }, { label: `ER/hospital ${pct(d.risk)} · 12 months`, tone: d.status === "alert" ? "risk" : d.status === "watch" ? "warn" : "info" }, ...pos.slice(0, 3).map((x) => ({ label: x.label + (cost(x) ? " (cost proxy)" : ""), tone: "warn" }))].filter(Boolean),
      kpis: [{ hero: true, value: isNum(d.risk) ? pct(d.risk) : NR, label: "ER or hospital stay, next 12 months", sub: d.riskWords || (r.baseRate != null ? `average patient ${pct(r.baseRate)}` : ""), good: d.status === "alert" ? false : d.status === "ok" ? true : null }, use.erVisits != null && { value: String(use.erVisits), label: "ER visits, data year 2017", sub: "most survivors had none · real MEPS", good: use.erVisits === 0 ? true : null }, use.hospitalStays != null && { value: String(use.hospitalStays), label: "Hospital stays, data year 2017", sub: "most survivors had none · real MEPS", good: use.hospitalStays === 0 ? true : null }].filter(Boolean),
      panels, evidence: null,
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
  function c3Fit(d, m) {
    const f = m && m.fairness, p = d.profile || {};
    if (!f || !Array.isArray(f.dimensions)) return { tone: "neutral", text: "Subgroup check not available right now (the model card did not load)." };
    const a = p.age, band = a == null ? null : a < 50 ? "under 50" : a < 65 ? "50-64" : "65+";
    const want = { preferred_language: p.language, cancer_type: p.cancerType, sex: p.sex, age_group: band, lives_alone: p.livesAlone, device: p.device };
    const rows = f.dimensions.flatMap((dm) => (dm.rows || []).filter((r) => want[dm.dimension] != null && String(r.group).toLowerCase() === String(want[dm.dimension]).toLowerCase()).map((r) => ({ ...r, label: dm.label })));
    const rc = (r) => `${pct(r.recall)} of rough weeks caught, 95% CI ${pct(r.recallCi95 && r.recallCi95[0])}–${pct(r.recallCi95 && r.recallCi95[1])}, vs ${pct(f.overallRecall)} overall`;
    const below = rows.filter((r) => r.belowOverall), unsure = rows.filter((r) => r.lowerButUncertain), few = rows.filter((r) => r.tooFewToJudge);
    if (below.length) return { tone: "amber", text: `Less reliable for ${below.map((r) => `${r.label.toLowerCase()} ${r.group}`).join(", ")} (${rc(below[0])}): check by hand.` };
    if (unsure.length) return { tone: "amber", text: `Possibly less reliable for ${unsure.map((r) => `${r.label.toLowerCase()} ${r.group}`).join(", ")} (${rc(unsure[0])}); too few patients to be sure.` };
    if (few.length) return { tone: "neutral", text: `Too few ${few.map((r) => `${r.label.toLowerCase()} ${r.group}`).join(", ")} patients in the test set to judge. No gap found for their other groups.` };
    return rows.length ? { tone: "green", text: `No gap found for this patient's ${rows.map((r) => r.label.toLowerCase()).join(", ")} (held-out test patients: kept back from training).` } : { tone: "neutral", text: "No subgroup in the model card matches this patient." };
  }
  function c3View(d, m) {
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
      id: "risk", title: "Chance of a rough week in the next 7 days", lead: d.summary,
      charts: c.risk ? [{ x, series: [series("risk", "Rough week, 7 days"), c.urgentRisk && { values: c.urgentRisk, color: "var(--alert)", label: "ER or hospital, 7 days" }].filter(Boolean), refs: d.thresholds ? [{ y: d.thresholds.alert, label: "alert", color: "var(--ink-2)" }, { y: d.thresholds.watch, label: "watch" }] : [], ticks: doses, min: 0, h: 220, pct: true, title: "Forecast, last 42 days", note: "ticks = treatment days" }] : [],
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
    const th = d.thresholds || {};
    const firstRec = (d.recommendations || [])[0];
    const hero = {
      label: "Rough week, next 7 days", value: isNum(d.risk) ? pct(d.risk) : NR,
      st: !isNum(d.risk) ? ST.none() : isNum(th.alert) && d.risk >= th.alert ? ST.redW("Above alert line") : isNum(th.watch) && d.risk >= th.watch ? ST.amber("Near alert line") : ST.green("Below alert line"),
      compare: [isNum(th.alert) && `Alert line ${pct(th.alert)}`, isNum(d.scheduleRisk) && `treatment calendar alone ${pct(d.scheduleRisk)}`].filter(Boolean).join(" · "),
      means: "Chance a rough patch starts within 7 days, from watch signals against their own usual plus the treatment calendar.",
      todo: firstRec ? firstRec.action + (firstRec.urgency && !new RegExp(firstRec.urgency.replace(/^this /i, ""), "i").test(firstRec.action) ? ` (${firstRec.urgency})` : "") : "No action from this program right now.",
      top: c3Urgent(d) ? { tone: "red", text: `Act today: ${String(d.headline || "").replace(/^urgent:\s*/i, "")}${isNum(th.urgent) ? ` (urgent line ${pct(th.urgent, 1)})` : ""}.` } : null,
      spark: c.risk ? { values: lastN(c.risk, 14), ref: isNum(th.alert) ? { y: th.alert, label: "alert" } : null, pct: true, note: "Last 14 days · dashed = alert line" } : null,
      source: "Synthetic wearable cohort. Accuracy measured on a held-out test split (25% of patients kept back from training).",
    };
    // Health-monitor rows: each signal against the patient's own usual range (middle 80% of the days before the last week).
    const evBy = Object.fromEntries(ev.map((e) => [e.signal, e]));
    const signals = [["sleep", "sleepHours", "Sleep", "h a night", 1], ["steps", "steps", "Steps", "a day", 0], ["resting_heart_rate", "restingHeartRate", "Resting heart rate", "bpm", 1], ["hrv_rmssd_ms", "hrv", "Heart rate variability", "ms", 0]].filter(([, k]) => Array.isArray(c[k]) && c[k].some(isNum)).map(([sig, k, title, unit, dp]) => {
      const vals = c[k], before = vals.slice(0, -7), recent = vals.slice(-7);
      const lo = quant(before, 0.1), hi = quant(before, 0.9), usual = quant(before, 0.5), now = mean(recent), e = evBy[sig];
      if (!isNum(now) || !isNum(usual)) return { title, unit, missing: true };
      const delta = now - usual, inBand = isNum(lo) && isNum(hi) && now >= lo && now <= hi;
      const sameUnit = e && e.unit === unit && e.change;
      const dTxt = `${delta >= 0 ? "+" : "−"}${num(Math.abs(delta), dp)} ${unit === "a day" ? "steps" : unit === "h a night" ? "h" : unit}`;
      return { sig, title, unit, dp, lo, hi, usual, now, values: lastN(vals, 14), drives: !!e,
        text: sameUnit ? `${e.change} ${String(e.change).trim().startsWith("-") ? "below" : "above"} usual`.replace(/^([+-])/, (x) => (x === "-" ? "−" : x))
          : e && isNum(e.value) && isNum(e.baseline) ? `${e.unit && /efficiency/.test(e.unit) ? "Efficiency " : ""}${num(e.value)}${/%/.test(e.unit || "") ? "%" : ""} vs usual ${num(e.baseline)}${/%/.test(e.unit || "") ? "%" : ""}` : Math.abs(delta) < (hi - lo) * 0.05 || !isNum(hi) ? "At their usual" : `${dTxt} ${delta >= 0 ? "above" : "below"} usual`,
        st: e ? ST.amber("Moves the forecast") : inBand ? ST.green("Within usual range") : ST.none("Outside usual, not driving it"),
        why: e ? e.text : "" };
    });
    return {
      name: demoName(d.displayName), hero, signals, fit: c3Fit(d, m),
      tags: [c3Urgent(d) && { label: `ER/hospital ${pct(d.urgentRisk)} · 7 days`, tone: "risk" }, { label: `Rough week ${pct(d.risk)}`, tone: d.status === "alert" ? "risk" : d.status === "watch" ? "warn" : "info" }, ...ev.filter((e) => e.signal !== "schedule").slice(0, 3).map((e) => ({ label: `${e.label} ${e.change || ""}`.trim(), tone: "warn" }))].filter(Boolean),
      kpis: [d.urgentRisk != null && { value: pct(d.urgentRisk), label: "ER or hospital risk, 7 days", sub: d.thresholds && d.thresholds.urgent != null ? `urgent line ${pct(d.thresholds.urgent, 1)}` : "", good: d.urgent ? false : null, spark: c.urgentRisk ? { values: lastN(c.urgentRisk, 14), ref: isNum(th.urgent) ? { y: th.urgent } : null, pct: true } : null }, { hero: true, value: pct(d.risk), label: "Rough-patch risk, 7 days", sub: d.thresholds ? `alert line ${pct(d.thresholds.alert, 1)}` : "", good: d.thresholds && d.risk != null ? (d.risk >= d.thresholds.alert ? false : d.risk < d.thresholds.watch ? true : null) : null }, { value: isNum(d.scheduleRisk) ? pct(d.scheduleRisk) : NR, label: "From treatment calendar alone", sub: "what the schedule alone predicts", good: null }, lastWear.length && { value: num(lastWear.reduce((a, b) => a + b, 0) / lastWear.length, 1) + " h", label: "Watch worn a day", sub: "last 7 days; forecast needs ~12 h", good: lastWear.reduce((a, b) => a + b, 0) / lastWear.length >= 12, spark: { values: lastN(c.watchWornHours, 14), ref: { y: 12 }, d: 1 } }].filter(Boolean),
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
      // Meaning + action only: the first sentence stays, the rest folds under "Why" on the card.
      const adv = { title: r.title, text: firstSentence(r.text), more: restOf(r.text), caution: r.caution || "", tag: basisName[r.basis] || r.basis, tone: r.basis === "rule" ? "risk" : "info", evidence: (r.evidenceIds || []).map((id) => evById[id]).filter(Boolean).slice(0, 3) };
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
    const evidence = ["person", "cohort", "trial", "real"].map((s) => ({ group: scopeName[s], scientists: s !== "person", open: s === "person", rows: (d.evidence || []).filter((e) => e.scope === s).map((e) => ({ label: e.label, caveat: e.caveat, value: e.value == null ? "–" : `${num(e.value, 1)} ${e.unit || ""}`, ci: e.ci ? `${num(e.ci[0], 1)} to ${num(e.ci[1], 1)}` : "", n: e.n ?? "" })) })).filter((g) => g.rows.length);
    let tags = d.tags;
    if (!Array.isArray(tags)) { note("c4", "tags[] (not provided)"); tags = []; }
    // Severe: extreme highs (average 250+ or under 10% in range) or frequent lows (4%+ below 70). Stale: last reading over 60 days old.
    const val = (id) => (evById[id] && evById[id].value != null ? evById[id].value : null), tir = val("tir"), mg = val("mean_glucose"), tbr = val("tbr70");
    const severe = [((mg != null && mg >= 250) || (tir != null && tir < 10)) && `very high sugar (average ${num(mg)} mg/dL, ${num(tir)}% in range)`, tbr != null && tbr >= 4 && `frequent lows (${num(tbr, 1)}% below 70)`].filter(Boolean);
    const last = Date.parse(d.updatedAt || ""), staleDays = isNaN(last) ? null : Math.floor((Date.now() - last) / 864e5);
    const stale = staleDays != null && staleDays > 60 ? `No data for ${Math.round(staleDays / 30.4)} months` : null;
    tags = [...severe.map((x) => ({ label: `Severe: ${x.split(" (")[0]}`, tone: "risk" })), stale && { label: stale, tone: "warn" }, ...tags].filter(Boolean);
    const ctf = d.careTeamFlag && d.careTeamFlag.today ? { reasons: (d.careTeamFlag.reasons || []).map((x) => x.reason).filter(Boolean), rule: d.careTeamFlag.rule || "" } : null;
    const hypo = d.hypoglycaemiaWarning && d.hypoglycaemiaWarning.text ? { level: d.hypoglycaemiaWarning.level, text: d.hypoglycaemiaWarning.text, tr: d.hypoglycaemiaWarning.translations || {} } : null;
    const window_ = ((evById.tir && evById.tir.label) || "").match(/\(([^)]+)\)/);
    const dp = c.dailyProfile && Array.isArray(c.dailyProfile.series) ? [...c.dailyProfile.series].reverse().find((x) => Array.isArray(x.values) && x.values.some(isNum)) : null;
    const tar250 = val("tar250"), tar180 = val("tar180");
    const hero = {
      label: "Time in range (70–180 mg/dL, the target band)", value: isNum(tir) ? `${num(tir)}%` : NR,
      st: !isNum(tir) ? ST.none() : tir < 10 ? ST.redW("Far off target") : tir >= 70 ? ST.green(tir >= 90 ? "At ideal" : "On target") : ST.amber("Below target"),
      compare: `Target over 70%, ideal 90%+${isNum(mg) ? ` · average ${num(mg)} mg/dL (milligrams per decilitre, the blood-sugar unit)` : ""}${window_ ? ` · ${window_[1]}` : ""}`,
      means: isNum(tir) ? `${num(tir)} of every 100 readings were in the target band${isNum(tbr) && tbr > 0 ? `, ${num(tbr, 1)} below 70` : ", none below 70"}${isNum(tar180) && tar180 > 0 ? `, ${num(tar180, 1)} above 180` : ", none above 180"}.` : "No readings in this window.",
      todo: d.plainSummary ? firstSentence(d.plainSummary) + (restOf(d.plainSummary) ? " " + firstSentence(restOf(d.plainSummary)) : "") : ((d.recommendations || [])[0] || {}).title || "No action from this program right now.",
      top: ctf ? { tone: "red", text: `Send to the care team today: ${ctf.reasons.join("; ") || "glucose over the care-team line"}.` } : null,
      bar: isNum(tir) ? [["Below 70", tbr, "red"], ["70–180", tir, "green"], ["181–250", isNum(tar180) && isNum(tar250) ? Math.max(0, tar180 - tar250) : null, "amber"], ["Above 250", tar250, "red"]].filter(([, v]) => isNum(v)).map(([label, v, tone]) => ({ label, v, tone })) : null,
      spark: dp ? { values: dp.values, band: (c.dailyProfile.targetRange || [70, 180]), note: `Blood sugar by hour of day, ${String(dp.label || "").replace(/^weeks/i, "weeks")} · band = 70–180` } : null,
      source: "Synthetic CGM data (Crane Lab set), this person's readings. Program-wide and real-data (CGMacros, NHANES) checks sit under For scientists.",
    };
    const pv = d.patientView && typeof d.patientView === "object" ? ["en", "es", "ht"].filter((k) => d.patientView[k]).map((k) => ({ lang: k, name: { en: "English", es: "Español", ht: "Kreyòl" }[k], ...d.patientView[k] })) : [];
    return {
      name: demoName(d.displayName), severe, staleDays, hero, careFlag: ctf, hypo, handout: pv.length ? { langs: pv, note: d.patientView.note || "" } : null,
      tags, reasons: [...severe.map((x) => "severe: " + x), ...(d.statusReasons || []), ...(stale ? [`${stale.toLowerCase()} (last reading ${new Date(last).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`] : [])],
      kpis: [kp("tir", "Time in range", "target over 70%, ideal 90%+", (v) => (v >= 90 ? true : v < 70 ? false : null)) && { ...kp("tir", "Time in range", "target over 70%, ideal 90%+", (v) => (v >= 90 ? true : v < 70 ? false : null)), hero: true }, kp("tbr70", "Lows (below 70)", "target under 4%", (v) => v <= 4, 1), kp("mean_glucose", "Average sugar", "mg/dL, target 154 or less", (v) => v <= 154), kp("late_share", "Late dinners", "share at 8 pm or later", null), kp("fast_avg", "Overnight fast", "hours, average", null, 1)].filter(Boolean),
      panels, evidence, footnote: d.dataNote || "",
    };
  }

  // ---- C5 Coach's Clef
  function c5View(d) {
    const calls = (d.charts && d.charts.calls) || [];
    const flagLines = calls.reduce((s, c) => s + (c.flags ? c.flags.length : 0), 0);
    const scored = [...calls].reverse().filter((c) => c.score != null);
    const recs = (d.recommendations || []).map((r) => ({ title: r.action, text: r.why || "", tag: r.urgency, tone: r.urgency === "today" ? "risk" : "info" }));
    const panels = [{ id: "calls", title: "Calls", lead: "Supervisor-labelled. Open a call to run Clef on it.", calls, charts: scored.length > 1 ? [{ x: scored.map((c) => "Call " + c.callNumber), series: [{ values: scored.map((c) => c.score), color: "var(--m-c5)", label: "Coach score", dots: true }], refs: [{ y: 60, label: "target 60" }], min: 0, max: 100, h: 150, title: "Coach score by call", note: "out of 100" }] : [], advice: recs }];
    const flags = (d.evidence || []).filter((e) => String(e.kind || "").startsWith("flag"));
    if (flags.length) panels.push({ id: "concerns", title: "Lines that need a person", lead: "From the supervisor’s labels.", list: flags.map((e) => e.text), charts: [], advice: [] });
    const last = calls[0], fl = flags[0], callFlag = calls.find((c) => c.flags && c.flags.length);
    const lastScore = last && isNum(last.score) ? last.score : null;
    const hero = {
      label: "Coach score, latest call", value: isNum(lastScore) ? String(lastScore) : NR, unit: isNum(lastScore) ? "/100" : "",
      st: !isNum(lastScore) ? ST.none() : lastScore >= 60 ? ST.green("On target") : ST.amber("Below target"),
      compare: `Target 60 or more${scored.length > 1 ? ` · ${scored.length} scored calls` : ""}`,
      means: "How closely the coach followed motivational-interviewing targets (reflections, open questions, no persuading), from the supervisor's labels.",
      todo: recs[0] ? recs[0].title : "No action from this program right now.",
      top: callFlag ? { tone: d.status === "alert" ? "red" : "amber", text: `Flagged line, call ${callFlag.callNumber} at ${callFlag.flags[0].t}: “${String(callFlag.flags[0].text).replace(/^(oh,?\s+)?before you go,?\s*/i, "")}”${d.status === "alert" ? " Tell the care team today." : ""}` } : fl ? { tone: "red", text: fl.text } : null,
      spark: scored.length > 1 ? { values: scored.map((c) => c.score), ref: { y: 60, label: "target" }, d: 0, note: "Score by call, oldest first · dashed = target 60" } : null,
      source: "Synthetic coaching calls, supervisor-labelled.",
    };
    return {
      hero,
      tags: Array.isArray(d.tags) ? d.tags : [flagLines ? { label: flagLines === 1 ? "1 line needs a person" : `${flagLines} lines need a person`, tone: "risk" } : null, calls[0] && calls[0].score != null ? { label: `Score ${calls[0].score}`, tone: calls[0].score < 60 ? "warn" : "good" } : null, { label: `${calls.length} call${calls.length === 1 ? "" : "s"}`, tone: "info" }].filter(Boolean),
      kpis: [calls[0] && { hero: true, value: `${calls[0].score ?? NR}`, label: "Coach score, latest call", sub: "target 60 or more", good: calls[0].score == null ? null : calls[0].score >= 60 }, { value: String(flagLines), label: "Lines that need a person", sub: "supervisor labels, all calls", good: flagLines === 0 }, { value: String(calls.length), label: "Calls on file", sub: "supervisor-labelled set", good: null }].filter(Boolean),
      panels, evidence: null, footnote: "Calls and labels from Clef’s supervisor-labelled set. Synthetic patients.",
    };
  }

  // ------------------------------------------------------------------ linked demo records
  /* The four programs use separate cohorts. For the demo, each linked record joins one real record from each program,
     matched by sex and cancer type with ages within about 10 years. Not one real person; the page says so. */
  const LINKED = [
    { id: "x-L1", c5: "c5-P0975", c1: "c1-SC4BAD40B", c3: "c3-P02859", c4: "c4-N1530", first: "Donna", who: "65F · colorectal" },
    { id: "x-L2", c5: "c5-P0002", c1: "c1-SFDB6493A", c3: "c3-P01011", c4: "c4-N1706", first: "María", who: "52F · colorectal" },
    { id: "x-L3", c5: "c5-P0540", c1: "c1-S10BB1CA4", c3: "c3-P02440", c4: "c4-N1944", first: "Rosa", who: "57F · endometrial" },
    { id: "x-L4", c5: "c5-P0420", c1: "c1-S6A875359", c3: "c3-P00718", c4: "c4-N0950", first: "Michael", who: "59M · prostate" },
    { id: "x-L5", c5: "c5-P0998", c1: "c1-SE3556D56", c3: "c3-P01389", c4: "c4-N0920", first: "Karen", who: "58F · breast" },
  ];
  const LMODS = ["c1", "c3", "c4", "c5"], TRI_RANK = { today: 0, alert: 1, watch: 2, ok: 3 };
  const linked = () => LINKED.map((l) => ({ ...l, name: `${l.first} · linked demo record`, members: Object.fromEntries(LMODS.map((m) => [m, l[m]])) }));
  async function linkedPatient(id, get) {
    get = get || ((mid) => patient(mid));
    const L = LINKED.find((x) => x.id === id);
    if (!L) { const e = new Error("There is no linked demo record with this ID."); e.notFound = true; throw e; }
    // Each member loads with its own program's logic; one failing program shows its own error, the rest still render.
    const got = await Promise.all(LMODS.map((m) => get(L[m]).then((v) => [m, v]).catch((e) => [m, { id: L[m], mod: m, error: e.message || "No answer" }])));
    const members = Object.fromEntries(got), ok = LMODS.map((m) => members[m]).filter((m) => !m.error);
    if (!ok.length) throw new Error("None of the four programs answered for this linked record. Try again in a minute.");
    const worst = ok.reduce((a, b) => (TRI_RANK[b.tri] < TRI_RANK[a.tri] ? b : a));
    const c5 = members.c5.error ? null : members.c5;
    const facts = c5 ? c5.facts : [["Age", L.who.split("·")[0].trim()]];
    return {
      id, mod: "x", linked: true, name: `${L.first} · linked demo record`, first: L.first, members, status: worst.status, tri: worst.tri,
      identity: c5 ? c5.identity : { age: null, sex: null, cancer: L.who.split(" · ")[1] + " cancer", language: null },
      facts: [...facts, ["Linked records", LMODS.map((m) => L[m]).join(", ")]],
      callId: L.c5, headline: worst.hero && worst.hero.top ? worst.hero.top.text : worst.headline,
      forEllie: (members.c1 && members.c1.forEllie) || "",
      tags: ok.map((m) => ({ label: `${MODULES[m.mod].name}: ${m.hero ? m.hero.value + " · " + m.hero.st.word : m.tri}`, tone: m.tri === "today" || m.tri === "alert" ? "risk" : m.tri === "watch" ? "warn" : "info" })),
      kpis: ok.filter((m) => m.hero).map((m) => ({ value: m.hero.value + (m.hero.unit || ""), label: `${MODULES[m.mod].name}: ${m.hero.label}`, sub: m.hero.compare, good: null })),
      panels: ok.map((m) => ({ id: m.mod, title: `${MODULES[m.mod].name}: ${m.headline}`, advice: m.panels.flatMap((pn) => pn.advice || []).slice(0, 2) })),
      handoff: c5 && c5.handoff, lastSaved: c5 && c5.lastSaved, concern: c5 && c5.concern,
      missing: [], footnote: "Linked demo record: four programs' separate cohorts joined by matching sex, cancer type and age (within about 10 years). Not one real person.",
    };
  }

  // ------------------------------------------------------------------ calls and advice
  const calls = () => fetchJSON("/api/c5/calls");
  // One ranked queue across the programs (GET /api/today): reason, data type and language per row.
  const today = () => fetchJSON("/api/today");
  const call = (id) => fetchJSON(`/api/c5/calls/${encodeURIComponent(id)}`);
  async function advice(id) {
    const mod = id.split("-")[0];
    if (mod === "c4") {
      try { const a = await fetchJSON(`/api/c4/survivors/${encodeURIComponent(id)}/advice`); if (a && Array.isArray(a.items) && a.items.length) return a.items.map((i) => ({ id: i.id, title: i.title, text: i.text, rule: /talk_to_team|overnight_fast/.test(i.id) && /care team/i.test(i.text), source: i.source })); } catch (e) { /* fall through to templates */ }
    }
    return null;
  }

  // Program-level metrics (C1 care-team page, C3 model card). Same live → saved-copy fallback.
  async function metrics(mod) { return fetchJSON(`/api/${mod}/metrics`, []); }

  // ---- C5 supervisor agreement (GET /api/c5/agreement): Clef's coach score against Supervisors A and B on
  // held-out calls, with supervisor-vs-supervisor as the yardstick. Resolves to the UI shape (agreementView) or throws.
  // It is a side panel: its success or failure must not change the C5 "isn't answering" banner, so health.c5 is restored.
  async function agreement() {
    const prev = health.c5;
    try {
      const v = agreementView(await fetchJSON("/api/c5/agreement"));
      if (!v) throw new Error("agreement: unexpected shape");
      return v;
    } finally { if (prev) health.c5 = prev; else delete health.c5; }
  }
  // Pure: endpoint body -> { calls, headline, rows, flagLead, flags, method, label }, or null when a needed pair is missing.
  function agreementView(d) {
    const cs = d && Array.isArray(d.correlations) ? d.correlations : [];
    const pair = (re) => cs.find((c) => c && re.test(String(c.pair || "")) && c.pearson != null);
    const cA = pair(/^app score vs supervisor a$/i), cB = pair(/^app score vs supervisor b$/i), cAB = pair(/^supervisor a vs supervisor b$/i);
    if (!cA || !cB || !cAB) return null;
    const cM = pair(/^app score vs mean of a and b$/i), cH = pair(/^human-label score vs mean/i), cAH = pair(/^app score vs human-label/i);
    const mae = d.mae || {}, icc = d.supervisorIcc || {}, fl = d.flags || {};
    const f2 = (v) => num(v, 2);
    const range = (a, f) => (Array.isArray(a) && a[0] != null && a[1] != null ? `${f(a[0])}–${f(a[1])}` : "");
    // The verb comes from the intervals: "more/less closely" only when both Clef intervals clear the A-vs-B interval.
    const lo = (c) => (Array.isArray(c.pearsonCi95) ? c.pearsonCi95[0] : c.pearson), hi = (c) => (Array.isArray(c.pearsonCi95) ? c.pearsonCi95[1] : c.pearson);
    const verb = lo(cA) > hi(cAB) && lo(cB) > hi(cAB) ? "more closely than" : hi(cA) < lo(cAB) && hi(cB) < lo(cAB) ? "less closely than" : "about as closely as";
    const n = d.calls || cAB.n;
    const headline = `On ${num(n)} held-out calls, Clef’s coach score agrees with each supervisor ${verb} the two supervisors agree with each other: correlation ${f2(cA.pearson)} with Supervisor A and ${f2(cB.pearson)} with Supervisor B, against ${f2(cAB.pearson)} between A and B (1 = perfect agreement, 0 = none).`;
    const row = (c, label, note, extra) => ({ pair: label, note: note || "", n: num(c.n), r: f2(c.pearson), ci: range(c.pearsonCi95, f2), mae: "–", icc: "–", iccCi: "", ...extra });
    const maeAB = mae.maeAvsB ?? icc.mae;
    const rows = [
      row(cA, "Clef vs Supervisor A", "", mae.maeVsA != null ? { mae: f2(mae.maeVsA) } : {}),
      row(cB, "Clef vs Supervisor B", "", mae.maeVsB != null ? { mae: f2(mae.maeVsB) } : {}),
      cM && row(cM, "Clef vs average of A and B", ""),
      row(cAB, "Supervisor A vs Supervisor B", "The yardstick: how much two people agree", { yard: true, mae: maeAB != null ? f2(maeAB) : "–", icc: icc.icc21 != null ? f2(icc.icc21) : "–", iccCi: range(icc.ci95, f2) }),
      cH && row(cH, "Same formula on human line labels vs average of A and B", "Reference: the most this score formula reaches with human tags"),
      cAH && row(cAH, "Clef vs the same formula on human line labels", "Reference: how closely Clef’s tags reproduce the human tags"),
    ].filter(Boolean);
    const pctS = (v) => (v == null ? "–" : (v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0) + "%");
    const pctR = (a) => range(a, pctS).replace("%–", "–");
    const per10k = (v) => num(v * 1e4, 0);
    const fa = fl.falseAlarmsPerLine;
    const flags = [
      fl.recall && { label: "Concerns caught (recall)", count: `${num(fl.recall.k)} of ${num(fl.recall.n)} lines supervisors flagged`, rate: pctS(fl.recall.rate), ci: pctR(fl.recall.ci95) },
      fa && fa.n && { label: "False alarms per line", count: `${num(fa.k)} of ${num(fa.n)} patient lines`, rate: `${num((fa.k / fa.n) * 1e4, 1)} per 10,000`, ci: Array.isArray(fa.ci95) ? `${per10k(fa.ci95[0])}–${per10k(fa.ci95[1])} per 10,000` : "" },
      fl.callsWithFalseAlarm && { label: "Calls with a false alarm", count: `${num(fl.callsWithFalseAlarm.k)} of ${num(fl.callsWithFalseAlarm.n)} held-out calls (every validation call, not only the ${num(n)} rated)`, rate: pctS(fl.callsWithFalseAlarm.rate), ci: pctR(fl.callsWithFalseAlarm.ci95) },
      fl.coachConductAgreement && { label: "Coach handled the safety issue: Clef agrees with supervisors", count: `${num(fl.coachConductAgreement.k)} of ${num(fl.coachConductAgreement.n)} calls supervisors rated`, rate: pctS(fl.coachConductAgreement.rate), ci: pctR(fl.coachConductAgreement.ci95) },
    ].filter(Boolean);
    const method = [
      ...String(d.method || "").split(/\n\s*\n/).map((s) => s.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean),
      mae.note ? `MAE (mean absolute error): ${String(mae.note).replace(/\s*\([^)]*below\)/, "")}${mae.slope != null ? ` (slope ${mae.slope}, intercept ${mae.intercept})` : ""}. It is the average gap in points on the supervisors’ 1–5 scale. ICC(2,1) is computed for A vs B only.` : "",
      fl.source ? `Flags: ${fl.source}. The 95% intervals on flag rates are Wilson score intervals.` : "",
    ].filter(Boolean);
    return { calls: n, headline, rows, flagLead: "Clef’s safety flags compared with the supervisors’ flags on the same held-out calls.", flags, method, label: "Synthetic data, Crane Lab" };
  }
  window.Adapter = { MODULES, linked, IDENTITY_KEYS, today, roster, patient, calls, call, advice, metrics, agreement, agreementView, health, missing, triage, demoName, shortName, c1Headline, fairFlag, context, remember, local, ago, savedAsCall, handoffLabel };
})();
