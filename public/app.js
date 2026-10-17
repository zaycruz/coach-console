/* Patient 360. Plain JS, no build step. All module knowledge lives in adapters.js (window.Adapter);
   this file only renders the UI shape. Communication pattern (from the glucose team's page): one plain
   headline, a few KPI cards each with its target, then numbered "what to do" cards with the chart that
   backs each one beside it. Everything else is folded away. */
(function () {
  "use strict";
  // The product name lives here and only here: brand text, document title and window.P360.NAME read it.
  const NAME = "Patient 360";
  document.title = NAME;
  document.querySelectorAll(".brand-name").forEach((el) => (el.textContent = NAME));
  const LIVE_URL = "https://patient-360.raava.dev";
  const COPILOT_URL = "https://coach.raava.dev";
  const SNAP = !!window.SNAPSHOT_ONLY;
  const A = window.Adapter;
  const MODS = A.MODULES;
  const view = document.getElementById("view");
  let previewState = "ready";
  const ui = { filter: "all", q: "", limit: 60 };
  const ALL = ["c1", "c3", "c4", "c5"];
  const memo = new Map();
  const once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn().catch((e) => { memo.delete(k); throw e; })); return memo.get(k); };
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(String(iso).length <= 10 ? iso + "T12:00:00" : iso); return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
  const pct = (v, d = 0) => (v == null ? "–" : (v * 100).toFixed(d) + "%");
  const num = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const triage = A.triage;
  const statusLabel = { ok: "On track", watch: "Watch", alert: "Watch", today: "Act today" };
  const statusPill = (s) => `<span class="status ${s}">${statusLabel[s] || esc(s)}</span>`;
  const modChip = (m) => `<span class="chip m-${m}"><span class="dot"></span>${MODS[m].challenge} · ${MODS[m].name}</span>`;
  const tagsHtml = (tags) => (tags && tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag t-${esc(t.tone || "info")}">${esc(t.label)}</span>`).join("")}</span>` : "");
  const notWired = (what) => `data-toast="${esc(what)}: not connected to a scheduling or messaging system yet"`;
  const RANK = { today: 0, alert: 1, watch: 2, ok: 3 };
  const GROUP = { today: "Act today", alert: "Watch", watch: "Watch", ok: "On track" };

  // ------------------------------------------------------------------ global states (one skeleton, one error box, one empty box)
  // Skeleton: rows shaped like the content they stand in for. kind "today" adds the hero card on top.
  function loadingBox(what, kind) {
    const row = `<div class="sk-row"><span class="sk sk-dot"></span><span class="sk-lines"><span class="sk" style="width:28%"></span><span class="sk" style="width:62%"></span></span><span class="sk sk-btn"></span></div>`;
    const hero = kind === "today" ? `<div class="sk-hero"><span class="sk" style="height:52px;width:180px"></span><span class="sk" style="width:46%"></span><span class="sk" style="width:58%"></span></div>` : `<div class="sk-head"><span class="sk" style="height:28px;width:32%"></span><span class="sk" style="width:54%"></span></div>`;
    return `<div class="sk-wrap" aria-busy="true" aria-live="polite"><span class="sr-only">Loading ${esc(what)}…</span>${hero}<div class="sk-list">${row.repeat(5)}</div></div>`;
  }
  function emptyBox(text, title, icon) {
    return `<div class="state-box"><span class="state-ico ${icon === "ok" ? "ok" : ""}" aria-hidden="true">${icon === "ok" ? "✓" : "○"}</span><h2>${esc(title || "Nothing here yet")}</h2><p class="muted">${esc(text)}</p></div>`;
  }
  /* Plain words for any failure. The UI never shows a status code, raw JSON or a stack trace. */
  function friendly(msg) {
    const m = String(msg ?? "");
    if (/\b429\b|rate.?limit|too many/i.test(m)) return "Busy for a moment. Try again in a minute.";
    if (/timed? ?out|abort/i.test(m)) return "The program took too long to answer. Try again in a moment.";
    if (/not found|\b404\b|unknown module/i.test(m)) return "We couldn’t find that record.";
    if (/shared copy holds a sample/i.test(m)) return m;
    if (/not answering|no saved copy/i.test(m)) return "The program isn’t answering and there is no saved copy of this page.";
    if (!m || /[{}<>]|\bHTTP\b|\b5\d\d\b|failed to fetch|network|TypeError|undefined|null|NaN|\bat \S+:\d+/i.test(m) || m.length > 140) return "The program didn’t answer. Try again in a moment.";
    return m;
  }
  function errorBox(what, msg) {
    const m = String(msg ?? "");
    // Unknown patient (404 from the module, or a link to a program that doesn't exist).
    if (/patient/.test(what) && /not found|\b404\b|unknown module/i.test(m)) {
      return `<div class="state-box" role="status"><span class="state-ico" aria-hidden="true">?</span><h2>We couldn’t find this patient</h2><p class="muted">The link may be old, or the ID mistyped. Search the Patients list by name or ID.</p><div class="row"><a class="btn primary" href="#patients">Search patients</a><a class="btn" href="#today">Back to Today</a></div></div>`;
    }
    const busy = /\b429\b|rate.?limit|too many/i.test(m);
    return `<div class="state-box error" role="alert"><span class="state-ico ${busy ? "" : "bad"}" aria-hidden="true">${busy ? "…" : "!"}</span><h2>${busy ? "Busy for a moment" : `Couldn’t load ${esc(what)}`}</h2><p class="muted">${esc(friendly(m))}</p><div class="row"><button class="btn primary" data-retry>Try again</button>${SNAP ? `<a class="btn" href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a>` : ""}</div></div>`;
  }
  function notFoundBox() {
    return `<div class="state-box" role="status"><span class="state-ico" aria-hidden="true">?</span><h2>This page doesn’t exist</h2><p class="muted">The link may be old. Today has everyone who needs a person.</p><div class="row"><a class="btn primary" href="#today">Go to Today</a></div></div>`;
  }
  function forced(what, emptyText, emptyTitle, kind) {
    return previewState === "loading" ? loadingBox(what, kind) : previewState === "empty" ? emptyBox(emptyText, emptyTitle) : previewState === "error" ? errorBox(what, "HTTP 503 from the module (preview).") : null;
  }
  function sourceBanner(mods) {
    return mods.map((m) => A.health[m]).map((h, i) => {
      if (!h || h.source === "live") return "";
      const m = mods[i];
      return `<div class="banner warn" role="status"><span class="b-ico" aria-hidden="true">▲</span><div class="b-body"><b>${MODS[m].challenge} ${MODS[m].name} isn’t answering.</b> ${h.source === "fallback" ? `Showing the saved copy${h.at ? " from " + esc(fmtDate(h.at)) : ""}.` : "No saved copy for this page."}</div></div>`;
    }).join("");
  }
  /* Top bar source status: one compact line ("All 4 programs live"); the per-program chips (.src) sit in a
     popover that opens on hover, focus or click. */
  let srcOpen = false;
  function updateMode() {
    const el = document.getElementById("mode");
    if (!el) return;
    if (SNAP) { el.innerHTML = `<span class="src-snap">Saved copy of live data · <a href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a></span>`; return; }
    const st = ALL.map((m) => { const h = A.health[m]; return [m, !h ? "unknown" : h.source]; });
    const word = (s) => (s === "live" ? "live" : s === "fallback" ? "saved copy" : s === "down" ? "down" : "checking");
    const down = st.filter(([, s]) => s === "down"), fb = st.filter(([, s]) => s === "fallback"), wait = st.filter(([, s]) => s === "unknown");
    const names = (xs) => xs.map(([m]) => MODS[m].name).join(", ");
    const [cls, glyph, long, short] = down.length ? ["st-down", "●", `${names(down)} down`, `${down.length} down`]
      : fb.length ? ["st-warn", "▲", `${names(fb)} on saved copy`, "Saved copy"]
      : wait.length === ALL.length ? ["st-wait", "○", "Checking programs…", "Checking…"]
      : wait.length ? ["st-wait", "○", `${ALL.length - wait.length} of ${ALL.length} programs live`, `${ALL.length - wait.length} of ${ALL.length} live`]
      : ["st-live", "✓", `All ${ALL.length} programs live`, `All ${ALL.length} live`];
    const chips = st.map(([m, s]) => `<span class="src s-${s}"><span class="dot m-${m}" aria-hidden="true"></span>${MODS[m].name}<span class="src-st"> · ${word(s)}</span></span>`).join("");
    el.innerHTML = `<div class="src-status ${cls}${srcOpen ? " open" : ""}"><button type="button" class="src-sum" data-src-toggle aria-expanded="${srcOpen}" aria-controls="src-pop"><span class="src-glyph" aria-hidden="true">${glyph}</span><span class="long">${long}</span><span class="short">${short}</span><span class="chev" aria-hidden="true">⌄</span></button>
      <div class="src-pop" id="src-pop" role="group" aria-label="Program data status"><p class="src-pop-t">Program data</p>${chips}<p class="src-pop-n">Live = answering now. Saved copy = the last good answer, shown when a program is down.</p></div></div>`;
  }

  // ------------------------------------------------------------------ chart
  /* One chart primitive: shared x labels, line series (solid or dashed), optional CI band per series,
     horizontal reference lines, a shaded y band, tick marks on chosen x indices, hover readout. */
  // A chart that can't be drawn never takes the page down with it.
  function chart(o) {
    try {
      const series = (o.series || []).filter((s) => s && Array.isArray(s.values) && s.values.some((v) => v != null)).map((s) => ({ ...s, band: s.band && Array.isArray(s.band[0]) && Array.isArray(s.band[1]) ? s.band : null }));
      const dropped = (o.series || []).filter((s) => s && !series.some((k) => k.label === s.label)).map((s) => s.label).filter(Boolean);
      if (series.length === 1) series[0].dash = false;
      return drawChart({ ...o, series, dropped });
    }
    catch (e) { console.warn("chart", o.title, e); return `<p class="small muted">${esc(o.title || "Chart")}: not available for this patient.</p>`; }
  }
  function drawChart(o) {
    if (!o.series.length) return `<p class="small muted">${esc(o.title || "Chart")}: no readings for this patient.</p>`;
    const W = 640, H = o.h || 160, pl = 44, pr = 12, pt = 14, pb = 24;
    const all = [];
    o.series.forEach((s) => { s.values.forEach((v) => v != null && all.push(v)); (s.band || []).forEach((arr) => arr.forEach((v) => v != null && all.push(v))); });
    (o.refs || []).forEach((r) => all.push(r.y));
    if (o.yband) all.push(...o.yband);
    if (!all.length) return `<p class="small muted">No readings in this window.</p>`;
    let lo = o.min != null ? Math.min(o.min, ...all) : Math.min(...all), hi = o.max != null ? Math.max(o.max, ...all) : Math.max(...all);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= o.min != null ? 0 : pad; hi += pad;
    const n = o.x.length;
    const X = (i) => pl + (n === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1));
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const fmt = o.yfmt || (o.pct ? (v) => pct(v) : o.d != null ? (v) => num(v, o.d) : (v) => num(v, Math.abs(hi - lo) < 5 ? 1 : 0));
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad].map((v) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${pl - 6}" y="${Y(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join("");
    const yband = o.yband ? `<rect class="yband" x="${pl}" width="${W - pl - pr}" y="${Y(o.yband[1])}" height="${Y(o.yband[0]) - Y(o.yband[1])}"/>` : "";
    const refs = (o.refs || []).map((r) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(r.y)}" y2="${Y(r.y)}" stroke="${r.color || "var(--ink-3)"}" stroke-dasharray="4 3" stroke-width="1"/><text x="${W - pr}" y="${Y(r.y) - 4}" text-anchor="end" class="ref">${esc(r.label)}</text>`).join("");
    const ticksX = (o.ticks || []).map((i) => `<line x1="${X(i)}" x2="${X(i)}" y1="${H - pb}" y2="${H - pb - 6}" stroke="var(--ink-2)" stroke-width="2"/>`).join("");
    const path = (vals) => { let d = "", pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; }); return d; };
    const bands = o.series.filter((s) => s.band && s.band[0]).map((s) => {
      const [l, h] = s.band; if (!l || !h) return ""; let d = "";
      h.forEach((v, i) => (d += (i ? "L" : "M") + X(i) + "," + Y(v)));
      for (let i = l.length - 1; i >= 0; i--) d += "L" + X(i) + "," + Y(l[i]);
      return `<path d="${d}Z" fill="${s.color}" opacity=".16"/>`;
    }).join("");
    const lines = o.series.map((s) => s.dots
      ? s.values.map((v, i) => (v == null ? "" : `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`)).join("")
      : `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`).join("");
    const ends = o.series.filter((s) => !s.dots && !s.dash).map((s) => { const r = [...s.values].reverse().findIndex((v) => v != null); if (r < 0) return ""; const i = s.values.length - 1 - r; return `<circle cx="${X(i)}" cy="${Y(s.values[i])}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`; }).join("");
    const step = Math.max(1, Math.ceil(n / (o.xcount || 6)));
    const xl = o.x.map((t, i) => (i % step === 0 || i === n - 1 ? `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(t)}</text>` : "")).join("");
    const w = (W - pl - pr) / Math.max(1, n - 1);
    const hits = o.x.map((t, i) => `<rect x="${X(i) - w / 2}" y="0" width="${w}" height="${H}" fill="transparent" data-tip="${esc(t + " · " + o.series.map((s) => `${s.label}: ${s.values[i] == null ? "–" : fmt(s.values[i])}`).join(" · "))}"/>`).join("");
    const legend = o.series.length > 1 || (o.dropped && o.dropped.length) ? `<div class="legend">${o.series.map((s) => `<span><i style="border-top-color:${s.color};border-top-style:${s.dash ? "dashed" : s.dots ? "dotted" : "solid"}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
    return `<figure class="fig">${o.title ? `<figcaption><span>${esc(o.title)}</span>${o.note ? `<span class="muted">${esc(o.note)}</span>` : ""}</figcaption>` : ""}
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || o.title || "")}">${yband}${ticks}${bands}${refs}${ticksX}${lines}${ends}${xl}${hits}</svg>${legend}${o.dropped && o.dropped.length ? `<p class="small muted">No readings yet for ${esc(o.dropped.join(", "))}.</p>` : ""}</figure>`;
  }

  function hbars(rows) {
    const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
    return `<div class="bars">${rows.map((r) => `<div class="bar-row"><span class="bl">${esc(r.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(1.5, (100 * Math.abs(r.value)) / max)}%;background:${r.color}"></span></span><span class="v">${esc(r.text)}</span></div>`).join("")}</div>`;
  }

  // ------------------------------------------------------------------ Today
  // Status first, then the adapter's rank (urgent ER/hospital risk highest first, then newest call concern), then program.
  const sortRows = (items) => items.sort((a, b) => RANK[a.tri] - RANK[b.tri] || (a.prio ?? 200) - (b.prio ?? 200) || ["c5", "c3", "c1", "c4"].indexOf(a.mod) - ["c5", "c3", "c1", "c4"].indexOf(b.mod));
  const sameDay = (iso) => new Date(iso).toDateString() === new Date().toDateString();
  const modOf = (pid) => { const m = String(pid || "").split("-")[0]; return MODS[m] ? m : null; };
  // Status glyph + word (the word is for screen readers and tooltips; the glyph shape carries it on screen).
  const GLYPH = { today: ["●", "Act today"], week: ["▲", "Watch this week"], ok: ["✓", "On track"] };
  const glyph = (k) => `<span class="t-glyph g-${k}" title="${GLYPH[k][1]}" aria-hidden="true">${GLYPH[k][0]}</span><span class="sr-only">${GLYPH[k][1]}.</span>`;
  // The reason's key number in bold; a quoted call line keeps its label ("Medical concern") in bold instead.
  function boldKey(text) {
    const s = esc(text);
    const lab = s.match(/^([^:“"&]{3,40}):(\s*(?:“|&quot;))/);
    if (lab) return `<b>${lab[1]}</b>:${s.slice(lab[1].length + 1)}`;
    return s.replace(/(\d+(?:\.\d+)?(?:\s?(?:%|×|x\b|mg\/dL))?)/, "<b>$1</b>");
  }
  function handoffRow(h) {
    const m = modOf(h.patientId);
    return `<div class="t-row" data-pid="${esc(h.patientId)}"${m ? ` data-mod="${m}"` : ""}>${glyph("ok")}
      <div class="who"><div class="t-line1"><a class="t-name" href="#p-${esc(h.patientId)}">${esc(h.name || h.patientId)}</a>${m ? `<span class="r-mod"><span class="dot m-${m}" aria-hidden="true"></span>${MODS[m].name}</span>` : ""}<span class="tag t-good">✓ ${esc(A.handoffLabel(h))} → ${esc(h.to || "Care team")}</span>${m ? dataChip(m) : ""}</div>
      ${h.flag ? `<p class="why" title="${esc(h.flag)}">“${esc(h.flag)}”</p>` : ""}${h.note ? `<p class="t-meta">Note: ${esc(h.note)}</p>` : ""}${h.at ? `<p class="t-meta">${esc(A.ago(h.at))}${h.coach ? ` · from ${esc(h.coach)}` : ""}</p>` : ""}</div>
      <div class="acts"><a class="btn" href="#p-${esc(h.patientId)}">Open</a></div></div>`;
  }
  // Care-team inbox: every hand-off logged in Patient 360, newest first.
  async function renderInbox() {
    const head = `<header class="page-head"><div><h1>Care-team inbox</h1><p class="sub">Hand-offs from coaches: who raised it, the patient’s words and the note. Newest first.</p></div></header>`;
    const f = forced("the inbox", "When a coach hands someone off from a call or a patient page, it lands here.", "No hand-offs yet");
    if (f) return head + f;
    let ctx;
    try { ctx = await A.context(); } catch (e) { return head + errorBox("the inbox", e.message); }
    const handoffs = ((ctx && ctx.handoffs) || []).filter((h) => h.to !== "Called");
    return head + (handoffs.length ? `<p class="t-count">${handoffs.length} hand-off${handoffs.length === 1 ? "" : "s"}</p><div class="today-list">${handoffs.map(handoffRow).join("")}</div>` : emptyBox("When a coach hands someone off from a call or a patient page, it lands here.", "No hand-offs yet"));
  }
  function failBanners(failed) { return failed.map((x) => `<div class="banner alert"><span class="b-ico" aria-hidden="true">▲</span><div class="b-body"><b>${MODS[x.mod].challenge} ${MODS[x.mod].name} isn’t answering and has no saved copy.</b> <span class="small">${esc(friendly(x.error))}</span></div></div>`).join(""); }
  // Today = one ranked queue across the four programs (GET /api/today), with this session's overlay on top:
  // a safety flag on a call saved here joins the top, a hand-off moves the patient to "Handed off today".
  const COHORTS = `<p class="cohorts"><b>Four programs, four separate cohorts</b> (hospital risk: real MEPS survey data; rough weeks, glucose, coaching calls: synthetic). No patient appears in more than one. The 5 linked demo records join one record from each program to show the full view.</p>`;
  // Language chip only when the patient needs an interpreter.
  const langChip = (l) => (!l || l === "English" ? "" : `<span class="chip-lang need" title="Book an interpreter or a ${esc(l)}-speaking coach">Interpreter · ${esc(l)}</span>`);
  const dataChip = (mod) => (mod === "c1" ? `<span class="chip-data real" title="Real survivor from the MEPS 2017 survey (ID reassigned)">Real · MEPS</span>` : `<span class="chip-data" title="Synthetic hackathon data">Synthetic</span>`);
  const TODAY_SHOW = 5, WEEK_SHOW = 5;
  const isCalled = (h) => h && h.to === "Called";
  const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
  const HORIZON = { today: "Today", week: "This week", year: "Next 12 months" };
  async function renderToday() {
    const day = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const head = `<header class="page-head"><div><p class="eyebrow">${esc(day)}</p><h1>Today</h1></div></header>`;
    const f = forced("today’s list", "Everyone across the four programs is on track. New safety flags from calls appear here first.", "No one needs a call today ✓", "today");
    if (f) return head + f;
    const [q, { rows: roster, failed, handoffs = [] }] = await Promise.all([once("today", A.today).catch(() => null), once("roster", A.roster)]);
    const byId = new Map(roster.map((r) => [r.id, r]));
    let queue = q && Array.isArray(q.rows) ? q.rows.map((x) => ({ ...x })) : sortRows(roster.filter((x) => x.tri === "today")).map((r) => ({ ...r, horizon: "today", reason: r.reason || r.headline }));
    // Fresh safety flags from calls saved here go first.
    const fresh = roster.filter((r) => r.concern && r.concern.fresh && !r.handoff && !queue.some((x) => x.id === r.id)).map((r) => ({ ...r, horizon: "today", reason: r.reason, data: "", language: "" }));
    // Leave the queue: handed off to the care team, or marked called today.
    const calledToday = handoffs.filter((h) => isCalled(h) && sameDay(h.at));
    const calledIds = new Set(calledToday.map((h) => h.patientId));
    const handedOff = (id) => { const h = (byId.get(id) || {}).handoff; return h && !isCalled(h); };
    queue = [...fresh, ...queue].filter((x) => MODS[x.mod] && !handedOff(x.id) && !calledIds.has(x.id));
    // Three horizons. Next-year C1 risk is outreach planning, not today's calls.
    queue.forEach((x) => (x.hz = x.horizon === "today" ? "today" : x.mod === "c1" ? "year" : "week"));
    const now = queue.filter((x) => x.hz === "today"), week = queue.filter((x) => x.hz === "week"), year = queue.filter((x) => x.hz === "year");
    const nameOf = (it) => String(it.name || it.id).split(" · ")[0];
    const meta = (it) => { const r = byId.get(it.id) || {}; return [r.concern && r.concern.fresh ? "Flagged on a call logged here" : "", r.lastSaved && `Last call ${A.ago(r.lastSaved.at)} by ${r.lastSaved.coach}`].filter(Boolean).join(" · "); };
    const primary = (it) => (it.mod !== "c1" ? `<a class="btn primary" href="#live-${esc(it.id)}">Start call</a>` : `<a class="btn primary" href="#p-${esc(it.id)}.c1">Review risk</a>`);
    const markBtn = (it) => `<button type="button" class="btn" data-mark-called data-pid="${esc(it.id)}" data-name="${esc(nameOf(it))}" data-flag="${esc(it.reason || "")}">Mark called</button>`;
    const gk = { today: "today", week: "week", year: "week" };
    // One row = glyph, name, program, (interpreter), data type, horizon, one reason, one primary action.
    const row = (it, i, hz, hideFrom) => { const reason = it.reason || it.headline || "Needs a review"; const nm = nameOf(it);
      const r = byId.get(it.id) || {};
      const expand = hz === "today" && i === 0;
      const quote = expand && r.concern && r.concern.text ? `<blockquote class="t-quote">“${esc(r.concern.text)}”<cite>${esc(r.concern.where ? `Raised on ${r.concern.where}` : "")}${r.concern.by ? ` · coach ${esc(r.concern.by)}` : ""}${/replayed through Clef today/.test(r.headline || "") ? " · replayed through Clef today" : r.concern.at ? ` · ${esc(A.ago(r.concern.at))}` : ""}</cite></blockquote>` : "";
      const why = expand && quote ? `<p class="why"><b>Why today:</b> ${esc(String(reason).split(":")[0])}. ${it.mod === "c5" ? "A safety line from a coaching call needs a person the same day." : ""}</p>` : `<p class="why" title="${esc(it.headline || reason)}">${boldKey(reason)}</p>`;
      return `<div class="t-row${expand ? " t-first" : ""}" data-pid="${esc(it.id)}" data-mod="${it.mod}" data-h="${hz}"${hideFrom != null && i >= hideFrom && !ui["more_" + hz] ? " hidden" : ""}>${glyph(gk[hz])}
      <div class="who"><div class="t-line1"><a class="t-name" href="#p-${esc(it.id)}">${esc(nm)}</a><span class="r-mod"><span class="dot m-${it.mod}" aria-hidden="true"></span>${MODS[it.mod].name}</span>${langChip(it.language)}${dataChip(it.mod)}<span class="t-hz">${HORIZON[hz]}</span></div>
        ${quote}${why}${meta(it) ? `<p class="t-meta">${esc(meta(it))}</p>` : ""}</div>
      <div class="acts">${primary(it)}${hz === "today" ? markBtn(it) : ""}</div></div>`; };
    const moreBtn = (hz, n) => (n > 0 ? `<button type="button" class="t-more" data-more-rows="${hz}" aria-expanded="${!!ui["more_" + hz]}">${ui["more_" + hz] ? "Show fewer" : `Show ${n} more`}</button>` : "");
    const per = (rows) => ALL.map((m) => [m, rows.filter((x) => x.mod === m).length]).filter(([, n]) => n).map(([m, n]) => `<span class="r-mod"><span class="dot m-${m}" aria-hidden="true"></span>${MODS[m].name} ${n}</span>`).join("");
    const hToday = handoffs.filter((h) => !isCalled(h) && sameDay(h.at));
    const n = now.length, shownN = Math.min(TODAY_SHOW, n), first = now[0];
    // Whoop pattern: one number, its status (glyph + word), what it means, what to do. Every count matches a list below.
    const hero = `<section class="hero ${n ? "h-today" : "h-ok"}" aria-labelledby="hero-n">
      <div class="hero-main"><p class="hero-fig" id="hero-n"><span class="hero-n">${n}</span><span class="hero-unit">to call today</span></p>
        <p class="hero-status">${n ? `<span aria-hidden="true">●</span> Act today` : `<span aria-hidden="true">✓</span> On track`}</p>
        <p class="hero-means">${n ? `People with a safety line from a call, an urgent 7-day ER risk, a survey red flag, or frequent lows or very high glucose.` : `No safety lines from calls, no urgent 7-day ER risk and no glucose alarms left today.`}</p>
        <p class="hero-do">${n ? `<b>What to do:</b> call from the top, starting with ${esc(nameOf(first))}. Mark each one called; hand off anything medical.` : calledToday.length ? `<b>Done:</b> ${calledToday.length} called today. Work through This week next.` : `<b>What to do:</b> work through This week below.`}</p></div>
      <dl class="hero-side">
        <a href="#today-done"><dt>Called today</dt><dd>${calledToday.length}</dd></a>
        <a href="#today-week"><dt>This week</dt><dd>${week.length}</dd></a>
        <a href="#today-year"><dt>Planning, 12 months</dt><dd>${year.length}</dd></a>
        <a href="#inbox"><dt>Handed off today</dt><dd>${hToday.length}</dd></a>
      </dl></section>`;
    const scales = `<p class="t-note"><span aria-hidden="true">ⓘ</span> Programs use different risk scales; rows are ordered by urgency rule, not by a common score.</p>`;
    const done = calledToday.length ? `<section class="t-sec t-done" id="today-done"><div class="t-sec-head"><h2>Done today · ${calledToday.length}</h2></div><ul class="done-log">${calledToday.map((h) => `<li><span class="g-ok" aria-hidden="true">✓</span><a href="#p-${esc(h.patientId)}">${esc(h.name || h.patientId)}</a><span class="muted">called ${esc(hhmm(h.at))}${h.coach ? ` by ${esc(h.coach)}` : ""}</span></li>`).join("")}</ul></section>` : "";
    const handed = hToday.length ? `<details class="more"><summary>Handed off to the care team today (${hToday.length})</summary><div class="today-list">${hToday.map(handoffRow).join("")}</div><p class="small" style="margin-top:8px"><a href="#inbox">Care-team inbox, every hand-off →</a></p></details>` : "";
    return `${head}${failBanners(failed)}${sourceBanner(ALL)}${hero}
      <section class="t-sec" id="today-now"><div class="t-sec-head"><h2>Call today${n ? ` · ${shownN === n ? n : `${shownN} of ${n}`}` : ""}</h2><p class="t-per">${per(now)}</p></div>
        ${n > shownN ? `<p class="t-sub">${shownN} of ${n} to call today · showing the most urgent first.</p>` : ""}
        ${n ? `<div class="today-list roster-today" data-count="${n}">${now.map((it, i) => row(it, i, "today", TODAY_SHOW)).join("")}${moreBtn("today", n - TODAY_SHOW)}</div>` : emptyBox(calledToday.length ? `All ${calledToday.length} called. New safety flags from calls appear here first.` : "Everyone across the four programs is on track. New safety flags from calls appear here first.", "No one needs a call today ✓", "ok")}
        ${scales}</section>
      ${done}
      ${week.length ? `<section class="t-sec" id="today-week"><div class="t-sec-head"><h2>This week · ${week.length}</h2><p class="t-per">${per(week)}</p></div><p class="t-sub">Rough weeks ahead and glucose off target. Call before the weekend.</p>
        <div class="today-list">${week.map((it, i) => row(it, i, "week", WEEK_SHOW)).join("")}${moreBtn("week", week.length - WEEK_SHOW)}</div></section>` : ""}
      ${year.length ? `<details class="more t-plan" id="today-year"${ui.planOpen ? " open" : ""}><summary>Planning (next 12 months) · ${year.length}<span class="t-sub"> Highest next-year ER or hospital risk from the survey model. Plan outreach; not a same-day call.</span></summary>
        <div class="today-list">${year.map((it, i) => row(it, i, "year")).join("")}</div></details>` : ""}${handed}${COHORTS}`;
  }
  // "Mark called": saved through the hand-off API (to: "Called"); the row collapses and joins Done today.
  async function markCalled(btn) {
    const rowEl = btn.closest(".t-row");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const h = await post("/api/handoffs", { patientId: btn.dataset.pid, name: btn.dataset.name, coach: P360.coach(), to: "Called", flag: btn.dataset.flag || "", note: "Called from Today." });
      A.remember.handoff(h); memo.delete("roster"); memo.delete("p:" + btn.dataset.pid);
      if (rowEl) { rowEl.style.height = rowEl.offsetHeight + "px"; rowEl.classList.add("leaving"); requestAnimationFrame(() => (rowEl.style.height = "0px")); }
      showToast(`${btn.dataset.name} marked called.`);
      setTimeout(() => render(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    } catch (err) { btn.disabled = false; btn.textContent = "Mark called"; showToast(`Not saved. ${friendly(err.message)}`); }
  }

  // ------------------------------------------------------------------ Patients
  async function renderPatients(arg) {
    const st = arg === "alert" ? "watch" : ["today", "watch", "ok"].includes(arg) ? arg : "all";
    const inSt = (x, k) => (k === "watch" ? x.tri === "watch" || x.tri === "alert" : x.tri === k);
    const head = `<header class="page-head"><div><h1>Patients</h1><p class="sub">Everyone across the four programs, who needs a person first.</p></div></header>`;
    const f = forced("patients", "Patients appear here once a program sends its first list.", "No patients yet");
    if (f) return head + f;
    const { rows: items, failed } = await once("roster", A.roster);
    sortRows(items);
    const q = ui.q.trim().toLowerCase();
    const shown = items.filter((x) => (ui.filter === "all" || x.mod === ui.filter) && (st === "all" || inSt(x, st)) && (!q || (x.name + " " + x.headline + " " + x.id + " " + x.tags.map((t) => t.label).join(" ")).toLowerCase().includes(q)));
    const modPills = `<button type="button" class="fpill" aria-pressed="${ui.filter === "all"}" data-filter="all">All <span class="cnt">${items.length}</span></button>` + ALL.map((m) => `<button type="button" class="fpill" aria-pressed="${ui.filter === m}" data-filter="${m}"><span class="dot m-${m}" aria-hidden="true"></span>${MODS[m].name} <span class="cnt">${items.filter((x) => x.mod === m).length}</span></button>`).join("");
    const stOpts = ["all", "today", "watch", "ok"].map((k) => `<option value="${k}"${st === k ? " selected" : ""}>${k === "all" ? "Any status" : GROUP[k]} (${k === "all" ? items.length : items.filter((x) => inSt(x, k)).length})</option>`).join("");
    const body = shown.slice(0, ui.limit).map((it) => `<tr data-pid="${esc(it.id)}"><td class="st">${statusPill(it.tri)}</td><td class="nm"><a href="#p-${esc(it.id)}">${esc(it.name || it.id)}</a><div class="pid mono">${esc(it.id)}</div></td>
      <td class="pg"><span class="r-mod"><span class="dot m-${it.mod}" aria-hidden="true"></span>${MODS[it.mod].name}</span></td><td class="hl">${esc(it.headline || "Not recorded")}</td><td class="dt">${it.updatedAt ? esc(fmtDate(it.updatedAt)) : "Not recorded"}</td></tr>`).join("");
    const more = shown.length > ui.limit ? `<button type="button" class="r-more" data-more>Show ${Math.min(60, shown.length - ui.limit)} more of ${shown.length - ui.limit}</button>` : "";
    return `${head}${failBanners(failed)}${sourceBanner(ALL)}
      <div class="toolbar"><label class="search"><span class="sr-only">Search patients</span><input id="search" type="search" placeholder="Search name, ID, signal" value="${esc(ui.q)}" autocomplete="off"></label>
        <div class="filters" role="group" aria-label="Filter by program">${modPills}</div>
        <label class="st-filter"><span class="sr-only">Filter by status</span><select id="st-filter">${stOpts}</select></label></div>
      ${linkedRow(items)}
      <p class="t-count" aria-live="polite">${shown.length} of ${items.length} patients</p>
      <div class="ptable-wrap roster" data-count="${items.length}"><table class="ptable pt-patients"><thead><tr><th>Status</th><th>Patient</th><th>Program</th><th>Why</th><th>Last data</th></tr></thead><tbody>${body || `<tr><td colspan="5" class="live-empty">No patient matches “${esc(ui.q)}”. Try a name, an ID such as P03000, or clear the filters.</td></tr>`}</tbody></table>${more}</div>
      ${COHORTS}<p class="footnote">Dates are the last data each program holds.</p>`;
  }

  // ------------------------------------------------------------------ Patient 360
  /* Patient page (Whoop pattern): header = name, one identity line, status pill, actions; other facts under "Profile".
     Health chart = one hero card (number, status word + glyph, what it means, what to do, sparkline, source), then
     Ellie's AI Insight, up to 3 KPI tiles, then Do next. Program tabs open with the same hero; depth sits in expanders.
     Linked demo records (x-L1..x-L5) join one record from each program; every tab renders that program's member. */
  const PILLS = [["overview", "Health chart"], ["c1", "Hospital risk"], ["c3", "Rough weeks"], ["c4", "Glucose"], ["c5", "Coaching calls"]];
  const NR = "Not recorded";
  const LINK_NOTE = `<p class="cohorts linked-note"><b>Linked demo record:</b> four programs’ separate cohorts, joined here by matching sex, cancer type and age (within about 10 years) to show the full view. Not one real person.</p>`;
  const getP = (pid) => once("p:" + pid, () => A.patient(pid, getP));
  const TONE_GLYPH = { red: "●", amber: "▲", green: "✓", neutral: "–" };

  // Tiny inline sparkline: a line over the last points, an optional band (usual or target range) and a dashed reference line.
  function spark(o) {
    if (!o || !Array.isArray(o.values)) return "";
    const v = o.values, pts = v.map((y, i) => [i, y]).filter(([, y]) => typeof y === "number" && isFinite(y));
    if (pts.length < 2) return "";
    const W = 160, H = 40, P = 4, all = pts.map((x) => x[1]);
    if (o.band) all.push(...o.band); if (o.ref) all.push(o.ref.y);
    let lo = Math.min(...all), hi = Math.max(...all); if (hi === lo) { hi += 1; lo -= 1; }
    const X = (i) => P + (i * (W - 2 * P)) / Math.max(1, v.length - 1), Y = (y) => H - P - ((y - lo) / (hi - lo)) * (H - 2 * P);
    let d = "", pen = false; v.forEach((y, i) => { if (typeof y !== "number" || !isFinite(y)) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(y).toFixed(1); pen = true; });
    const [li, ly] = pts[pts.length - 1];
    const f = (y) => (o.pct ? pct(y) : num(y, o.d ?? 0));
    const band = o.band ? `<rect class="sp-band" x="${P}" width="${W - 2 * P}" y="${Y(o.band[1]).toFixed(1)}" height="${Math.max(1, Y(o.band[0]) - Y(o.band[1])).toFixed(1)}"/>` : "";
    const ref = o.ref ? `<line class="sp-ref" x1="${P}" x2="${W - P}" y1="${Y(o.ref.y).toFixed(1)}" y2="${Y(o.ref.y).toFixed(1)}"/>` : "";
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${o.note || "Trend"}. Latest ${f(ly)}${o.ref ? `, line at ${f(o.ref.y)}` : ""}.`)}">${band}${ref}<path class="sp-line" d="${d}"/><circle class="sp-end" cx="${X(li).toFixed(1)}" cy="${Y(ly).toFixed(1)}" r="3"/></svg>`;
  }
  const stBadge = (st) => `<span class="hero-st tone-${esc(st.tone)}"><span class="g" aria-hidden="true">${esc(st.glyph)}</span>${esc(st.word)}</span>`;
  function tirBar(segs) {
    return `<div class="tir"><div class="tir-bar" role="img" aria-label="${esc(segs.map((s) => `${s.label} mg/dL ${num(s.v, 1)}%`).join(", "))}">${segs.map((s) => `<span class="tir-seg tone-${s.tone}${/Below/.test(s.label) ? " low" : ""}" style="width:${Math.max(s.v > 0 ? 0.8 : 0, s.v)}%"></span>`).join("")}</div>
      <ul class="tir-key">${segs.map((s) => `<li><span class="sw tone-${s.tone}${/Below/.test(s.label) ? " low" : ""}" aria-hidden="true"></span>${esc(s.label)} <b>${s.v === 0 ? "0" : num(s.v, s.v < 10 ? 1 : 0)}%</b></li>`).join("")}<li class="tir-t">Target: 70–180 over 70%, lows under 4%</li></ul></div>`;
  }
  // The hero card: one number with its status word, its comparison, what it means, what to do and where it comes from.
  function heroCard(h, mod, noTop) {
    if (!h) return "";
    const top = h.top && !noTop ? `<p class="hero-top tone-${esc(h.top.tone)}" role="${h.top.tone === "red" ? "alert" : "status"}"><span class="g" aria-hidden="true">${TONE_GLYPH[h.top.tone] || "▲"}</span><span>${esc(h.top.text)}</span></p>` : "";
    const sp = h.spark ? spark(h.spark) : "";
    return `<section class="hero-card tone-${esc(h.st.tone)}" aria-label="${esc(h.label)}">${top}
      <div class="hero-grid"><div class="hero-fig"><p class="eyebrow">${mod ? `<span class="dot m-${mod}"></span>${esc(MODS[mod].challenge)} ${esc(MODS[mod].name)} · ` : ""}${esc(h.label)}</p>
        <p class="hero-num"><span class="hv">${esc(h.value || NR)}</span>${h.unit ? `<span class="hu">${esc(h.unit)}</span>` : ""}</p>${stBadge(h.st)}${h.why && noTop !== true ? `<p class="hero-why">${esc(h.why)}</p>` : ""}${h.compare ? `<p class="hero-cmp">${esc(h.compare)}</p>` : ""}</div>
        ${sp ? `<figure class="hero-spark">${sp}<figcaption>${esc(h.spark.note || "")}</figcaption></figure>` : ""}</div>
      ${h.bar && h.bar.length ? tirBar(h.bar) : ""}
      <dl class="hero-wm"><div><dt>What it means</dt><dd>${esc(h.means || NR)}${h.caveat ? `<span class="hero-cav">${esc(h.caveat)}</span>` : ""}</dd></div><div><dt>What to do</dt><dd>${esc(h.todo || "No action from this program right now.")}</dd></div></dl>
      <p class="hero-src"><span>Source</span>${esc(h.source || "")}</p></section>`;
  }
  // One line on how well the program works for people like this patient. Never blank.
  const fitLine = (p) => (p.fit ? `<p class="fit tone-${esc(p.fit.tone)}"><span class="g" aria-hidden="true">${TONE_GLYPH[p.fit.tone] || "–"}</span><span><b>For people like this patient:</b> ${esc(p.fit.text)}</span></p>` : "");
  const identityLine = (idn) => [idn && idn.age && `${idn.age} years`, idn && idn.sex, idn && idn.cancer, idn && idn.language].filter(Boolean).join(" · ");
  function profileBox(p) {
    const keys = A.IDENTITY_KEYS || [];
    const rest = (p.facts || []).filter(([k]) => !keys.includes(k));
    return rest.length ? `<details class="profile"><summary>Profile · ${rest.length} more fact${rest.length === 1 ? "" : "s"}</summary><dl>${rest.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v == null || v === "" ? NR : v)}</dd></div>`).join("")}</dl></details>` : "";
  }

  async function renderPatient360(arg) {
    const [id, tab = "overview"] = arg.split(".");
    const back = `<a class="back" href="#patients">← Patients</a>`;
    const f = forced("this patient", "No data for this patient yet. The page fills in after the first synced day.");
    if (f) return back + f;
    if (/^x-/.test(id)) return renderLinked(id, tab, back);
    let p;
    try { p = await getP(id); } catch (e) { return back + errorBox("this patient", e.message); }
    current = p;
    const pills = PILLS.map(([k, label]) => {
      const mine = k === "overview" || k === p.mod;
      const cls = `pill${k === tab ? " on" : ""}${mine ? "" : " off"}`;
      const dot = k !== "overview" ? `<span class="dot m-${k}"></span>` : "";
      return `<a class="${cls}" href="#p-${esc(id)}${k === "overview" ? "" : "." + k}" ${k === tab ? 'aria-current="page"' : ""} ${mine ? "" : 'title="Not enrolled in this program’s data"'}>${dot}${label}</a>`;
    }).join("");
    const head = `${back}${headHtml(p, id, id)}<nav class="pills" aria-label="Patient views">${pills}</nav>${sourceBanner([p.mod])}`;
    const body = tab === "overview" ? overview(p) : tab === p.mod ? moduleView(p) : notEnrolled(tab);
    return head + body + techDetails(p);
  }
  const techDetails = (p) => (p && p.missing && p.missing.length ? `<details class="more tech"><summary>Technical details</summary><p class="footnote">Fields this program does not send yet: ${esc(p.missing.join("; "))}.</p></details>` : "");
  function actionsHtml(p, callId) {
    return `${p.handoff ? `<span class="tag t-good" title="${esc(p.handoff.note || "")}">✓ ${esc(p.handoff.label)}</span>` : p.tri === "today" ? `<button class="btn danger" data-handoff data-pid="${esc(callId)}" data-name="${esc(p.name)}" data-flag="${esc(p.concern ? p.concern.text : p.headline)}">Escalate to care team</button>` : ""}<a class="btn primary" href="#live-${esc(callId)}">Start call</a>`;
  }
  function headHtml(p, id, callId) {
    const idn = identityLine(p.identity);
    return `<header class="p-head pp-head"><div class="pp-id"><h1>${esc(p.name)}</h1>${idn ? `<p class="pp-ident">${esc(idn)}</p>` : ""}
      <div class="row pp-st"><span data-lk-status>${statusPill(p.tri)}</span>${p.lastSaved ? `<span class="small muted">Last call logged ${esc(A.ago(p.lastSaved.at))} by ${esc(p.lastSaved.coach)}${p.lastSaved.flags && p.lastSaved.flags.length ? ` · ${p.lastSaved.flags.length} line${p.lastSaved.flags.length === 1 ? "" : "s"} flagged` : ""} · <a href="#live-${esc(callId)}">recap</a></span>` : ""}</div></div>
      <div class="row pp-acts" data-lk-acts>${actionsHtml(p, callId)}</div></header>${profileBox(p)}`;
  }

  // ---- linked demo records: the header and the chosen tab render as soon as their own data is in; the rest fills in.
  function whenMounted(sel, fn, tries = 40) {
    const el = document.querySelector(sel);
    if (el) return fn(el);
    if (tries > 0) setTimeout(() => whenMounted(sel, fn, tries - 1), 50);
  }
  async function renderLinked(id, tab, back) {
    const L = (A.linked ? A.linked() : []).find((x) => x.id === id);
    if (!L) return back + errorBox("this linked record", "There is no linked demo record with this ID.");
    const seq = renderSeq; // the render() call that will paint this page (render() bumps it before calling us)
    const [age, sexCancer] = [L.who.match(/^\d+/)[0], L.who.replace(/^\d+/, "")];
    const stub = { id, name: L.name, tri: "", identity: { age, sex: /^M/.test(sexCancer) ? "Male" : "Female", cancer: sexCancer.split(" · ")[1].replace(/^./, (c) => c.toUpperCase()) + " cancer" }, facts: [] };
    const full = getP(id);
    const pills = PILLS.map(([k, label]) => `<a class="pill${k === tab ? " on" : ""}" href="#p-${esc(id)}${k === "overview" ? "" : "." + k}" ${k === tab ? 'aria-current="page"' : ""}>${k !== "overview" ? `<span class="dot m-${k}"></span>` : ""}${label}</a>`).join("");
    const headStub = `<header class="p-head pp-head"><div class="pp-id"><h1>${esc(L.name)}</h1><p class="pp-ident">${esc(identityLine(stub.identity))}</p><div class="row pp-st"><span data-lk-status><span class="sk" style="display:inline-block;width:90px;height:22px"></span></span></div></div><div class="row pp-acts" data-lk-acts><a class="btn primary" href="#live-${esc(L.c5)}">Start call</a></div></header><div data-lk-profile></div>`;
    // Header status, actions and profile fill in when all four programs have answered.
    full.then((p) => setTimeout(() => {
      if (seq !== renderSeq) return;
      whenMounted("[data-lk-status]", (el) => { el.innerHTML = statusPill(p.tri); });
      whenMounted("[data-lk-acts]", (el) => { el.innerHTML = actionsHtml(p, p.callId); });
      whenMounted("[data-lk-profile]", (el) => { el.outerHTML = profileBox(p); });
      const sb = sourceBanner(ALL.filter((m) => p.members[m] && !p.members[m].error)); if (sb) whenMounted("[data-lk-src]", (el) => { el.innerHTML = sb; });
    }, 0)).catch((e) => setTimeout(() => whenMounted("[data-lk-status]", (el) => { el.innerHTML = `<span class="small muted">${esc(e.message)}</span>`; }), 0));
    const head = `${back}${headStub}${LINK_NOTE}<nav class="pills" aria-label="Patient views">${pills}</nav><div data-lk-src></div>`;
    if (tab === "overview") {
      full.then((p) => { if (seq === renderSeq) current = p; }).catch(() => {});
      ALL.forEach((m) => getP(L.members[m]).then((v) => v, (e) => ({ id: L.members[m], mod: m, error: e.message })).then((v) => setTimeout(() => { if (seq === renderSeq) whenMounted(`[data-lk-tile="${m}"]`, (el) => { el.outerHTML = linkedTile(id, m, v); }); }, 0)));
      full.then((p) => setTimeout(() => { if (seq === renderSeq) whenMounted("[data-lk-rest]", (el) => { el.outerHTML = linkedRest(p); }); }, 0)).catch((e) => setTimeout(() => whenMounted("[data-lk-rest]", (el) => { el.outerHTML = errorBox("this linked record", e.message); }), 0));
      const tiles = ALL.map((m) => `<div class="l-tile is-loading" data-lk-tile="${m}" aria-busy="true"><p class="eyebrow"><span class="dot m-${m}"></span>${esc(MODS[m].challenge)} ${esc(MODS[m].name)}</p><div class="sk" style="height:40px;width:60%"></div><div class="sk" style="height:14px;width:80%"></div></div>`).join("");
      return `${head}<section class="stack-s"><h2 class="sec-t">Health chart · one number per program</h2><div class="l-tiles">${tiles}</div></section><div data-lk-rest>${loadingBox("the rest of the chart")}</div>`;
    }
    let mem;
    try { mem = await getP(L.members[tab]); } catch (e) { return `${head}${errorBox(MODS[tab].name + " for this record", e.message)}`; }
    current = mem;
    return `${head}${sourceBanner([tab])}${moduleView(mem, { lang: "English" })}${techDetails(mem)}`;
  }
  function linkedTile(id, m, v) {
    const href = `#p-${id}.${m}`;
    if (!v || v.error) return `<a class="l-tile tone-neutral" href="${esc(href)}"><p class="eyebrow"><span class="dot m-${m}"></span>${esc(MODS[m].challenge)} ${esc(MODS[m].name)}</p><p class="lt-label">Couldn’t load this program</p><p class="lt-means">${esc((v && v.error) || "No answer")}</p><span class="lt-open">Try the tab →</span></a>`;
    const h = v.hero || {};
    const label = h.tileLabel || { c1: "12-month ER or hospital risk", c3: "7-day rough-week risk", c4: "Time in range (70–180 mg/dL)", c5: "Last call score" }[m];
    return `<a class="l-tile tone-${esc(h.st ? h.st.tone : "neutral")}" href="${esc(href)}"><p class="eyebrow"><span class="dot m-${m}"></span>${esc(MODS[m].challenge)} ${esc(MODS[m].name)}</p><p class="lt-label">${esc(label)}</p>
      <p class="hero-num sm"><span class="hv">${esc(h.value || NR)}</span>${h.unit ? `<span class="hu">${esc(h.unit)}</span>` : ""}</p>${h.st ? stBadge(h.st) : ""}${h.compare ? `<p class="lt-cmp">${esc(h.compare.split(" · ")[0])}</p>` : ""}
      ${h.top ? `<p class="lt-top tone-${esc(h.top.tone)}"><span class="g" aria-hidden="true">${TONE_GLYPH[h.top.tone] || "▲"}</span>${esc(h.top.text)}</p>` : `<p class="lt-means">${esc(h.means || "")}</p>`}<span class="lt-open">Open →</span></a>`;
  }
  // Below the tiles: Ellie's insight across all four programs, then one next step per program, worst first.
  function linkedRest(p) {
    const RANKT = { today: 0, alert: 1, watch: 2, ok: 3 };
    const ok = ALL.map((m) => p.members[m]).filter((v) => v && !v.error).sort((a, b) => RANKT[a.tri] - RANKT[b.tri]);
    const steps = ok.map((v) => [v, v.panels.flatMap((pn) => (pn.id === "redflags" ? [] : pn.advice || []))[0]]).filter(([, a]) => a).slice(0, 3);
    return `<div class="ellie-insight" data-pid="${esc(p.id)}"></div>
      ${steps.length ? `<section class="stack-s"><h2 class="sec-t">Do next</h2><div class="next-acts">${steps.map(([v, a], i) => `<section class="card"><p class="eyebrow"><span class="dot m-${v.mod}"></span>${esc(MODS[v.mod].name)}</p>${adviceCard(a, i + 1)}<a class="small" href="#p-${esc(p.id)}.${v.mod}">See the chart behind it →</a></section>`).join("")}</div></section>` : ""}
      <p class="footnote">${esc(p.footnote)}</p>`;
  }

  // KPI tiles: label, number, its comparison line, and a sparkline where the program sends a series.
  function kpiCards(kpis, href, compact) {
    const tag = href ? "a" : "div";
    return kpis.length ? `<div class="kpis${compact ? " compact" : ""}">${kpis.map((k) => `<${tag} class="kpi ${k.good == null ? "" : k.good ? "k-ok" : "k-bad"}" ${href ? `href="${esc(href)}"` : ""}><div class="kl">${esc(k.label)}</div><div class="kv">${esc(k.value == null || k.value === "" || /undefined|NaN|null/.test(String(k.value)) ? NR : k.value)}</div>${k.sub || href ? `<div class="ks">${esc(k.sub || "")}</div>` : ""}${k.spark ? `<div class="k-spark">${spark(k.spark)}</div>` : ""}</${tag}>`).join("")}</div>` : "";
  }
  // The last layer of every program view: every field the program sent, so the summary never hides data.
  function flatten(o, path = "", out = []) {
    if (o == null || typeof o !== "object") { out.push([path, o]); return out; }
    if (Array.isArray(o) && o.every((v) => v == null || typeof v !== "object")) { out.push([path, o.map((v) => (v == null ? "–" : v)).join(", ")]); return out; }
    for (const [k, v] of Object.entries(o)) flatten(v, path ? (Array.isArray(o) ? `${path}[${k}]` : `${path}.${k}`) : k, out);
    return out;
  }
  function rawData(p) {
    if (!p.raw) return "";
    const rows = flatten(p.raw);
    return `<details class="more raw" id="raw"><summary>Everything this program sent · ${rows.length} fields</summary><p class="small muted">The full response from ${esc(MODS[p.mod].challenge)} ${esc(MODS[p.mod].name)}${p.source === "fallback" ? " (saved copy)" : ""}, unedited.</p><div class="tbl-wrap"><table class="kv-tbl"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v === "" ? "“”" : v)}</td></tr>`).join("")}</tbody></table></div></details>`;
  }
  function adviceCard(a, n) {
    return `<div class="a-text"><p class="basis t-${esc(a.tone || "info")}">${n ? n + " · " : ""}${esc(a.tag || "")}</p><h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ""}
      ${a.caution ? `<p class="a-caution" role="note"><span class="g" aria-hidden="true">▲</span><span><b>Caution:</b> ${esc(a.caution)}</span></p>` : ""}
      ${a.more ? `<details class="a-more"><summary>Why</summary><p>${esc(a.more)}</p></details>` : ""}
      ${a.evidence && a.evidence.some((e) => e.value != null) ? `<p class="ev-chips">${a.evidence.filter((e) => e.value != null).map((e) => `<span class="echip" title="${esc(e.method || "")}">${esc(e.label)}: <b>${e.value == null ? "–" : num(e.value, 1)}${e.unit === "%" ? "%" : " " + esc(e.unit || "")}</b></span>`).join("")}</p>` : ""}</div>`;
  }
  function panelVisual(pn) {
    let h = "";
    if (pn.lead) h += `<p class="muted small">${esc(pn.lead)}</p>`;
    h += (pn.charts || []).filter(Boolean).map((c) => chart(c)).join("");
    for (const b of [pn.bars, pn.bars2]) if (b) h += `<div class="stack-s"><p class="fig-t">${esc(b.title)}</p><p class="muted small">${esc(b.note)}</p>${hbars(b.rows)}</div>`;
    if (pn.table) h += `<div class="tbl-wrap"><table class="tbl"><thead><tr>${pn.table.head.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${pn.table.rows.map((r) => `<tr>${r.map((x, i) => `<td class="${i ? "mono" : ""}">${esc(x == null ? NR : x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    if (pn.list) h += `<ul class="evidence">${pn.list.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    if (pn.calls) h += `<div class="calls-list">${pn.calls.map((c) => callRow(c, false)).join("")}</div>`;
    return h;
  }
  // Numbered "what to do" cards, advice left and its chart right; panels without advice fold into "More detail".
  // The red-flag panel is never here: it always renders first, on its own (redFlagsCard).
  function doCards(p, limit) {
    let n = 0;
    const withAdvice = p.panels.filter((pn) => pn.id !== "redflags" && pn.advice && pn.advice.length);
    return withAdvice.slice(0, limit || 99).map((pn) => `<section class="card do ${pn.small ? "small" : ""}" id="pn-${esc(pn.id)}"><div class="do-text">${pn.advice.map((a) => adviceCard(a, ++n)).join("")}</div><div class="do-visual">${panelVisual(pn)}</div></section>`).join("");
  }
  // C1 red flags: the symptoms that mean "call today" whatever the tier, then the survey follow-ups. Always first.
  function redFlagsCard(p) {
    const pn = p.panels.find((x) => x.id === "redflags");
    if (!pn) return "";
    const today = p.raw && p.raw.redFlags && p.raw.redFlags.careTeamToday;
    return `<section class="card rf-card${today ? " is-today" : ""}" id="pn-redflags"><div class="rf-head"><span class="g" aria-hidden="true">${today ? "●" : "▲"}</span><h2>${esc(pn.title)}</h2></div>
      ${pn.lead ? `<p class="muted small">${esc(pn.lead)}</p>` : ""}${pn.list && pn.list.length ? `<ul class="rf-list">${pn.list.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${pn.advice && pn.advice.length ? `<div class="rf-adv">${pn.advice.map((a) => `<p><span class="tag ${a.tag === "Today" ? "t-risk" : "t-info"}">${esc(a.tag)}</span> ${esc(a.title)}</p>`).join("")}</div>` : ""}</section>`;
  }
  // C4 safety: care-team-today banner and the low-sugar card (glyph + words, translation when the patient reads it).
  function c4Safety(p, lang) {
    let h = "";
    if (p.careFlag) h += `<div class="banner alert c4-flag" role="alert"><span class="b-ico">●</span><div class="b-body"><b>Send to the care team today.</b> ${esc(p.careFlag.reasons.join("; "))}.${p.careFlag.rule ? `<span class="small" style="display:block">${esc(p.careFlag.rule)}</span>` : ""}</div></div>`;
    if (p.hypo) {
      const code = /span/i.test(lang || "") ? "es" : /creole|kreyòl|kreyol|haitian/i.test(lang || "") ? "ht" : "";
      h += `<section class="hypo-card" role="alert"><p class="hypo-t"><span class="g" aria-hidden="true">▲</span>Low blood sugar risk: frequent readings below 70 mg/dL</p><p>${esc(p.hypo.text)}</p>${code && p.hypo.tr[code] ? `<p class="hypo-tr" lang="${code}"><b>${code === "es" ? "Español" : "Kreyòl"}:</b> ${esc(p.hypo.tr[code])}</p>` : ""}</section>`;
    }
    return h;
  }
  // Call script for the coach: EN / Español / Kreyòl (CSS radio group, no script), defaulting to the survivor's language.
  function handout(p, lang) {
    const ho = p.handout;
    if (!ho || !ho.langs.length) return "";
    const want = /span/i.test(lang || "") ? "es" : /creole|kreyòl|kreyol|haitian/i.test(lang || "") ? "ht" : "en";
    const def = ho.langs.some((l) => l.lang === want) ? want : ho.langs[0].lang, nm = "pv-" + p.id.replace(/[^a-z0-9]/gi, "");
    const short = { en: "English (source)", es: "Español", ht: "Kreyòl" };
    return `<section class="card handout"><div class="ho-head"><h2>Call script · Spanish / Kreyòl</h2><p class="small muted">For the coach to read on the call, in the survivor's language. Machine-translated: review before use.</p></div>
      <div class="pv">${ho.langs.map((l) => `<input type="radio" class="pv-in l-${l.lang}" name="${nm}" id="${nm}-${l.lang}" ${l.lang === def ? "checked" : ""}><label for="${nm}-${l.lang}">${short[l.lang]}</label>`).join("")}
        <div class="pv-panels">${ho.langs.map((l) => `<div class="pv-p pv-${l.lang}" lang="${l.lang}">${l.careTeam ? `<p><b>${esc(l.careTeam)}</b></p>` : ""}${l.lowSugarWarning ? `<p class="hypo-tr"><span class="g" aria-hidden="true">▲</span> ${esc(l.lowSugarWarning)}</p>` : ""}${(l.actions || []).length ? `<ol>${l.actions.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ol>` : ""}${l.help ? `<p class="small muted">${esc(l.help)}</p>` : ""}</div>`).join("")}</div></div>
      ${ho.note ? `<p class="small muted">${esc(ho.note)}</p>` : ""}</section>`;
  }
  // C3 health-monitor rows: each signal against the patient's own usual range (band), this week's average (dot), and the change in words.
  function signalRows(sigs) {
    if (!sigs || !sigs.length) return "";
    const row = (s) => {
      if (s.missing) return `<div class="sig"><div class="sig-n"><b>${esc(s.title)}</b><span class="small muted">${NR}</span></div></div>`;
      const lo = Math.min(s.lo, s.now), hi = Math.max(s.hi, s.now), pad = (hi - lo) * 0.25 || 1, a = lo - pad, b = hi + pad, P = (v) => ((v - a) / (b - a)) * 100;
      const u = s.unit === "a day" ? "steps a day" : s.unit;
      return `<div class="sig tone-${esc(s.st.tone)}"><div class="sig-n"><b>${esc(s.title)}</b><span class="small muted">usual ${num(s.lo, s.dp)}–${num(s.hi, s.dp)} ${esc(u)}</span></div>
        <div class="sig-track" role="img" aria-label="${esc(`${s.title}: this week ${num(s.now, s.dp)} ${u}, usual range ${num(s.lo, s.dp)} to ${num(s.hi, s.dp)}`)}"><span class="sig-band" style="left:${P(s.lo).toFixed(1)}%;width:${Math.max(1, P(s.hi) - P(s.lo)).toFixed(1)}%"></span><span class="sig-dot" style="left:${P(s.now).toFixed(1)}%"></span></div>
        <div class="sig-v"><b>${esc(s.text)}</b>${stBadge(s.st)}</div><div class="sig-sp">${spark({ values: s.values, band: [s.lo, s.hi], d: s.dp, note: `${s.title}, last 14 days, band = usual range` })}</div></div>`;
    };
    return `<section class="card sigs"><div class="sec-head"><h2>Signals against their own usual</h2><p class="small muted">Band = their usual range (middle 80% of days in the 5 weeks before). Dot = this week’s average. ▲ marks a signal that moves this week’s forecast.</p></div>${sigs.map(row).join("")}</section>`;
  }

  /* Health chart = the summary: hero card, Ellie's insight, at most 3 KPI tiles, the top two actions.
     Charts, detail panels, evidence and the raw response live on the program pill (moduleView). */
  function overview(p) {
    const href = `#p-${p.id}.${p.mod}`;
    const allAdvice = p.panels.flatMap((pn) => (pn.id === "redflags" ? [] : pn.advice || []));
    const top = allAdvice.slice(0, 2);
    const acts = top.length ? `<section class="stack-s"><h2 class="sec-t">Do next</h2><div class="next-acts">${top.map((a, i) => `<section class="card">${adviceCard(a, i + 1)}</section>`).join("")}</div>
      <a href="${esc(href)}">${allAdvice.length > 2 ? `All ${allAdvice.length} next steps, each with the chart behind it →` : `See the chart behind ${top.length > 1 ? "each" : "it"} →`}</a></section>` : `<p class="muted">No actions from this program right now.</p>`;
    const kp = (p.kpis || []).filter((k) => !k.hero).slice(0, 3);
    return `${p.mod === "c4" ? c4Safety(p, p.identity && p.identity.language) : ""}${heroCard(p.hero, p.mod, p.mod === "c4" && !!p.careFlag)}
      <div class="ellie-insight" data-pid="${esc(p.id)}"></div>
      ${kp.length ? `<section class="stack-s"><p class="eyebrow">More numbers · ${esc(MODS[p.mod].challenge)} ${esc(MODS[p.mod].name)}</p>${kpiCards(kp, href, true)}</section>` : ""}
      ${acts}<p class="small"><a href="${esc(href)}">Full ${esc(MODS[p.mod].name)} detail: charts, evidence and every field the program sent →</a></p>`;
  }
  function moduleView(p, o = {}) {
    const lang = o.lang || (p.identity && p.identity.language);
    const more = p.panels.filter((pn) => pn.id !== "redflags" && (!pn.advice || !pn.advice.length));
    const moreHtml = more.length ? `<details class="more"><summary>More detail · ${more.map((pn) => esc(pn.title)).join(", ")}</summary>${more.map((pn) => `<section class="card stack"><h2>${esc(pn.title)}</h2><div class="${pn.small ? "multiples" : ""}">${panelVisual(pn)}</div></section>`).join("")}</details>` : "";
    const grp = (g) => `<details ${g.open ? "open" : ""} class="ev-g"><summary>${esc(g.group)} <span class="muted">(${g.rows.length})</span></summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Measure</th><th>Value</th><th>95% CI</th><th>n</th></tr></thead><tbody>${g.rows.map((r) => `<tr><td>${esc(r.label)}${r.caveat ? `<span class="cav">${esc(r.caveat)}</span>` : ""}</td><td class="mono">${esc(r.value)}</td><td class="mono">${esc(r.ci || "–")}</td><td class="mono">${esc(r.n === "" ? "–" : r.n)}</td></tr>`).join("")}</tbody></table></div></details>`;
    const evs = p.evidence || [], mine = evs.filter((g) => !g.scientists), sci = evs.filter((g) => g.scientists);
    const ev = mine.length ? `<details class="more" id="ev"><summary>Evidence behind every number</summary><p class="small muted">95% CI: the range the true value likely sits in. n: how many readings or people it rests on.</p>${mine.map(grp).join("")}</details>` : "";
    const sciHtml = sci.length ? `<details class="more" id="sci"><summary>For scientists · program-wide, trial and real-data results</summary><p class="small muted">Whole-program effects (same person, with and without), the randomized trial, and checks on real data (CGMacros, NHANES). They back the advice above; they are not this patient’s numbers.</p>${sci.map((g) => grp({ ...g, open: false })).join("")}</details>` : "";
    const kp = (p.kpis || []).filter((k) => !k.hero);
    return `${p.mod === "c1" ? redFlagsCard(p) : ""}${p.mod === "c4" ? c4Safety(p, lang) : ""}${heroCard(p.hero, p.mod, p.mod === "c4" && !!p.careFlag)}${fitLine(p)}${p.mod === "c5" ? `<p class="agree-link small"><a href="#calls-agreement">How well Clef’s coach score matches supervisors →</a></p>` : ""}
      ${p.mod === "c3" ? signalRows(p.signals) : ""}${kp.length ? kpiCards(kp) : ""}
      ${p.mod === "c4" ? handout(p, lang) : ""}
      <h2 class="sec-t">What to do</h2>${doCards(p) || `<p class="muted">No actions from this program right now.</p>`}${moreHtml}${ev}${sciHtml}${rawData(p)}${p.footnote ? `<p class="footnote">${esc(p.footnote)}</p>` : ""}`;
  }
  function notEnrolled(tab) {
    return `<div class="state-box"><h2>Not enrolled in ${esc(MODS[tab] ? MODS[tab].name : tab)}</h2><p class="muted">Each program uses its own cohort today, so this patient has no ${esc(MODS[tab] ? MODS[tab].short.toLowerCase() : "")} data. When the programs share one patient ID, this pill fills in. The <a href="#patients">linked demo records</a> show all four programs together.</p></div>`;
  }
  // Patients page: the 5 linked demo records as a small card row above the table, each with its worst status.
  function linkedRow(items) {
    const L = A.linked ? A.linked() : [];
    if (!L.length) return "";
    const byId = new Map(items.map((r) => [r.id, r]));
    const card = (l) => {
      const w = Object.values(l.members).map((id) => byId.get(id)).filter(Boolean).sort((a, b) => RANK[a.tri] - RANK[b.tri])[0];
      return `<a class="lr-card" href="#p-${esc(l.id)}"><span class="lr-name"><b>${esc(l.first)}</b><span class="small muted">${esc(l.who)} · 4 programs</span></span>${w ? statusPill(w.tri) : ""}</a>`;
    };
    return `<section class="linked-row" aria-label="Linked demo records"><div class="lr-head"><h2>Linked demo records</h2><p class="small muted">One record from each program, joined by sex, cancer type and age to show the full view. Not real people.</p></div><div class="lr-cards">${L.map(card).join("")}</div></section>`;
  }

  function callRow(c, withName) {
    // c.saved: a call logged in Patient 360 (Adapter.savedAsCall); it opens the live-call page, where it is the recap.
    if (c.saved) return `<a class="c-row" href="${esc(c.href)}"><span><b>${withName ? esc(c.participantName) + " · " : ""}Logged in Patient 360</b><span class="small muted" style="display:block">${fmtDate(c.date)} · coach ${esc(c.coach.name)}${c.flags.length ? ` · “${esc(c.flags[0].text.slice(0, 90))}”` : ""}</span></span>
      <span class="small">${c.flags.length ? (c.flags.length === 1 ? "1 line flagged" : `${c.flags.length} lines flagged`) : `${c.lines} lines`}</span><span class="mono">${c.score == null ? `<span class="muted small">Not scored</span>` : `${c.score}/100`}</span>${statusPill(c.status === "alert" ? "today" : "ok")}</a>`;
    return `<a class="c-row" href="#call-${esc(c.callId)}"><span>${withName ? `<b>${esc(c.participantName)}</b> · call ${c.callNumber}` : `<b>Call ${c.callNumber} · week ${c.week}</b>`}<span class="small muted" style="display:block">${fmtDate(c.date)} · coach ${esc(c.coach.name)} · ${esc(c.language)} · goal: ${esc(c.goalTopic)}</span></span>
      <span class="small">${c.flags.length ? (c.flags.length === 1 ? "1 line needs a person" : `${c.flags.length} lines need a person`) : `${c.lines} lines`}</span><span class="mono">${c.score == null ? `<span class="muted small">Not scored</span>` : `${c.score}/100`}</span>${statusPill(triage("c5", c.status))}</a>`;
  }

  // ------------------------------------------------------------------ Calls
  async function renderCalls(arg) {
    const head = `<header class="page-head"><div><h1>Calls</h1><p class="sub">Supervisor-labelled coaching calls, concerns first. Open one to run Clef and compare it with the supervisor.</p></div>
      <a class="btn" href="${COPILOT_URL}" target="_blank" rel="noopener">Clef app ↗</a></header>`;
    const f = forced("calls", "No calls reviewed yet.");
    if (f) return head + f;
    let calls;
    try { calls = await once("calls", A.calls); } catch (e) { return head + errorBox("calls", e.message); }
    // Demo: replay a recorded call through the live-call screen (call.js P.playCall), so tags, cues and alerts appear as they would live.
    const flagged = calls.filter((c) => c.flags.length);
    const demos = [flagged.find((c) => c.language === "English"), flagged.find((c) => c.language === "Spanish"), [...calls].filter((c) => !c.flags.length && c.score != null).sort((a, b) => b.score - a.score)[0]]
      .filter((c, i, a) => c && a.indexOf(c) === i);
    const why = (c) => c.flags.length ? `${c.flags[0].kind} concern at ${c.flags[0].t}` : `coach score ${c.score}/100, no concerns`;
    const demo = demos.length ? `<section class="card stack demo-calls"><div class="sec-head"><h2>Play a call as if live</h2><p class="small muted">Replays a recorded call one line every 1.5 s through the live-call screen. Clef tags each line, and cues and alerts appear as they would on a real call.</p></div>
      ${demos.map((c) => `<div class="demo-row"><span><b>${esc(c.participantName)}</b> · call ${c.callNumber} · ${esc(c.language)}<span class="small muted" style="display:block">${esc(why(c))} · ${c.lines} lines · coach ${esc(c.coach.name)}</span></span>
        ${SNAP ? `<a class="btn" href="${LIVE_URL}/#call-${esc(c.callId)}" target="_blank" rel="noopener">Open on the live site ↗</a>` : `<button class="btn primary" data-play="${esc(c.callId)}">▶ Play as live</button>`}<a class="btn" href="#call-${esc(c.callId)}">Call record</a></div>`).join("")}</section>` : "";
    // Calls saved in Patient 360 (any program), newest first, above the labelled set.
    const logged = (await A.context().catch(() => ({ saved: [] }))).saved.map(A.savedAsCall);
    const loggedHtml = logged.length ? `<section class="stack-s"><h2>Logged in Patient 360 · ${logged.length}</h2><div class="calls-list">${logged.map((c) => callRow(c, true)).join("")}</div></section><h2>Supervisor-labelled calls</h2>` : "";
    // Supervisor agreement (C5 /agreement): hidden when the endpoint fails. #calls-agreement opens it.
    const fit = supervisorFit(await once("agreement", A.agreement).catch(() => null), arg === "agreement");
    return `${head}${sourceBanner(["c5"])}${fit}${demo}${loggedHtml}<div class="calls-list">${calls.map((c) => callRow(c, true)).join("")}</div>`;
  }
  // Same table classes as the C1 fairness table. Every number sits next to the A-vs-B row it is compared with.
  function supervisorFit(v, open) {
    if (!v) return "";
    const cell = (val, ci) => `${esc(val)}${ci ? `<span class="cav">${esc(ci)}</span>` : ""}`;
    const rows = v.rows.map((r) => `<tr><td>${r.yard ? `<b>${esc(r.pair)}</b>` : esc(r.pair)}${r.note ? `<span class="cav">${esc(r.note)}</span>` : ""}</td><td class="mono">${esc(r.n)}</td><td class="mono">${cell(r.r, r.ci)}</td><td class="mono">${esc(r.mae)}</td><td class="mono">${cell(r.icc, r.iccCi)}</td></tr>`).join("");
    const flags = v.flags.length ? `<p class="fig-t">Safety flags</p><p class="small muted">${esc(v.flagLead)}</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Measure</th><th>Rate (95% CI)</th></tr></thead><tbody>${v.flags.map((f) => `<tr><td>${esc(f.label)}<span class="cav">${esc(f.count)}</span></td><td class="mono">${cell(f.rate, f.ci)}</td></tr>`).join("")}</tbody></table></div>` : "";
    return `<details class="more" id="agreement"${open ? " open" : ""}><summary>How well Clef’s coach score matches supervisors</summary>
      <div class="stack-s"><p>${esc(v.headline)}</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pair</th><th>n</th><th>Pearson r (95% CI)</th><th>MAE</th><th>ICC (95% CI)</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">Compare each Clef row with the Supervisor A vs Supervisor B row. Pearson r: 1 = scores rise and fall together perfectly, 0 = unrelated. MAE: average gap in points on the supervisors’ 1–5 scale; lower is closer. ICC: agreement on the score itself. – = not computed for that pair.</p>
      ${flags}
      <details class="more tech"><summary>Method</summary>${v.method.map((m) => `<p class="footnote">${esc(m)}</p>`).join("")}</details>
      <p class="footnote">${esc(v.label)}.</p></div></details>`;
  }

  /* Call review: supervisor labels first; "Run Clef" sends each line through /api/c5/turn
     (Clef), low-confidence lines through /api/c5/review (GLM), and cue triggers through /api/c5/cue,
     using the same rules as Clef's own screen. */
  const FAMILY = { "open question": "q", "closed question": "q", "simple reflection": "r", "complex reflection": "r", affirm: "s", "seek collaboration": "s", "emphasize autonomy": "s", "ask permission": "s", "give information": "i", persuade: "x", confront: "x", other: "o" };
  const FLAG_TEXT = { medical: "Medical concern: tell the care team today", distress: "Emotional distress: check in and connect to support today", social: "Unmet basic need: connect to a navigator today", missed_concern: "Coach did not route a concern the patient raised", medical_advice: "Coach gave medical advice outside their role" };
  let live = null;

  function liveScore(lines) {
    const c = lines.filter((l) => l.speaker === "coach" && l.live && l.live.tag).map((l) => l.live.tag);
    const n = (t) => c.filter((x) => x === t).length;
    const oq = n("open question"), cq = n("closed question"), sr = n("simple reflection"), cr = n("complex reflection");
    const ad = c.filter((t) => FAMILY[t] === "s").length, na = n("persuade") + n("confront"), q = oq + cq, r = sr + cr;
    if (c.length < 4) return null;
    return Math.round(30 * Math.min((q ? r / q : r ? 2 : 0) / 2, 1)) + Math.round(20 * Math.min((r ? cr / r : 0) / 0.4, 1)) + Math.round(20 * Math.min((q ? oq / q : 0) / 0.5, 1)) + Math.round(30 * (ad + na ? ad / (ad + na) : 1));
  }

  function agreement(lines) {
    let m = 0, mn = 0, t = 0, tn = 0, f = 0, fn = 0;
    for (const l of lines) {
      if (!l.live || !l.live.tag) continue;
      if (l.speaker === "coach" && l.supervisor.move) { mn++; if (l.live.tag === l.supervisor.move) m++; }
      if (l.speaker === "participant" && l.supervisor.talk) { tn++; if (l.live.tag === l.supervisor.talk) t++; }
      if (l.speaker === "participant") { fn++; if (!!(l.live.flag && l.live.flag !== "none") === !!l.supervisor.needsHuman) f++; }
    }
    return { move: mn ? m / mn : null, mn, talk: tn ? t / tn : null, tn, flag: fn ? f / fn : null, fn };
  }

  function lineHtml(l, coachName) {
    const sup = l.speaker === "coach" ? l.supervisor.move : l.supervisor.talk ? l.supervisor.talk + " talk" : "";
    const supTag = sup ? `<span class="tag sup" title="Supervisor label">${esc(sup)}</span>` : "";
    const needs = l.supervisor.needsHuman ? `<span class="tag flag" title="Supervisor label">▲ needs a person</span>` : "";
    let liveTag = "";
    if (l.pending) liveTag = `<span class="tag pending">Clef…</span>`;
    else if (l.live && l.live.error) liveTag = `<span class="tag bad" title="${esc(l.live.error)}">model error</span>`;
    else if (l.live && l.live.tag) {
      const want = l.speaker === "coach" ? l.supervisor.move : l.supervisor.talk;
      const ok = want ? l.live.tag === want : null;
      liveTag = `<span class="tag live ${ok === false ? "miss" : ""}" title="Clef, confidence ${Math.round((l.live.confidence || 0) * 100)}%${l.live.reviewed ? ", checked by a second model" : ""}">${ok === true ? "✓ " : ok === false ? "≠ " : ""}Clef: ${esc(l.live.tag)}${l.speaker === "participant" ? " talk" : ""}</span>`;
    }
    const lf = l.live && l.live.flag && l.live.flag !== "none" ? `<span class="tag flag live-flag">▲ Clef: ${esc(l.live.flag.replace("_", " "))}</span>` : "";
    const cue = l.cue ? l.cue.html || cueHtml(l.cue, l.cue.trigger) : "";
    const flagged = l.supervisor.needsHuman || lf;
    return `<div class="line ${l.speaker} ${flagged ? "flagged" : ""}" id="line-${l.n}"><span class="t">${esc(l.t)}</span><div><span class="who">${l.speaker === "coach" ? "Coach " + esc(coachName) : "Patient"}</span><p>${esc(l.text)}</p><div class="tags">${supTag}${needs}${liveTag}${lf}</div>${cue}</div></div>`;
  }

  function sidePanel(c) {
    const mine = live && live.callId === c.callId;
    const lines = mine ? live.lines : c.lines;
    const a = agreement(lines);
    const ls = liveScore(lines);
    const done = mine ? live.done : 0;
    const names = { reflectionsPerQuestion: "Reflections per question", complexReflectionPct: "Complex reflections %", openQuestionPct: "Open questions %", miConsistent: "Supportive vs persuade/confront" };
    const parts = Object.entries(c.scoreParts).map(([k, p]) => `<div class="part"><span>${names[k]} <span class="muted mono">${esc(p.value ?? "–")} · target ${esc(p.target)}</span></span><span class="mono">${p.points}/${p.max}</span><span class="track"><span class="fill" style="width:${(100 * p.points) / p.max}%"></span></span></div>`).join("");
    const liveBtn = SNAP ? `<a class="btn primary" href="${LIVE_URL}/#call-${esc(c.callId)}" target="_blank" rel="noopener">Run Clef ↗</a><p class="small muted">This shared copy can’t call the model. The live console can.</p>`
      : `<button class="btn primary" data-run ${mine && live.running ? "disabled" : ""}>${mine && live.running ? `Tagging ${done} of ${c.lines.length}…` : mine && done ? "Run again" : "Run Clef"}</button>`;
    return `<aside class="call-side">
      <div class="card stack"><p class="eyebrow">Coach score</p>
        <div class="score-pair"><div><span class="n">${c.score ?? "–"}</span><span class="l">from supervisor labels</span></div><div><span class="n" id="live-score">${ls ?? "–"}</span><span class="l">from Clef tags</span></div></div>${parts}
        <p class="small muted" title="Targets from the Motivational Interviewing Treatment Integrity (MITI) code">Scored against standard motivational-interviewing targets.</p></div>
      <div class="card stack"><p class="eyebrow">Clef vs supervisor</p>${liveBtn}
        ${a.mn || a.tn ? `<div class="agree" id="agree"><span><b>${pct(a.move)}</b> coach moves (${a.mn} lines)</span><span><b>${pct(a.talk)}</b> patient talk (${a.tn})</span><span><b>${pct(a.flag)}</b> needs-a-person calls (${a.fn})</span></div><p class="small muted">Two human experts labelling the same lines agree about 84% of the time.</p>` : `<p class="small muted">Run the model to see how closely it matches the supervisor, line by line.</p>`}
        <a class="small" href="${COPILOT_URL}" target="_blank" rel="noopener">Tag a spoken call in Clef ↗</a></div>
    </aside>`;
  }

  // Flags are compact rows. Patient safety (medical, distress, basic need) is red and says what to do;
  // coaching quality (missed concern, advice out of role) is amber: it is feedback for the coach, not an emergency.
  const FLAG_KIND = { medical: ["safety", "Medical"], distress: ["safety", "Distress"], social: ["safety", "Basic need"], missed_concern: ["coaching", "Missed concern"], medical_advice: ["coaching", "Out of role"] };
  function flagBanner(x) {
    const [cls, chip] = FLAG_KIND[x.kind] || ["safety", "Needs a person"];
    return `<div class="flag-row f-${cls}" role="${cls === "safety" ? "alert" : "status"}" data-kind="${esc(x.kind || "")}"><span class="f-chip">${cls === "safety" ? "▲" : "◆"} ${chip}</span>
      <div class="f-body"><b>${esc(FLAG_TEXT[x.kind] || "A person must follow up today")}</b><q>${esc(x.text)}</q></div>
      <div class="f-act"><a href="#line-${x.line}" title="Jump to the line">Line ${x.line} · ${esc(x.t)}</a>${cls === "safety" ? `<button class="btn danger sm" data-handoff data-flag="${esc(x.text)}">Hand off</button>` : ""}<span class="f-src">${esc(x.src)}</span></div></div>`;
  }
  // Safety flags first, then coaching notes; one heading with the count.
  function flagList(items) {
    if (!items.length) return "";
    const rank = (b) => (b.includes("f-safety") ? 0 : 1);
    const html = items.sort((a, b) => rank(a) - rank(b));
    const safe = html.filter((h) => h.includes("f-safety")).length;
    return `<section class="flags" aria-label="Flags"><p class="eyebrow">${safe ? `${safe} need${safe === 1 ? "s" : ""} a person today` : ""}${safe && html.length > safe ? " · " : ""}${html.length > safe ? `${html.length - safe} coaching note${html.length - safe === 1 ? "" : "s"}` : ""}</p>${html.join("")}</section>`;
  }

  async function renderCall(id) {
    const back = `<a class="back" href="#calls">← Calls</a>`;
    const f = forced("this call", "This call has no lines yet. For a live call, lines appear as people speak.");
    if (f) return back + f;
    let c;
    try { c = await Adapter.call(id); } catch (e) { return back + errorBox("this call", e.message); }
    const lines = live && live.callId === c.callId ? live.lines : c.lines;
    const untagged = lines.filter((l) => !(l.speaker === "coach" ? l.supervisor.move : l.supervisor.talk) && !(l.live && l.live.tag)).length;
    // Supervisor labels say only "needs a person"; the kind comes from the live model when it has run.
    const banners = flagList(c.flags.map((x) => flagBanner({ ...x, kind: null, src: "Supervisor" }))
      .concat(lines.filter((l) => l.live && l.live.flag && l.live.flag !== "none").map((l) => flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Clef" }))));
    return `${back}<header class="page-head"><div><p class="eyebrow">${modChip("c5")}</p><h1>${esc(c.participantName)} · call ${c.callNumber}</h1>
      <div class="facts"><span>Coach <b>${esc(c.coach.name)}</b> (${esc(c.coach.role)})</span><span>Week <b>${c.week}</b></span><span><b>${fmtDate(c.date)}</b> ${esc(c.start)}</span><span>${esc(c.language)}</span><span>Goal <b>${esc(c.goalTopic)}</b></span><span><b>${c.durationMin}</b> min</span></div></div>
      <div class="row">${SNAP ? "" : `<button class="btn primary" data-play="${esc(c.callId)}">▶ Play as live</button>`}<a class="btn" href="#p-${esc(c.survivorId)}">Patient page</a></div></header>
      <div id="flagbox" class="stack">${banners}</div>
      <div class="call-layout"><section class="card"><div class="sec-head"><h2>Transcript</h2><p class="small muted">${untagged ? `${untagged} of ${lines.length} lines have no tag yet: press Run Clef to fill them.` : `Every line is already tagged from the call record (grey tag).`} Run Clef to add the model’s tag beside it (outlined: ✓ agrees, ≠ differs).</p></div><div class="transcript scroll" id="transcript">${lines.map((l) => lineHtml(l, c.coach.name)).join("")}</div></section>
      <div id="side">${sidePanel(c)}</div></div>`;
  }

  async function runLive(c) {
    const L = { callId: c.callId, running: true, done: 0, lastCueAt: -99, lines: c.lines.map((l) => ({ ...l, pending: true })) };
    live = L;
    const coachName = c.coach.name;
    const side = () => { const s = document.getElementById("side"); if (s && live === L) s.innerHTML = sidePanel(c); };
    const repaint = (l) => { const el = document.getElementById("line-" + l.n); if (el && live === L) el.outerHTML = lineHtml(l, coachName); };
    await render();
    for (let i = 0; i < L.lines.length; i++) {
      if (live !== L) return;
      const l = L.lines[i];
      const previous = L.lines.slice(Math.max(0, i - 2), i).map((p) => ({ speaker: p.speaker, text: p.text, tag: p.live && p.live.tag, flag: p.live && p.live.flag && p.live.flag !== "none" ? p.live.flag : undefined }));
      try {
        const r = await post("/api/c5/turn", { line: { speaker: l.speaker, text: l.text }, previous });
        l.live = { tag: r.tag, confidence: r.confidence, flag: r.flag };
        if (r.confidence != null && r.confidence < 0.3) {
          post("/api/c5/review", { line: { speaker: l.speaker, text: l.text }, previous, probabilities: r.probabilities })
            .then((v) => { const lab = v.label || v.tag; if (lab && live === L) { l.live.tag = lab; l.live.reviewed = true; repaint(l); side(); } }).catch(() => {});
        }
      } catch (e) { l.live = { error: e.message }; }
      l.pending = false;
      L.done = i + 1;
      cueCheck(L, i, coachName);
      repaint(l);
      if (l.live.flag && l.live.flag !== "none") { const box = document.getElementById("flagbox"); if (box && live === L) box.innerHTML = flagList([...box.querySelectorAll(".flag-row")].map((r) => r.outerHTML).concat(flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Clef" }))); }
      side();
    }
    L.running = false;
    side();
  }

  /* Cues: one line the coach can say, in bold; the reason in small print. Clef's cue text is an instruction to the
     coach and sometimes ends with a template ("Example: 'say' thing."), so it goes to the small print, cut at "Example".
     Spanish: coaches here speak usted to older patients. A tú-form line is converted when the forms are simple;
     if any tú form is left, the coach gets the English reason only, never a line in the wrong register. */
  const W = (s) => `(?<!\\p{L})(?:${s})(?!\\p{L})`;
  const TU_RE = new RegExp(W("tú|tu|tus|te|ti|contigo|quieres|puedes|tienes|sientes|imaginas|has|estás|eres|podrías|sabes|crees|piensas|haces|vas|dices|necesitas|quisieras|cuéntame|dime|imagínate|\\p{L}+(?:arte|erte|irte)|\\p{L}{2,}(?:aste|iste|abas)"), "iu");
  const US_RE = new RegExp(W("usted|ustedes|le|su|sus|quiere|puede|tiene"), "iu");
  const TU_MAP = [["te imaginas tú", "se imagina usted"], ["te (sientes|imaginas|preocupas|animas|cuidas)", (m, v) => "se " + v.slice(0, -1)], ["te", "le"], ["tú|ti", "usted"], ["contigo", "con usted"], ["tus", "sus"], ["tu", "su"],
    ["(sentir|cuidar|animar|preocupar)te", "$1se"], ["(ayudar|preguntar|contar|decir|escuchar)te", "$1le"], ["cuéntame", "cuénteme"], ["dime", "dígame"], ["imagínate", "imagínese"], ["has", "ha"], ["estás", "está"], ["eres", "es"], ["vas", "va"],
    ["(quier|pued|tien|sient|sab|cre|hac|dic)es", "$1e"], ["(imagin|piens|necesit|podrí|quisier)as", "$1a"], ["(\\p{L}{2,})abas", "$1aba"], ["(\\p{L}{2,})aste", "$1ó"]].map(([a, b]) => [new RegExp(W(a), "giu"), b]);
  const isSpanish = (s) => /[¿¡ñ]|[áéíóú]\p{L}*\s/u.test(s) || new RegExp(W("que|qué|cómo|usted|para|pero|muy|el|la|los|con"), "iu").test(s);
  function cueParts(r, trigger, lines) {
    const unq = (s) => String(s || "").trim().replace(/^["“”'‘’«]+|["“”'’»]+$/g, "").trim();
    let say = unq(r.say);
    const why = String(r.cue || "").replace(/\s*(?:for example|example|e\.g\.)\s*:[\s\S]*$/i, "").replace(/\s*["“][^"”]*["”]\s*$/, "").trim();
    if (say && isSpanish(say) && TU_RE.test(say)) {
      const coach = (lines || []).filter((x) => x.speaker === "coach").map((x) => x.text).join(" ");
      const coachTu = TU_RE.test(coach) && !US_RE.test(coach);
      if (!coachTu) { TU_MAP.forEach(([re, to]) => (say = say.replace(re, to))); if (TU_RE.test(say)) say = ""; }
    }
    if (say && !/[.?!…”"]$/.test(say)) say += ".";
    return { say, why: why || (say ? "" : unq(r.cue)), trigger: trigger || "" };
  }
  function cueHtml(r, trigger, lines) {
    const c = cueParts(r, trigger, lines);
    const main = c.say ? `<b class="say">“${esc(c.say)}”</b>` : `<b>${esc(c.why)}</b>`;
    const small = [c.say ? c.why : "", c.trigger].filter(Boolean).map(esc).join(" · ");
    return `<p class="cue">${main}${small ? `<span class="why">${small}</span>` : ""}</p>`;
  }
  // Same trigger rules as Clef's own screen. Pure: used by call review and by live calls.
  function cueTrigger(lines, i, lastCueAt) {
    const l = lines[i];
    if (!l.live || !l.live.tag) return null;
    const coachCount = lines.slice(0, i + 1).filter((x) => x.speaker === "coach").length;
    let trigger = null;
    const f = l.live.flag;
    if (f === "missed_concern") trigger = "The patient raised a concern and the coach moved on without routing it.";
    else if (f === "medical_advice") trigger = "The coach just gave medical advice outside their role.";
    else if (f && f !== "none") trigger = `The patient raised a ${f} concern.`;
    else if (l.speaker === "coach") {
      const coach = lines.slice(0, i + 1).filter((x) => x.speaker === "coach" && x.live && x.live.tag);
      const last = coach.slice(-4).map((x) => x.live.tag), before = lines[i - 1];
      if (l.live.tag === "confront") trigger = "The coach just confronted the patient.";
      else if (l.live.tag === "persuade" && !coach.slice(-3, -1).some((x) => x.live.tag === "ask permission")) trigger = "The coach told the patient what to do without asking permission.";
      else if (before && before.speaker === "participant" && before.live && before.live.tag === "change" && FAMILY[l.live.tag] !== "r" && l.live.tag !== "affirm") trigger = "The patient voiced change talk and the coach did not reflect or affirm it.";
      else if (last.length === 4 && last.every((t) => FAMILY[t] === "q")) trigger = "Four questions in a row without a reflection.";
      else if (last.length >= 3 && last.slice(-3).every((t) => t === "closed question")) trigger = "Three closed questions in a row.";
      if (trigger && coachCount - lastCueAt < 3) trigger = null;
    }
    return trigger ? { trigger, coachCount } : null;
  }
  function cueCheck(L, i, coachName) {
    const lines = L.lines.slice(0, i + 1), l = L.lines[i];
    const hit = cueTrigger(L.lines, i, L.lastCueAt);
    const trigger = hit && hit.trigger, coachCount = hit && hit.coachCount;
    if (!trigger) return;
    L.lastCueAt = coachCount;
    const recent = lines.slice(-8).map((x) => ({ speaker: x.speaker, text: x.text, tag: x.live && x.live.tag }));
    post("/api/c5/cue", { trigger, recent }).then((r) => {
      if (!r.cue || live !== L) return;
      l.cue = { ...r, trigger, html: cueHtml(r, trigger, L.lines) };
      const el = document.getElementById("line-" + l.n); if (el) el.outerHTML = lineHtml(l, coachName);
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ later
  async function renderCare() {
    const head = `<header class="page-head"><div><p class="eyebrow">Challenge 1 · for the care-team lead</p><h1>Hospital risk</h1><p class="sub">Who is likely to need the ER or a hospital bed: this week from wearables, and over the next 12 months from survey answers (data years 2017 survey, 2018 outcome). Highest first.</p></div></header>`;
    const f = forced("hospital risk", "No risk scores yet.");
    if (f) return head + f;
    const [{ rows }, m] = await Promise.all([once("roster", A.roster), once("m:c1", () => A.metrics("c1")).catch(() => null)]);
    const list = sortRows(rows.filter((x) => x.mod === "c1"));
    const flagged = A.fairFlag || ((g) => g.auroc < 0.6);
    const c1h = A.c1Headline || ((h) => h);
    // Patient cell: age/sex/cancer first, ID second (module IDs lead the display name).
    const who = (it) => { const d = A.demoName ? A.demoName(it.name) : it.name, p = d.split(" · "); return d !== it.name ? [p.slice(0, -1).join(" · "), p[p.length - 1]] : [it.name, it.id]; };
    const careRow = (it, tab, hl) => { const [nm, sub] = who(it); return `<tr class="row-link" data-href="#p-${esc(it.id)}.${tab}" role="link" tabindex="0" aria-label="${esc(nm)}: open ${tab === "c3" ? "rough weeks" : "hospital risk"}"><td>${statusPill(it.tri)}</td><td class="nm"><b>${esc(nm)}</b><div class="small muted mono">${esc(sub)}</div></td><td class="hl">${esc(hl)}</td></tr>`; };
    const thead = `<thead><tr><th>Status</th><th>Patient</th><th>Why</th></tr></thead>`;
    // Next 7 days (C3 wearables) above the 12-month C1 list: same outcome, different horizon.
    const soon = rows.filter((x) => x.mod === "c3" && /ER or hospital risk/i.test(x.headline || "")).sort((a, b) => (a.prio ?? 0) - (b.prio ?? 0) || RANK[a.tri] - RANK[b.tri]);
    const week = `<section class="stack-s"><h2>Next 7 days · wearables (C3) · ${soon.length}</h2><p class="small muted">ER or hospital risk this week, from watch signals against the person’s own usual. Several times their usual risk within a week means a same-day call (Act today). The 12-month list below is for outreach planning, so a high yearly risk is Alert, not Act today.</p>${soon.length ? `<div class="ptable-wrap"><table class="ptable">${thead}<tbody>${soon.map((it) => careRow(it, "c3", it.headline)).join("")}</tbody></table></div>` : `<p class="muted small">No one is over the 7-day urgent line.</p>`}</section>`;
    const tiers = m && m.tiers && m.tiers.tiers ? m.tiers.tiers : [];
    const fin = m && m.finalModel ? m.finalModel.key || m.finalModel.name : null;
    const fm = m && m.metrics ? (fin && m.metrics[fin]) || m.metrics.logistic : null, bm = m && m.metrics && m.metrics.baseline;
    const fmName = fin && m.metrics[fin] && m.finalModel.name ? String(m.finalModel.name).split(" (")[0].toLowerCase() : "model";
    const range = (t) => (t.riskFrom > 0 && t.riskTo < 1 ? `${num(t.riskFrom * 100)}–${pct(t.riskTo)}` : t.riskFrom > 0 ? `≥${pct(t.riskFrom)}` : `under ${pct(t.riskTo)}`);
    const dev = m && m.data && m.data.devSurvivors;
    const strip = tiers.length ? `<div class="stat-strip">${tiers.map((t) => `<a href="#patients-${t.status}"><span class="n">${range(t)}</span><span class="l">${GROUP[t.status]}: risk ${range(t)} · ${pct(t.observedRate)} of these had an ER visit or stay (${t.n} of ${dev || "the"} development patients, cross-validated; not the ${list.length} below)</span></a>`).join("")}${fm && fm.auroc ? `<div><span class="n">${num(fm.auroc.value, 2)}</span><span class="l">AUROC of the deployed ${esc(fmName)} (0.5 = chance; 95% CI ${num(fm.auroc.ci95[0], 2)}–${num(fm.auroc.ci95[1], 2)})${bm && bm.auroc ? ` · baseline ${num(bm.auroc.value, 2)}` : ""} · cross-validated</span></div>` : ""}</div>${dev ? `<p class="small muted">Tier rates and AUROC: ${dev} development patients, repeated 5-fold cross-validation. The list below: ${list.length} new patients scored by the deployed model.</p>` : ""}` : "";
    const table = `<div class="ptable-wrap"><table class="ptable">${thead}<tbody>${list.slice(0, ui.limit / 4).map((it) => careRow(it, "c1", c1h(it.headline))).join("")}</tbody></table>${list.length > ui.limit / 4 ? `<button class="r-more" data-more>Show 15 more of ${list.length}</button>` : ""}</div>`;
    const year = `<section class="stack-s"><h2>Next 12 months · survey model (C1) · ${list.length} patients</h2><p class="small muted">“Driven by” names the top driver other than health spending; the model also uses spending, a cost proxy for need. Open a patient to see every driver.</p>${table}</section>`;
    // Factors: a forest-style list, rate with vs without each factor, highest rate ratio first.
    const pf = m && Array.isArray(m.plainFactors) ? m.plainFactors : [];
    const fobj = pf.filter((x) => x && typeof x === "object" && x.rateRatio != null).sort((a, b) => b.rateRatio - a.rateRatio);
    const rmax = Math.max(1.01, ...fobj.map((x) => x.rateRatio));
    const rbar = (r) => `<span style="display:inline-block;vertical-align:middle;height:8px;margin-right:8px;width:${Math.max(2, Math.round((72 * Math.abs(r - 1)) / (rmax - 1)))}px;background:${r >= 1 ? "var(--m-c1)" : "var(--ink-3)"}"></span>`;
    const factors = pf.length ? `<details class="more"><summary>What raises or lowers risk across everyone · ${pf.length} factors</summary>${fobj.length ? `<p class="small muted">Share with an ER visit or hospital stay in 2018, with and without each factor (${dev || "development"} patients, data year 2017). Rate ratio = with ÷ without. Associations, not causes.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Factor</th><th>People with it</th><th>Rate with</th><th>Rate without</th><th>Rate ratio</th></tr></thead><tbody>${fobj.map((x) => `<tr><td>${esc(x.factor)}</td><td class="mono">${x.withFactor ? x.withFactor.n : "–"}</td><td class="mono">${pct(x.withFactor && x.withFactor.rate, 1)}</td><td class="mono">${pct(x.without && x.without.rate, 1)}</td><td class="mono" style="white-space:nowrap">${rbar(x.rateRatio)}${num(x.rateRatio, 2)}×</td></tr>`).join("")}</tbody></table></div>` : ""}${pf.some((x) => typeof x === "string") ? `<ul class="evidence">${pf.filter((x) => typeof x === "string").map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</details>` : "";
    // Fairness: flag any group the model is unreliable for, whatever its n.
    const fg = m && Array.isArray(m.fairness) ? m.fairness : [];
    const nBad = fg.filter(flagged).length;
    const why = (g) => (g.auroc != null && g.auroc < 0.4 ? "worse than chance: the ranking is inverted" : g.auroc != null && g.auroc < 0.6 ? "ranks at or near chance" : "calibration off: O/E interval excludes 1");
    const ci = (a) => (Array.isArray(a) ? ` <span class="muted">(${num(a[0], 2)}–${num(a[1], 2)})</span>` : "");
    const fair = fg.length ? `<details class="more"><summary>Fairness check by group · ${fg.length} groups${nBad ? ` · ${nBad} unreliable` : ""}</summary>${nBad ? `<p class="small" style="color:var(--alert-ink)">▲ Don’t act on the score alone for patients in a red group. Their record and drivers come first.</p>` : ""}<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Group</th><th>n</th><th>Observed</th><th>Predicted</th><th>O/E (95% CI)</th><th>AUROC (95% CI)</th></tr></thead><tbody>${fg.map((g) => { const bad = flagged(g); return `<tr${bad ? ' style="background:var(--alert-soft)"' : ""}><td>${bad ? '<b style="color:var(--alert)">▲</b> ' : ""}${esc(g.attribute.replace(/_/g, " "))}: ${esc(g.group)}${bad ? `<span class="cav" style="color:var(--alert-ink)">${esc(why(g))}</span>` : ""}${g.tooSmall ? '<span class="cav">small group: wide intervals</span>' : ""}</td><td class="mono">${g.n}</td><td class="mono">${pct(g.observedRate)}</td><td class="mono">${pct(g.meanPredicted)}</td><td class="mono">${num(g.oe, 2)}${ci(g.oeCi95)}</td><td class="mono">${num(g.auroc, 2)}${ci(g.aurocCi95)}</td></tr>`; }).join("")}</tbody></table></div><p class="small muted">O/E = observed ÷ predicted events; 1.00 is perfect calibration. Red = AUROC under 0.6 or an O/E interval that excludes 1, whatever the group size.</p></details>` : "";
    const cav = m && m.caveats ? `<details class="more"><summary>Caveats</summary><ul class="evidence">${m.caveats.map((c) => `<li>${esc(typeof c === "string" ? c : Object.values(c || {}).filter((v) => typeof v !== "object").join(": "))}</li>`).join("")}</ul></details>` : "";
    const raw = m ? `<details class="more raw"><summary>Everything the model card holds · ${flatten(m).length} fields</summary><div class="tbl-wrap"><table class="kv-tbl"><tbody>${flatten(m).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table></div></details>` : "";
    // Patients first; the evidence behind the numbers sits under one collapsed "How much to trust this".
    // Patients first; everything about the model sits under one collapsed "How much to trust this".
    const trust = `<details class="more trust"><summary>How much to trust this${fm && fm.auroc ? `<span class="muted">· AUROC ${num(fm.auroc.value, 2)}, cross-validated</span>` : ""}</summary><div class="stack"><p class="small muted">${fm && fm.auroc ? `The ${esc(fmName)} ranks patients correctly ${pct(fm.auroc.value)} of the time (AUROC ${num(fm.auroc.value, 2)}, 0.5 = chance${bm && bm.auroc ? `; simple baseline ${num(bm.auroc.value, 2)}` : ""}). ` : ""}Associations, not causes. Check the fairness table before acting on a score for a flagged group.</p>
      <details class="more"><summary>Risk tiers and accuracy${dev ? ` · ${dev} development patients` : ""}</summary>${strip}</details>${factors}${fair}${cav}${raw}</div></details>`;
    // Whoop pattern: one number (high 12-month risk among patients the model never trained on), what it means, what to do.
    const high = list.filter((x) => x.status === "alert").length;
    const topTier = tiers.find((t) => t.status === "alert");
    const hero = `<section class="care-hero" aria-labelledby="care-n"><div class="hero-main"><p class="hero-fig" id="care-n"><span class="hero-n">${high}</span><span class="hero-unit">at high 12-month risk</span><span class="src-note">held-out · real MEPS</span></p>
      <p class="hero-means">Of ${list.length} survivors scored by the survey model, which never saw them in training${topTier ? `. High = predicted risk ${esc(range(topTier))}; ${pct(topTier.observedRate)} of similar patients had an ER visit or stay` : ""}.</p>
      <p class="hero-do"><b>What to do:</b> plan outreach from the top of the 12-month list. Same-day calls come from the 7-day list.</p></div>
      <dl class="hero-side"><a href="#care-week"><dt>Urgent, next 7 days</dt><dd>${soon.length}</dd></a></dl></section>`;
    return `${head}${sourceBanner(["c1", "c3"])}${hero}${week.replace('<section class="stack-s">', '<section class="stack-s" id="care-week">')}${year}${trust}
      <p class="footnote">${m && m.outcome ? esc(m.outcome) + ". " : ""}Factors are associations, not causes. Survey and clinical records share no patient key.</p>`;
  }
  function renderResearch() {
    return `<header class="page-head"><div><p class="eyebrow">Later · Challenges 6 and 7</p><h1>Research</h1></div></header>
      <div class="state-box research-later" role="status"><span class="state-ico" aria-hidden="true">◇</span><h2>Coming later</h2><p class="muted">Drug discovery for lab scientists. It will be a separate area with its own data and permissions, and it never mixes with patient data.</p><div class="row"><a class="btn" href="#today">Back to Today</a></div></div>`;
  }

  // ------------------------------------------------------------------ router
  // Plain-token hashes (#today, #p-c3-P02465, #p-c3-P02465.c3, #call-CALL05423, #today~error): the Artifact
  // viewer passes only letters, digits and . _ ~ - from a shared link. Split on the first "-": ids contain "-".
  function parse() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, "")) || "today";
    const [path, st] = raw.split("~");
    const k = path.indexOf("-");
    let route = k < 0 ? path : path.slice(0, k), arg = k < 0 ? "" : path.slice(k + 1);
    if (route === "s") route = "p";
    return { route, arg, st };
  }
  let renderSeq = 0, current = null;
  /* Last line of defence: no text node may read undefined, NaN, null or [object Object]. The raw-response
     tables (.kv-tbl) are exempt: they print exactly what a program sent. */
  function scrub(root) {
    const bad = /\b(?:undefined|NaN|null)\b|\[object Object\]/g;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest(".kv-tbl, script, style, textarea") ? NodeFilter.FILTER_REJECT : bad.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const hits = []; while (w.nextNode()) hits.push(w.currentNode);
    hits.forEach((n) => { bad.lastIndex = 0; n.nodeValue = n.nodeValue.replace(bad, "Not recorded"); });
  }
  async function render() {
    const { route, arg, st } = parse();
    if (route === "line") return;
    previewState = st || "ready";
    if (route !== "p" && route !== "live") current = null;
    const seq = ++renderSeq;
    const nav = { p: "patients", call: "calls", live: "patients" }[route] || route;
    document.querySelectorAll(".nav-link").forEach((a) => { const on = a.dataset.nav === nav; a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    const key = route + arg + (st ? "~" + st : "");
    const newPage = view.dataset.ready !== key;
    if (newPage) delete view.dataset.ready; // "not ready" from the first frame, so nobody reads the old page as the new one
    // The skeleton shows only when the page takes a moment (no saved copy to paint from yet).
    const skT = newPage ? setTimeout(() => { if (seq === renderSeq) view.innerHTML = loadingBox("page", route === "today" ? "today" : ""); }, 120) : null;
    let html;
    try {
      if (route === "today") html = await renderToday();
      else if (route === "p") html = arg ? await renderPatient360(arg) : await renderToday();
      else if (route === "patients") html = await renderPatients(arg);
      else if (P360.routes[route]) html = await P360.routes[route](arg);
      else if (route === "calls") html = await renderCalls(arg);
      else if (route === "call") html = await renderCall(arg);
      else if (route === "care") html = await renderCare();
      else if (route === "research") html = renderResearch();
      else html = notFoundBox();
    } catch (e) { console.warn(e); html = errorBox("this page", e.message); }
    clearTimeout(skT);
    if (seq !== renderSeq) return;
    const refreshing = A.pending && A.pending() > 0 && !SNAP;
    view.innerHTML = (refreshing ? `<p class="refreshing" aria-busy="true"><span class="pulse" aria-hidden="true"></span>Showing the saved copy · updating from the programs…</p>` : "") + html;
    scrub(view);
    view.dataset.ready = key;
    view.dataset.state = previewState;
    if (newPage) { view.classList.remove("enter"); void view.offsetWidth; view.classList.add("enter"); }
    updateMode();
  }
  /* Saved copy first: the adapter paints from fallback-data.js when a program is slow, then fires p360:refresh
     as live answers land. Re-render in place, except on pages with work in progress (a live call, a running review). */
  let refT;
  window.addEventListener("p360:refresh", () => {
    clearTimeout(refT);
    refT = setTimeout(() => {
      const { route } = parse();
      if (route === "live" || (route === "call" && live && live.running) || document.querySelector("dialog[open]")) return;
      memo.clear();
      const active = document.activeElement && document.activeElement.id;
      render().then(() => { if (active === "search") { const s = document.getElementById("search"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } } });
    }, 150);
  });

  // ------------------------------------------------------------------ events
  const toast = document.getElementById("toast");
  let toastT;
  function showToast(msg) { toast.textContent = msg; toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (toast.hidden = true), 3200); }
  const tip = document.getElementById("tip");
  document.addEventListener("pointermove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t && t.dataset.tip) { tip.textContent = t.dataset.tip; tip.hidden = false; tip.style.left = Math.min(e.clientX + 12, innerWidth - 280) + "px"; tip.style.top = e.clientY + 14 + "px"; } else tip.hidden = true;
  });
  // Clickable table rows (Hospital risk): the whole row opens data-href; Enter or Space does the same.
  const rowLink = (e) => { const r = e.target.closest && e.target.closest("tr[data-href]"); return r && !e.target.closest("a, button") ? r : null; };
  document.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; const r = rowLink(e); if (r && e.target === r) { e.preventDefault(); location.hash = r.dataset.href; } });
  document.addEventListener("click", async (e) => {
    const row = rowLink(e);
    if (row) { location.hash = row.dataset.href; return; }
    const el = e.target.closest("button, a");
    if (!el) return;
    if (el.dataset.toast) showToast(el.dataset.toast);
    if (el.hasAttribute("data-handoff")) { e.preventDefault(); handoffFrom(el); return; }
    if (el.hasAttribute("data-mark-called")) { e.preventDefault(); markCalled(el); return; }
    if (el.dataset.moreRows) { const hz = el.dataset.moreRows; ui["more_" + hz] = !ui["more_" + hz]; render(); return; }
    if (el.hasAttribute("data-src-toggle")) { srcOpen = !srcOpen; updateMode(); const b = document.querySelector("[data-src-toggle]"); if (b) b.focus(); return; }
    if (el.dataset.filter) { ui.filter = el.dataset.filter; ui.limit = 60; render(); }
    if (el.hasAttribute("data-more")) { ui.limit += 60; render(); }
    if (el.hasAttribute("data-retry")) { memo.clear(); if (location.hash.includes("~")) location.hash = location.hash.split("~")[0]; else render(); }
    if (el.hasAttribute("data-run")) { const { arg } = parse(); runLive(await A.call(arg)); }
    const href = el.getAttribute("href");
    if (href && href.startsWith("#line-")) { e.preventDefault(); const t = document.getElementById(href.slice(1)); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });
  // Source popover: closes on Escape or a click elsewhere.
  document.addEventListener("click", (e) => { if (srcOpen && e.target.isConnected && !e.target.closest(".src-status")) { srcOpen = false; updateMode(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && srcOpen) { srcOpen = false; updateMode(); const b = document.querySelector("[data-src-toggle]"); if (b) b.focus(); } });
  document.addEventListener("change", (e) => { if (e.target.id === "st-filter") location.hash = "#patients" + (e.target.value === "all" ? "" : "-" + e.target.value); });
  document.addEventListener("toggle", (e) => { if (e.target.id === "today-year") ui.planOpen = e.target.open; }, true);
  let searchT;
  document.addEventListener("input", (e) => {
    if (e.target.id !== "search") return;
    ui.q = e.target.value;
    clearTimeout(searchT);
    searchT = setTimeout(async () => { await render(); const s = document.getElementById("search"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 200);
  });
  window.addEventListener("hashchange", () => { if (parse().route === "line") return; toast.hidden = true; window.scrollTo(0, 0); render().then(() => view.focus({ preventScroll: true })); });
  // Shared with call.js and ellie.js, which load after this file and add their own routes.
  window.P360 = { NAME, routes: {}, render, esc, fmtDate, pct, num, post, once, memo, A, MODS, SNAP, LIVE_URL, COPILOT_URL, statusPill, modChip, tagsHtml, loadingBox, errorBox, emptyBox, notFoundBox, friendly, forced, sourceBanner, showToast, notWired, parse,
    FAMILY, FLAG_TEXT, liveScore, lineHtml, flagBanner, cueTrigger, panelVisual, adviceCard, sortRows, current: () => current };

  // ------------------------------------------------------------------ coach name stamped on saved calls and hand-offs (no sign-in in the demo)
  let coachName = "";
  P360.coach = () => coachName || "Unknown coach";
  if (!SNAP) once("calls", A.calls).then((calls) => { const c = [...calls].sort((x, y) => String(x.coach.id).localeCompare(String(y.coach.id)))[0]; if (c) coachName = c.coach.name; }).catch(() => {});

  // ------------------------------------------------------------------ hand-off to the care team (POST /api/handoffs)
  async function handoffFrom(btn) {
    const { route, arg } = parse();
    const link = document.querySelector('.page-head a.btn[href^="#p-"]');
    const pid = btn.dataset.pid || (route === "live" ? arg : route === "p" ? arg.split(".")[0] : link ? link.getAttribute("href").slice(3) : "");
    if (!pid) { showToast("Open the patient’s page to hand off."); return; }
    const row = await once("roster", A.roster).then((r) => r.rows.find((x) => x.id === pid)).catch(() => null);
    const name = btn.dataset.name || (row && row.name) || pid, flag = btn.dataset.flag || (row && row.concern ? row.concern.text : "");
    const dlg = document.createElement("dialog");
    dlg.className = "card stack";
    dlg.style.cssText = "max-width:540px;width:calc(100% - 32px);border:0;border-radius:var(--r-lg);padding:24px;box-shadow:var(--sh-3)";
    dlg.innerHTML = `<h2>Hand off to the care team</h2><p class="small muted">${esc(name)} · from ${esc(P360.coach())}</p>${flag ? `<q>${esc(flag)}</q>` : ""}
      <label class="small stack-s">Note for the care team<textarea id="ho-note" rows="3" style="width:100%;font:inherit;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--surface);color:var(--ink);padding:8px 12px">${esc(`${flag ? `Patient said: “${flag}” ` : ""}Please review today and call the patient back.`)}</textarea></label>
      <div class="row"><button class="btn danger" data-ho-send>Send hand-off</button><button class="btn" data-ho-cancel>Cancel</button><span class="small muted" id="ho-state"></span></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", async (e) => {
      if (e.target.closest("[data-ho-cancel]")) return dlg.close();
      const send = e.target.closest("[data-ho-send]"); if (!send) return;
      send.disabled = true; dlg.querySelector("#ho-state").textContent = "Sending…";
      try {
        const h = await post("/api/handoffs", { patientId: pid, name, coach: P360.coach(), flag, note: dlg.querySelector("#ho-note").value.trim() });
        A.remember.handoff(h); memo.delete("roster"); memo.delete("p:" + pid); if (route === "p") memo.delete("p:" + arg.split(".")[0]);
        dlg.close();
        showToast(`${A.handoffLabel(h)} to the care team. ${A.shortName(name)} moves off Act today.`);
        if (btn.isConnected) btn.outerHTML = `<span class="tag t-good">✓ ${esc(A.handoffLabel(h))}</span>`;
        if (route !== "live") render(); // the live call keeps its transcript; the button above already shows the hand-off
      } catch (err) { send.disabled = false; dlg.querySelector("#ho-state").textContent = `Not sent. ${friendly(err.message)}`; }
    });
    dlg.showModal();
    dlg.querySelector("#ho-note").focus();
  }
  P360.routes.inbox = renderInbox;
  updateMode();
  Object.assign(window.P360, { cueHtml, flagList });
  window.addEventListener("DOMContentLoaded", render);
})();
