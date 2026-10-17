/* Patient 360. Plain JS, no build step. All module knowledge lives in adapters.js (window.Adapter);
   this file only renders the UI shape. Communication pattern (from the glucose team's page): one plain
   headline, a few KPI cards each with its target, then numbered "what to do" cards with the chart that
   backs each one beside it. Everything else is folded away. */
(function () {
  "use strict";
  const LIVE_URL = "https://patient-360.raava.dev";
  const COPILOT_URL = "https://coach.raava.dev";
  const SNAP = !!window.SNAPSHOT_ONLY;
  const A = window.Adapter;
  const MODS = A.MODULES;
  const view = document.getElementById("view");
  let previewState = "ready";
  const ui = { filter: "all", q: "", showOk: false };
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
  const statusLabel = { ok: "On track", watch: "Watch", alert: "Alert", today: "Act today" };
  const statusPill = (s) => `<span class="status ${s}">${statusLabel[s] || esc(s)}</span>`;
  const modChip = (m) => `<span class="chip m-${m}"><span class="dot"></span>${MODS[m].challenge} · ${MODS[m].name}</span>`;
  const tagsHtml = (tags) => (tags && tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag t-${esc(t.tone || "info")}">${esc(t.label)}</span>`).join("")}</span>` : "");
  const notWired = (what) => `data-toast="${esc(what)}: not connected to a scheduling or messaging system yet"`;
  const RANK = { today: 0, alert: 1, watch: 2, ok: 3 };
  const GROUP = { today: "Act today", alert: "Alert", watch: "Keep an eye on", ok: "On track" };

  function loadingBox(what) {
    return `<div class="stack" aria-busy="true" aria-label="Loading ${esc(what)}"><div class="sk" style="height:28px;width:40%"></div><div class="sk" style="height:16px;width:70%"></div>${'<div class="sk" style="height:72px"></div>'.repeat(3)}</div>`;
  }
  function emptyBox(text) { return `<div class="state-box"><h2>Nothing here yet</h2><p class="muted">${esc(text)}</p></div>`; }
  function errorBox(what, msg) {
    return `<div class="state-box error" role="alert"><h2>Couldn’t load ${esc(what)}</h2><p class="muted">${esc(msg || "The module didn’t answer.")}</p><div class="row"><button class="btn" data-retry>Try again</button>${SNAP ? `<a class="btn" href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a>` : ""}</div></div>`;
  }
  function forced(what, emptyText) {
    return previewState === "loading" ? loadingBox(what) : previewState === "empty" ? emptyBox(emptyText) : previewState === "error" ? errorBox(what, "HTTP 503 from the module (preview).") : null;
  }
  function sourceBanner(mods) {
    return mods.map((m) => A.health[m]).map((h, i) => {
      if (!h || h.source === "live") return "";
      const m = mods[i];
      return `<div class="banner warn" role="status"><span class="b-ico">!</span><div class="b-body"><b>${MODS[m].challenge} ${MODS[m].name} isn’t answering${h.error ? ` (${esc(h.error)})` : ""}.</b> ${h.source === "fallback" ? `Showing the saved copy${h.at ? " from " + esc(fmtDate(h.at)) : ""}.` : "No saved copy for this page."}</div></div>`;
    }).join("");
  }
  function updateMode() {
    const el = document.getElementById("mode");
    if (!el) return;
    if (SNAP) { el.innerHTML = `Saved copy of live data · <a href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a>`; return; }
    el.innerHTML = ["c3", "c4", "c5"].map((m) => { const h = A.health[m]; const s = !h ? "unknown" : h.source; return `<span class="src s-${s}" title="${esc(MODS[m].name)}: ${s === "live" ? "live" : s === "fallback" ? "saved copy" : s === "down" ? "down" : "not loaded yet"}">${MODS[m].challenge}</span>`; }).join("") + `<span class="src s-off" title="Hospital risk: not deployed yet">C1</span>`;
  }

  // ------------------------------------------------------------------ chart
  /* One chart primitive: shared x labels, line series (solid or dashed), optional CI band per series,
     horizontal reference lines, a shaded y band, tick marks on chosen x indices, hover readout. */
  // A chart that can't be drawn never takes the page down with it.
  function chart(o) {
    try { return drawChart({ ...o, series: (o.series || []).filter((s) => s && Array.isArray(s.values)).map((s) => ({ ...s, band: s.band && Array.isArray(s.band[0]) && Array.isArray(s.band[1]) ? s.band : null })) }); }
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
    const legend = o.series.length > 1 ? `<div class="legend">${o.series.map((s) => `<span><i style="border-top-color:${s.color};border-top-style:${s.dash ? "dashed" : s.dots ? "dotted" : "solid"}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
    return `<figure class="fig">${o.title ? `<figcaption><span>${esc(o.title)}</span>${o.note ? `<span class="muted">${esc(o.note)}</span>` : ""}</figcaption>` : ""}
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || o.title || "")}">${yband}${ticks}${bands}${refs}${ticksX}${lines}${ends}${xl}${hits}</svg>${legend}</figure>`;
  }

  function hbars(rows) {
    const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
    return `<div class="bars">${rows.map((r) => `<div class="bar-row"><span class="bl">${esc(r.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(1.5, (100 * Math.abs(r.value)) / max)}%;background:${r.color}"></span></span><span class="v">${esc(r.text)}</span></div>`).join("")}</div>`;
  }

  // ------------------------------------------------------------------ Today
  async function renderToday() {
    const head = `<header class="page-head"><div><h1>Today</h1><p class="sub">Every patient across the live programs, sorted by who needs a person first.</p></div></header>`;
    const f = forced("today’s list", "No patients are assigned to you yet.");
    if (f) return head + f;
    const { rows: items, failed } = await once("roster", A.roster);
    items.sort((a, b) => RANK[a.tri] - RANK[b.tri] || ["c5", "c3", "c4"].indexOf(a.mod) - ["c5", "c3", "c4"].indexOf(b.mod));
    const counts = { today: 0, alert: 0, watch: 0, ok: 0 };
    items.forEach((i) => counts[i.tri]++);
    const tiles = ["today", "alert", "watch", "ok"].map((k) => `<button class="sum-tile ${k}" data-jump="${k}"><span class="n">${counts[k]}</span><span class="l">${GROUP[k]}</span></button>`).join("");
    const perMod = ["c3", "c4", "c5"].map((m) => `<button class="fpill" aria-pressed="${ui.filter === m}" data-filter="${m}"><span class="dot m-${m}"></span>${MODS[m].name} <span class="cnt">${items.filter((x) => x.mod === m).length}</span></button>`).join("");
    const fails = failed.map((x) => `<div class="banner alert"><span class="b-ico">▲</span><div class="b-body"><b>${MODS[x.mod].challenge} ${MODS[x.mod].name} isn’t answering and has no saved copy.</b> <span class="small">${esc(x.error)}</span></div></div>`).join("");
    const q = ui.q.trim().toLowerCase();
    const shown = items.filter((x) => (ui.filter === "all" || x.mod === ui.filter) && (!q || (x.name + " " + x.headline + " " + x.id + " " + x.tags.map((t) => t.label).join(" ")).toLowerCase().includes(q)));
    let rows = "", last = null, hiddenOk = 0;
    for (const it of shown) {
      if (it.tri === "ok" && !ui.showOk && !q) { hiddenOk++; continue; }
      if (it.tri !== last) { rows += `<div class="r-group" id="g-${it.tri}">${GROUP[it.tri]}</div>`; last = it.tri; }
      rows += `<a class="r-row" href="#p-${esc(it.id)}" data-pid="${esc(it.id)}"><span class="sdot ${it.tri}" aria-hidden="true"></span>
        <span class="r-main"><span class="r-top"><b>${esc(it.name)}</b><span class="r-mod"><span class="dot m-${it.mod}"></span>${MODS[it.mod].name}</span></span>
        <span class="r-head">${esc(it.headline)}</span>${tagsHtml(it.tags)}</span>
        <span class="r-right">${statusPill(it.tri)}<span class="when">${fmtDate(it.updatedAt)}</span></span></a>`;
    }
    if (hiddenOk) rows += `<button class="r-more" data-showok>Show ${hiddenOk} on track</button>`;
    if (!rows) rows = `<div class="state-box">No patient matches “${esc(ui.q)}”.</div>`;
    return `${head}${fails}${sourceBanner(["c3", "c4", "c5"])}<div class="summary">${tiles}</div>
      <div class="toolbar"><input id="search" type="search" placeholder="Search name, ID or signal" value="${esc(ui.q)}" aria-label="Search patients">
        <div class="filters" role="group" aria-label="Filter by program"><button class="fpill" aria-pressed="${ui.filter === "all"}" data-filter="all">All <span class="cnt">${items.length}</span></button>${perMod}</div></div>
      <div class="roster" data-count="${items.length}">${rows}</div>
      <p class="footnote">Each program enrols its own synthetic cohort, so today a patient appears in one program. Dates are the last data each program holds.</p>`;
  }

  // ------------------------------------------------------------------ Patient 360
  const PILLS = [["overview", "Health chart"], ["c3", "Rough weeks"], ["c4", "Glucose"], ["c5", "Coaching calls"], ["c1", "Hospital risk"]];

  async function renderPatient360(arg) {
    const [id, tab = "overview"] = arg.split(".");
    const back = `<a class="back" href="#today">← Today</a>`;
    const f = forced("this patient", "No data for this patient yet. The page fills in after the first synced day.");
    if (f) return back + f;
    let p;
    try { p = await once("p:" + id, () => A.patient(id)); } catch (e) { return back + errorBox("this patient", e.message); }
    const pills = PILLS.map(([k, label]) => {
      const mine = k === "overview" || k === p.mod;
      const cls = `pill${k === tab ? " on" : ""}${mine ? "" : " off"}`;
      const dot = k !== "overview" ? `<span class="dot m-${k}"></span>` : "";
      return mine ? `<a class="${cls}" href="#p-${esc(id)}${k === "overview" ? "" : "." + k}" ${k === tab ? 'aria-current="page"' : ""}>${dot}${label}</a>`
        : `<span class="${cls}" title="${k === "c1" ? "Hospital risk is not deployed yet" : "Not enrolled in this program’s data"}" aria-disabled="true">${dot}${label}</span>`;
    }).join("");
    const factsLine = p.facts.slice(0, 7).map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join("");
    const head = `${back}<header class="p-head"><div class="stack-s"><div class="row"><h1>${esc(p.name)}</h1>${statusPill(p.tri)}</div><div class="facts">${factsLine}</div></div>
      <div class="row">${p.tri === "today" ? `<button class="btn danger" ${notWired("Escalate to care team")}>Escalate to care team</button>` : ""}<button class="btn" ${notWired("Schedule call")}>Schedule call</button><a class="btn" href="#app-${esc(id)}">Patient’s app</a></div></header>
      <nav class="pills" aria-label="Patient views">${pills}</nav>${sourceBanner([p.mod])}`;
    const body = tab === "overview" ? overview(p) : tab === p.mod ? moduleView(p) : notEnrolled(tab);
    const miss = p.missing && p.missing.length ? `<p class="footnote">Not in this program’s response yet: ${esc(p.missing.join("; "))}.</p>` : "";
    return head + body + miss;
  }

  function kpiCards(kpis) {
    return kpis.length ? `<div class="kpis">${kpis.map((k) => `<div class="kpi ${k.good == null ? "" : k.good ? "k-ok" : "k-bad"}"><div class="kl">${esc(k.label)}</div><div class="kv">${esc(k.value)}</div>${k.sub ? `<div class="ks">${esc(k.sub)}</div>` : ""}</div>`).join("")}</div>` : "";
  }
  function adviceCard(a, n) {
    return `<div class="a-text"><p class="basis t-${esc(a.tone || "info")}">${n ? n + " · " : ""}${esc(a.tag || "")}</p><h3>${esc(a.title)}</h3>${a.text ? `<p>${esc(a.text)}</p>` : ""}
      ${a.evidence && a.evidence.some((e) => e.value != null) ? `<p class="ev-chips">${a.evidence.filter((e) => e.value != null).map((e) => `<span class="echip" title="${esc(e.method || "")}">${esc(e.label)}: <b>${e.value == null ? "–" : num(e.value, 1)}${e.unit === "%" ? "%" : " " + esc(e.unit || "")}</b></span>`).join("")}</p>` : ""}</div>`;
  }
  function panelVisual(pn) {
    let h = "";
    if (pn.lead) h += `<p class="muted small">${esc(pn.lead)}</p>`;
    h += (pn.charts || []).filter(Boolean).map((c) => chart(c)).join("");
    for (const b of [pn.bars, pn.bars2]) if (b) h += `<div class="stack-s"><p class="fig-t">${esc(b.title)}</p><p class="muted small">${esc(b.note)}</p>${hbars(b.rows)}</div>`;
    if (pn.table) h += `<table class="tbl"><thead><tr>${pn.table.head.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${pn.table.rows.map((r) => `<tr>${r.map((x, i) => `<td class="${i ? "mono" : ""}">${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    if (pn.list) h += `<ul class="evidence">${pn.list.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    if (pn.calls) h += `<div class="calls-list">${pn.calls.map((c) => callRow(c, false)).join("")}</div>`;
    return h;
  }
  // Numbered "what to do" cards, advice left and its chart right; panels without advice fold into "More detail".
  function doCards(p, limit) {
    let n = 0;
    const withAdvice = p.panels.filter((pn) => pn.advice && pn.advice.length);
    const cards = withAdvice.slice(0, limit || 99).map((pn) => `<section class="card do ${pn.small ? "small" : ""}" id="pn-${esc(pn.id)}"><div class="do-text">${pn.advice.map((a) => adviceCard(a, ++n)).join("")}</div><div class="do-visual">${panelVisual(pn)}</div></section>`).join("");
    return cards;
  }
  function overview(p) {
    const first = doCards(p, 1);
    const allAdvice = p.panels.flatMap((pn) => pn.advice || []);
    const steps = allAdvice.length > 1 ? `<section class="card stack-s"><p class="eyebrow">All next steps</p><ol class="steps">${allAdvice.map((a) => `<li><b>${esc(a.title)}</b>${a.tag ? ` <span class="muted small">· ${esc(a.tag)}</span>` : ""}</li>`).join("")}</ol><a href="#p-${esc(p.id)}.${p.mod}">See each one with its chart →</a></section>` : "";
    return `<p class="big-hl">${esc(p.headline)}</p>${tagsHtml(p.tags)}${kpiCards(p.kpis)}
      ${p.reasons && p.reasons.length ? `<p class="muted small">Status set because ${esc(p.reasons.join("; "))}.</p>` : ""}
      ${first || (p.panels[0] ? `<section class="card">${panelVisual(p.panels[0])}</section>` : "")}${steps}`;
  }
  function moduleView(p) {
    const more = p.panels.filter((pn) => !pn.advice || !pn.advice.length);
    const moreHtml = more.length ? `<details class="more"><summary>More detail · ${more.map((pn) => esc(pn.title)).join(", ")}</summary>${more.map((pn) => `<section class="card stack"><h2>${esc(pn.title)}</h2><div class="${pn.small ? "multiples" : ""}">${panelVisual(pn)}</div></section>`).join("")}</details>` : "";
    const ev = p.evidence && p.evidence.length ? `<details class="more"><summary>Evidence behind every number</summary>${p.evidence.map((g) => `<details ${g.open ? "open" : ""} class="ev-g"><summary>${esc(g.group)} <span class="muted">(${g.rows.length})</span></summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Measure</th><th>Value</th><th>95% CI</th><th>n</th></tr></thead><tbody>${g.rows.map((r) => `<tr><td>${esc(r.label)}${r.caveat ? `<span class="cav">${esc(r.caveat)}</span>` : ""}</td><td class="mono">${esc(r.value)}</td><td class="mono">${esc(r.ci)}</td><td class="mono">${esc(r.n)}</td></tr>`).join("")}</tbody></table></div></details>`).join("")}</details>` : "";
    return `<div class="mod-head">${modChip(p.mod)}<p class="big-hl">${esc(p.headline)}</p></div>${kpiCards(p.kpis)}<h2 class="sec-t">What to do</h2>${doCards(p) || `<p class="muted">No actions from this program right now.</p>`}${moreHtml}${ev}${p.footnote ? `<p class="footnote">${esc(p.footnote)}</p>` : ""}`;
  }
  function notEnrolled(tab) {
    if (tab === "c1") return `<div class="state-box"><h2>Hospital risk isn’t live yet</h2><p class="muted">Challenge 1 is being built. When it deploys, this pill shows the chance of an ER visit or hospital stay next year, with its range and the factors behind it.</p></div>`;
    return `<div class="state-box"><h2>Not enrolled in ${esc(MODS[tab] ? MODS[tab].name : tab)}</h2><p class="muted">Each program uses its own cohort today, so this patient has no ${esc(MODS[tab] ? MODS[tab].short.toLowerCase() : "")} data. When the programs share one patient ID, this pill fills in.</p></div>`;
  }

  function callRow(c, withName) {
    return `<a class="c-row" href="#call-${esc(c.callId)}"><span>${withName ? `<b>${esc(c.participantName)}</b> · call ${c.callNumber}` : `<b>Call ${c.callNumber} · week ${c.week}</b>`}<span class="small muted" style="display:block">${fmtDate(c.date)} · coach ${esc(c.coach.name)} · ${esc(c.language)} · goal: ${esc(c.goalTopic)}</span></span>
      <span class="small">${c.flags.length ? (c.flags.length === 1 ? "1 line needs a person" : `${c.flags.length} lines need a person`) : `${c.lines} lines`}</span><span class="mono">${c.score ?? "–"}/100</span>${statusPill(triage("c5", c.status))}</a>`;
  }

  // ------------------------------------------------------------------ Calls
  async function renderCalls() {
    const head = `<header class="page-head"><div><h1>Calls</h1><p class="sub">Supervisor-labelled coaching calls, concerns first. Open one to run the live Copilot and compare it with the supervisor.</p></div>
      <a class="btn" href="${COPILOT_URL}" target="_blank" rel="noopener">Live Copilot ↗</a></header>`;
    const f = forced("calls", "No calls reviewed yet.");
    if (f) return head + f;
    let calls;
    try { calls = await once("calls", A.calls); } catch (e) { return head + errorBox("calls", e.message); }
    return `${head}${sourceBanner(["c5"])}<div class="calls-list">${calls.map((c) => callRow(c, true)).join("")}</div>`;
  }

  /* Call review: supervisor labels first; "Run live Copilot" sends each line through /api/c5/turn
     (Clef), low-confidence lines through /api/c5/review (GLM), and cue triggers through /api/c5/cue,
     using the same rules as the Copilot's own screen. */
  const FAMILY = { "open question": "q", "closed question": "q", "simple reflection": "r", "complex reflection": "r", affirm: "s", "seek collaboration": "s", "emphasize autonomy": "s", "ask permission": "s", "give information": "i", persuade: "x", confront: "x", other: "o" };
  const FLAG_TEXT = { medical: "Medical concern: tell the care team today", distress: "Emotional distress: check in and connect to support today", social: "Unmet basic need: connect to a navigator today", missed_concern: "Coach did not route a concern the participant raised", medical_advice: "Coach gave medical advice outside their role" };
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
    if (l.pending) liveTag = `<span class="tag pending">Copilot…</span>`;
    else if (l.live && l.live.error) liveTag = `<span class="tag bad" title="${esc(l.live.error)}">model error</span>`;
    else if (l.live && l.live.tag) {
      const want = l.speaker === "coach" ? l.supervisor.move : l.supervisor.talk;
      const ok = want ? l.live.tag === want : null;
      liveTag = `<span class="tag live ${ok === false ? "miss" : ""}" title="Copilot, confidence ${Math.round((l.live.confidence || 0) * 100)}%">${ok === true ? "✓ " : ok === false ? "≠ " : ""}Copilot: ${esc(l.live.tag)}${l.speaker === "participant" ? " talk" : ""}${l.live.reviewed ? " · GLM-checked" : ""}</span>`;
    }
    const lf = l.live && l.live.flag && l.live.flag !== "none" ? `<span class="tag flag live-flag">▲ Copilot: ${esc(l.live.flag.replace("_", " "))}</span>` : "";
    const cue = l.cue ? `<p class="cue"><b>Cue:</b> ${esc(l.cue.cue)}${l.cue.say ? ` <q>${esc(l.cue.say)}</q>` : ""}<span class="why">${esc(l.cue.trigger)}</span></p>` : "";
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
    const liveBtn = SNAP ? `<a class="btn primary" href="${LIVE_URL}/#call-${esc(c.callId)}" target="_blank" rel="noopener">Run live Copilot ↗</a><p class="small muted">This shared copy can’t call the model. The live console can.</p>`
      : `<button class="btn primary" data-run ${mine && live.running ? "disabled" : ""}>${mine && live.running ? `Tagging ${done} of ${c.lines.length}…` : mine && done ? "Run again" : "Run live Copilot"}</button>`;
    return `<aside class="call-side">
      <div class="card stack"><p class="eyebrow">Coach score</p>
        <div class="score-pair"><div><span class="n">${c.score ?? "–"}</span><span class="l">from supervisor labels</span></div><div><span class="n" id="live-score">${ls ?? "–"}</span><span class="l">from Copilot tags</span></div></div>${parts}
        <p class="small muted">MITI-style targets, same arithmetic as the Copilot screen.</p></div>
      <div class="card stack"><p class="eyebrow">Copilot vs supervisor</p>${liveBtn}
        ${a.mn || a.tn ? `<div class="agree" id="agree"><span><b>${pct(a.move)}</b> coach moves (${a.mn} lines)</span><span><b>${pct(a.talk)}</b> participant talk (${a.tn})</span><span><b>${pct(a.flag)}</b> needs-a-person calls (${a.fn})</span></div><p class="small muted">Experts agree with each other about 84% of the time on AnnoMI.</p>` : `<p class="small muted">Run the model to see how closely it matches the supervisor, line by line.</p>`}
        <a class="small" href="${COPILOT_URL}" target="_blank" rel="noopener">Tag a spoken call in the live Copilot ↗</a></div>
    </aside>`;
  }

  function flagBanner(x) {
    return `<div class="banner alert" role="alert"><span class="b-ico">▲</span><div class="b-body"><b>${esc(FLAG_TEXT[x.kind] || "A person must follow up today")}</b> <span class="small">· ${x.src} · ${esc(x.t)}</span><p class="small">“${esc(x.text)}”</p>
      <div class="b-actions"><button class="btn danger" ${notWired("Hand off to care team")}>Hand off to care team</button><a class="btn" href="#line-${x.line}">Jump to line ${x.line}</a></div></div></div>`;
  }

  async function renderCall(id) {
    const back = `<a class="back" href="#calls">← Calls</a>`;
    const f = forced("this call", "This call has no lines yet. For a live call, lines appear as people speak.");
    if (f) return back + f;
    let c;
    try { c = await Adapter.call(id); } catch (e) { return back + errorBox("this call", e.message); }
    const lines = live && live.callId === c.callId ? live.lines : c.lines;
    // Supervisor labels say only "needs a person"; the kind comes from the live model when it has run.
    const banners = c.flags.map((x) => flagBanner({ ...x, kind: null, src: "Supervisor" }))
      .concat(lines.filter((l) => l.live && l.live.flag && l.live.flag !== "none").map((l) => flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Copilot" }))).join("");
    return `${back}<header class="page-head"><div><p class="eyebrow">${modChip("c5")}</p><h1>${esc(c.participantName)} · call ${c.callNumber}</h1>
      <div class="facts"><span>Coach <b>${esc(c.coach.name)}</b> (${esc(c.coach.role)})</span><span>Week <b>${c.week}</b></span><span><b>${fmtDate(c.date)}</b> ${esc(c.start)}</span><span>${esc(c.language)}</span><span>Goal <b>${esc(c.goalTopic)}</b></span><span><b>${c.durationMin}</b> min</span></div></div>
      <a class="btn" href="#p-${esc(c.survivorId)}">Patient page</a></header>
      <div id="flagbox" class="stack">${banners}</div>
      <div class="call-layout"><section class="card"><div class="sec-head"><h2>Transcript</h2><p class="small muted">Grey tag = supervisor label. Outlined tag = live Copilot (✓ agrees, ≠ differs).</p></div><div class="transcript" id="transcript">${lines.map((l) => lineHtml(l, c.coach.name)).join("")}</div></section>
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
      if (l.live.flag && l.live.flag !== "none") { const box = document.getElementById("flagbox"); if (box && live === L) box.insertAdjacentHTML("beforeend", flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Copilot" })); }
      side();
    }
    L.running = false;
    side();
  }

  function cueCheck(L, i, coachName) {
    const l = L.lines[i], lines = L.lines.slice(0, i + 1);
    if (!l.live || !l.live.tag) return;
    const coachCount = lines.filter((x) => x.speaker === "coach").length;
    let trigger = null;
    const f = l.live.flag;
    if (f === "missed_concern") trigger = "The participant raised a concern and the coach moved on without routing it.";
    else if (f === "medical_advice") trigger = "The coach just gave medical advice outside their role.";
    else if (f && f !== "none") trigger = `The participant raised a ${f} concern.`;
    else if (l.speaker === "coach") {
      const coach = lines.filter((x) => x.speaker === "coach" && x.live && x.live.tag);
      const last = coach.slice(-4).map((x) => x.live.tag), before = lines[i - 1];
      if (l.live.tag === "confront") trigger = "The coach just confronted the participant.";
      else if (l.live.tag === "persuade" && !coach.slice(-3, -1).some((x) => x.live.tag === "ask permission")) trigger = "The coach told the participant what to do without asking permission.";
      else if (before && before.speaker === "participant" && before.live && before.live.tag === "change" && FAMILY[l.live.tag] !== "r" && l.live.tag !== "affirm") trigger = "The participant voiced change talk and the coach did not reflect or affirm it.";
      else if (last.length === 4 && last.every((t) => FAMILY[t] === "q")) trigger = "Four questions in a row without a reflection.";
      else if (last.length >= 3 && last.slice(-3).every((t) => t === "closed question")) trigger = "Three closed questions in a row.";
      if (trigger && coachCount - L.lastCueAt < 3) trigger = null;
    }
    if (!trigger) return;
    L.lastCueAt = coachCount;
    const recent = lines.slice(-8).map((x) => ({ speaker: x.speaker, text: x.text, tag: x.live && x.live.tag }));
    post("/api/c5/cue", { trigger, recent }).then((r) => {
      if (!r.cue || live !== L) return;
      l.cue = { ...r, trigger };
      const el = document.getElementById("line-" + l.n); if (el) el.outerHTML = lineHtml(l, coachName);
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ Patient's app (what the patient sees)
  async function renderApp(id) {
    const head = `<header class="page-head"><div><h1>Patient’s app</h1><p class="sub">What the patient sees on their phone: one thing at a time, in plain words, from their own data. No scores and no risk labels.</p></div></header>`;
    const f = forced("their plan", "No advice yet. The first tip appears after a week of meal logs or wearable data.");
    if (f) return head + f;
    if (!id) { try { const r = await once("roster", A.roster); const first = r.rows.find((x) => x.mod === "c4") || r.rows[0]; id = first.id; } catch (e) { return head + errorBox("their plan", e.message); } }
    let p;
    try { p = await once("p:" + id, () => A.patient(id)); } catch (e) { return head + errorBox("their plan", e.message); }
    const lang = (p.facts.find(([k]) => k === "Language") || [])[1] || "English";
    let cards = "";
    if (p.mod === "c4") {
      const ai = await A.advice(id).catch(() => null);
      const recs = ai || p.panels.flatMap((pn) => pn.advice).map((a) => ({ title: a.title, text: a.text, rule: a.tone === "risk" }));
      const rules = recs.filter((r) => r.rule), tips = recs.filter((r) => !r.rule);
      cards = rules.concat(tips).map((r) => `<div class="p-card ${r === tips[0] ? "focus" : ""}"><p class="eyebrow">${r.rule ? "Check with your care team" : r === tips[0] ? "This week’s focus" : "Also try"}</p><p class="big">${esc(r.title)}</p><p class="why">${esc(r.text)}</p>${r.rule ? "" : `<label class="check"><input type="checkbox"> Done this week</label>`}</div>`).join("");
      if (ai) cards += `<p class="small muted">Plain-language text by Workers AI, checked against the evidence; ${ai.filter((x) => x.source === "template").length} kept as written.</p>`;
    } else if (p.mod === "c3") {
      const rough = p.status !== "ok";
      cards = `<div class="p-card focus"><p class="eyebrow">This week</p><p class="big">${rough ? "Your body may need more rest in the next few days." : "You’re close to your usual. Keep your routine."}</p><p class="why">${rough ? "Your watch shows changes from your usual. Rest is OK. Short walks around the house count. Your coach will call to check in." : "Short daily walks and a steady bedtime help on treatment weeks."}</p></div>
        <div class="p-card"><p class="eyebrow">Call your care team now if</p><p class="why">You have a fever of 100.4°F or higher, chills, shortness of breath, or can’t keep food or fluids down.</p></div>`;
    } else {
      cards = `<div class="p-card focus"><p class="eyebrow">Your coach</p><p class="big">Your next call is with your coach.</p><p class="why">Bring one thing that went well this week and one thing that was hard.</p></div>`;
    }
    const phone = `<div class="phone" aria-label="Patient phone preview"><div class="row" style="justify-content:space-between"><h2>Good morning</h2><span class="chip">${esc(lang)}</span></div>
      ${lang !== "English" ? `<p class="small notice">Shown in English. ${esc(lang)} text is pending from the program.</p>` : ""}
      ${cards}<div class="p-card"><button class="btn primary" ${notWired("Message your coach")}>Message your coach</button></div>
      <p class="small muted">General guidance from your coaching program, not medical advice. For fever, chest pain or trouble breathing, call your care team now.</p></div>`;
    const notes = `<div class="notes-side stack"><h2>${esc(p.name)}</h2><p class="muted">${p.mod === "c4" ? "Cards are the glucose program’s own advice for this person, rewritten in plain words when the AI check passes. Safety rules come first." : p.mod === "c3" ? "Rough-weeks advice is written for the coach, so the patient sees a softer card and the fever rule. The program should send patient-facing text." : "The calls program has no patient-facing text yet."}</p>
      <a class="btn" href="#p-${esc(id)}">Back to their 360</a></div>`;
    return `${head}<div class="phone-wrap">${phone}${notes}</div>`;
  }

  // ------------------------------------------------------------------ later
  function renderCare() {
    return `<header class="page-head"><div><p class="eyebrow">Later · Challenge 1</p><h1>Hospital risk</h1><p class="sub">For the care-team lead: which patients are likely to need an ER visit or hospital stay next year, from survey answers plus clinical records.</p></div><span class="chip m-c1"><span class="dot"></span>Being built</span></header>
      <div class="grid-2"><section class="card stack"><h2>Where it will show</h2><ul class="evidence"><li>A “Hospital risk” pill on every patient’s 360.</li><li>A risk tag on each Today row.</li><li>A care-team list sorted by risk, with a fairness view by age, sex, ethnicity, insurance and cancer type.</li></ul></section>
      <section class="card stack"><h2>Rules for showing it</h2><ul class="evidence"><li>The survey and the clinical records share no patient key. Show how confident the link is.</li><li>Show a probability with its range, never a red or green verdict.</li><li>Factors are associations, not causes.</li></ul></section></div>`;
  }
  function renderResearch() {
    return `<header class="page-head"><div><p class="eyebrow">Later · Challenges 6 and 7</p><h1>Research</h1><p class="sub">Drug discovery for lab scientists. A separate area with its own data and permissions; it never mixes with patient data.</p></div><span class="chip"><span class="dot"></span>Not built yet</span></header>`;
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
    if (route === "patient") route = "app";
    return { route, arg, st };
  }
  let renderSeq = 0;
  async function render() {
    const { route, arg, st } = parse();
    if (route === "line") return;
    previewState = st || "ready";
    const seq = ++renderSeq;
    const nav = { p: "today", call: "calls" }[route] || route;
    document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
    if (view.dataset.ready !== route + arg) view.innerHTML = loadingBox("page");
    let html;
    try {
      if (route === "today") html = await renderToday();
      else if (route === "p") html = arg ? await renderPatient360(arg) : await renderToday();
      else if (route === "calls") html = await renderCalls();
      else if (route === "call") html = await renderCall(arg);
      else if (route === "app") html = await renderApp(arg);
      else if (route === "care") html = renderCare();
      else if (route === "research") html = renderResearch();
      else html = emptyBox("This page doesn’t exist. Use the navigation to get back.");
    } catch (e) { console.warn(e); html = errorBox("this page", e.message); }
    if (seq !== renderSeq) return;
    view.innerHTML = html;
    view.dataset.ready = route + arg;
    view.dataset.state = previewState;
    updateMode();
  }

  // ------------------------------------------------------------------ events
  const toast = document.getElementById("toast");
  let toastT;
  function showToast(msg) { toast.textContent = msg; toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (toast.hidden = true), 3200); }
  const tip = document.getElementById("tip");
  document.addEventListener("pointermove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t && t.dataset.tip) { tip.textContent = t.dataset.tip; tip.hidden = false; tip.style.left = Math.min(e.clientX + 12, innerWidth - 280) + "px"; tip.style.top = e.clientY + 14 + "px"; } else tip.hidden = true;
  });
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("button, a");
    if (!el) return;
    if (el.dataset.toast) showToast(el.dataset.toast);
    if (el.dataset.filter) { ui.filter = el.dataset.filter; render(); }
    if (el.hasAttribute("data-showok")) { ui.showOk = true; render(); }
    if (el.dataset.jump) { if (el.dataset.jump === "ok" && !ui.showOk) { ui.showOk = true; await render(); } const g = document.getElementById("g-" + el.dataset.jump); if (g) g.scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (el.hasAttribute("data-retry")) { memo.clear(); if (location.hash.includes("~")) location.hash = location.hash.split("~")[0]; else render(); }
    if (el.hasAttribute("data-run")) { const { arg } = parse(); runLive(await A.call(arg)); }
    const href = el.getAttribute("href");
    if (href && href.startsWith("#line-")) { e.preventDefault(); const t = document.getElementById(href.slice(1)); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });
  let searchT;
  document.addEventListener("input", (e) => {
    if (e.target.id !== "search") return;
    ui.q = e.target.value;
    clearTimeout(searchT);
    searchT = setTimeout(async () => { await render(); const s = document.getElementById("search"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 200);
  });
  window.addEventListener("hashchange", () => { if (parse().route === "line") return; toast.hidden = true; window.scrollTo(0, 0); render().then(() => view.focus({ preventScroll: true })); });
  updateMode();
  render();
})();
