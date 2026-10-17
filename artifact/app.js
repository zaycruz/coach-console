/* Coach Console prototype. Plain JS, hash routes, no build step.
   Data: window.MOCK from mock-data.js, shaped like the module contract
   (GET /api/<c3|c4|c5>/survivors and /survivors/:id, plus GET /api/c5/calls/:id). */
(function () {
  "use strict";
  const M = window.MOCK;
  const MODS = { c3: "Bad Week Radar", c4: "Dose and Timing", c5: "Coach's Copilot" };
  const MOD_SHORT = { c3: "Wearables", c4: "Meals & glucose", c5: "Calls" };
  const RANK = { today: 0, alert: 1, watch: 2, ok: 3 };
  const GROUP = { today: "Act today", alert: "Rough patch likely", watch: "Keep an eye on", ok: "On track" };
  const view = document.getElementById("view");
  const stateSel = document.getElementById("state-select");
  let previewState = "ready";
  let rosterFilter = "all";
  let lang = "en";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  const statusLabel = { ok: "On track", watch: "Watch", alert: "Alert", today: "Act today" };
  const statusPill = (s) => `<span class="status ${s}">${statusLabel[s]}</span>`;
  const modChip = (m, extra = "") => `<span class="chip m-${m} ${extra}"><span class="dot"></span>${m.toUpperCase()} · ${MOD_SHORT[m]}</span>`;

  document.getElementById("asof").textContent = "Data as of " + fmtTime(M.asOf);

  // Triage rule (DESIGN.md §4): a C5 "needs a person" flag outranks everything; then alert > watch > ok.
  function triage(mod, item) {
    if (mod === "c5" && item.status === "alert") return "today";
    return item.status;
  }

  function rosterItems() {
    const items = [];
    for (const m of ["c3", "c4", "c5"]) {
      for (const it of M.modules[m].list) items.push({ mod: m, ...it, tri: triage(m, it) });
    }
    items.sort((a, b) => RANK[a.tri] - RANK[b.tri] || ["c5", "c3", "c4"].indexOf(a.mod) - ["c5", "c3", "c4"].indexOf(b.mod));
    return items;
  }

  // ------------------------------------------------------------------ states
  function stateView(kind, what) {
    if (kind === "loading") {
      return `<div class="stack" aria-busy="true" aria-label="Loading ${esc(what)}">
        <div class="sk" style="height:28px;width:40%"></div>
        <div class="sk" style="height:16px;width:70%"></div>
        ${Array.from({ length: 5 }, () => '<div class="sk" style="height:56px"></div>').join("")}
      </div>`;
    }
    if (kind === "empty") {
      return `<div class="state-box"><h2>Nothing here yet</h2><p class="muted">${esc(what)}</p></div>`;
    }
    return `<div class="state-box error" role="alert"><h2>Couldn’t load ${esc(what)}</h2>
      <p class="muted">The module didn’t answer (HTTP 503 from /api/…). Other modules still work. Try again, or open the module directly.</p>
      <button class="btn" data-retry>Try again</button></div>`;
  }

  // ------------------------------------------------------------------ Today
  function renderToday() {
    const head = `<div class="page-head"><div><p class="eyebrow">Morning triage</p><h1>Today</h1>
      <p class="sub">Everyone in the three demo cohorts, sorted by what needs a person first. Each row shows which module raised it.</p></div></div>`;
    if (previewState !== "ready") return head + stateView(previewState, previewState === "empty" ? "No survivors are assigned to you yet. New enrolments appear here the morning after their first synced day." : "today’s roster");
    const items = rosterItems();
    const counts = { today: 0, alert: 0, watch: 0, ok: 0 };
    items.forEach((i) => counts[i.tri]++);
    const tiles = ["today", "alert", "watch", "ok"].map((k) => `<button class="sum-tile ${k}" data-jump="${k}"><span class="n">${counts[k]}</span><span class="l">${GROUP[k]}</span></button>`).join("");
    const filters = ["all", "c3", "c4", "c5"].map((f) => `<button class="chip ${f !== "all" ? "m-" + f : ""}" aria-pressed="${rosterFilter === f}" data-filter="${f}">${f !== "all" ? '<span class="dot"></span>' : ""}${f === "all" ? "All modules" : f.toUpperCase() + " · " + MODS[f]}</button>`).join("");
    const comp = M.composite;
    let rows = `<div class="r-group">Product preview</div>
      <a class="r-row s-alert" href="#/s/demo"><span class="stripe"></span>
        <span class="r-name">${esc(comp.displayName)}<span class="meta">Illustrative · one record from each module</span></span>
        <span class="r-head"><span class="h">See all three modules on one survivor page</span><span class="row">${["c3", "c4", "c5"].map((m) => modChip(m, "illustrative")).join("")}</span></span>
        <span class="r-right"><span class="chip illustrative">Illustrative</span></span></a>`;
    let last = null;
    for (const it of items) {
      if (rosterFilter !== "all" && it.mod !== rosterFilter) continue;
      if (it.tri !== last) { rows += `<div class="r-group" id="g-${it.tri}">${GROUP[it.tri]}</div>`; last = it.tri; }
      rows += `<a class="r-row s-${it.tri}" href="#/s/${it.mod}/${it.survivorId}"><span class="stripe"></span>
        <span class="r-name">${esc(it.displayName)}<span class="meta">${esc(MODS[it.mod])} cohort</span></span>
        <span class="r-head"><span class="h">${esc(it.headline)}</span><span class="row">${modChip(it.mod)}</span></span>
        <span class="r-right">${statusPill(it.tri)}<span class="when">${fmtTime(it.updatedAt)}</span></span></a>`;
    }
    return `${head}<div class="summary">${tiles}</div>
      <div class="banner note"><span class="b-ico">i</span><div class="b-body small">The three challenge datasets are different made-up people with no shared patient key, so each row belongs to one module’s demo cohort. When modules share a key, one person gets one row with several module chips.</div></div>
      <div class="filters" role="group" aria-label="Filter by module">${filters}</div>
      <div class="roster">${rows}</div>`;
  }

  // ------------------------------------------------------------------ charts (inline SVG)
  function lineChart(points, opt) {
    // points: [{x: index, y: value|null, label, tip}]
    const W = 320, H = opt.h || 70, pl = 34, pr = 8, pt = 8, pb = 16;
    const ys = points.map((p) => p.y).filter((v) => v != null).concat(opt.base != null ? [opt.base] : [], opt.thr != null ? [opt.thr] : []);
    if (!ys.length) return `<p class="small muted">No readings in this window (watch not worn).</p>`;
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (opt.min != null) lo = Math.min(lo, opt.min);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const n = points.length;
    const X = (i) => pl + (i * (W - pl - pr)) / Math.max(1, n - 1);
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    let d = "", pen = false;
    points.forEach((p, i) => { if (p.y == null) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.y).toFixed(1); pen = true; });
    const recent = opt.recent ? `<rect class="recent" x="${X(n - opt.recent) - 4}" y="${pt}" width="${X(n - 1) - X(n - opt.recent) + 8}" height="${H - pt - pb}"/>` : "";
    const base = opt.base != null ? `<line class="base" x1="${pl}" x2="${W - pr}" y1="${Y(opt.base)}" y2="${Y(opt.base)}"/>` : "";
    const thr = opt.thr != null ? `<line class="thr" x1="${pl}" x2="${W - pr}" y1="${Y(opt.thr)}" y2="${Y(opt.thr)}"/><text x="${W - pr}" y="${Y(opt.thr) - 3}" text-anchor="end">${opt.thr}</text>` : "";
    const ticks = [lo + pad, hi - pad].map((v) => `<text x="${pl - 4}" y="${Y(v) + 3}" text-anchor="end">${opt.fmt ? opt.fmt(v) : Math.round(v)}</text><line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("");
    const xl = (opt.xlabels || []).map(([i, t]) => `<text x="${X(i)}" y="${H - 3}" text-anchor="middle">${esc(t)}</text>`).join("");
    const marks = (opt.marks || []).map((m) => `<g><path d="M${X(m.i)},${pt + 1} l-4,-6 h8 z" fill="${m.color}"/><text class="lbl" x="${X(m.i)}" y="${pt - 8}" text-anchor="middle">${esc(m.label)}</text></g>`).join("");
    const last = [...points].reverse().find((p) => p.y != null);
    const li = points.lastIndexOf(last);
    const dot = last ? `<circle cx="${X(li)}" cy="${Y(last.y)}" r="3.5" fill="${opt.color}" stroke="var(--surface)" stroke-width="2"/>` : "";
    const hits = points.map((p, i) => `<rect x="${X(i) - (W - pl - pr) / n / 2}" y="0" width="${(W - pl - pr) / n}" height="${H}" fill="transparent" data-tip="${esc(p.tip || "")}"/>`).join("");
    return `<svg class="chart" viewBox="0 ${opt.marks ? -18 : 0} ${W} ${H + (opt.marks ? 18 : 0)}" role="img" aria-label="${esc(opt.aria || "")}">
      ${recent}${ticks}${base}${thr}<path d="${d}" fill="none" stroke="${opt.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dot}${marks}${xl}${hits}</svg>`;
  }

  // ------------------------------------------------------------------ module panels
  function emptyPanel(m) {
    return `<section class="card panel m-${m}"><div class="panel-head"><div><p class="eyebrow">${m.toUpperCase()} · ${MODS[m]}</p></div></div>
      <div class="empty-module"><b>Not in the ${MODS[m]} demo cohort.</b>
      <span>The challenge datasets are separate made-up people. When this module shares a patient key with the others, its panel fills in here.</span></div></section>`;
  }

  function panelC3(d) {
    const days = d.charts.days, b = d.charts.baseline;
    const xl = [[0, days[0].date.slice(5)], [days.length - 1, "today"]];
    const marks = [];
    days.forEach((x, i) => { if (x.treatment) marks.push({ i, label: "Tx", color: "var(--m-c3)" }); if (x.event) marks.push({ i, label: "!", color: "var(--alert)" }); });
    const series = [
      ["steps", "Steps", b.steps, (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v))],
      ["sleep", "Sleep (min)", b.sleep_minutes],
      ["rhr", "Resting HR (bpm)", b.resting_heart_rate],
      ["feeling", "Daily check-in (1–5)", b.daily_feeling_1_to_5],
    ];
    const minis = series.map(([k, label, base, fmt], idx) => {
      const pts = days.map((x) => ({ y: x[k], tip: `${x.date}: ${x[k] == null ? "no reading" : Math.round(x[k]).toLocaleString()} ${label.replace(/ \(.*\)/, "")}${x.event ? " · " + x.event : ""}${x.treatment ? " · treatment day" : ""}` }));
      const lastv = [...days].reverse().find((x) => x[k] != null);
      return `<div><div class="mini-title"><span>${label}</span><span>usual <b>${base == null ? "–" : Math.round(base).toLocaleString()}</b> · now <b>${lastv ? Math.round(lastv[k]).toLocaleString() : "–"}</b></span></div>
        ${lineChart(pts, { color: "var(--m-c3)", base, recent: 3, xlabels: xl, fmt, marks: idx === 0 ? marks : null, aria: `${label}, last 28 days, with usual level dashed` })}</div>`;
    }).join("");
    const hind = d.hindsight && d.hindsight.length ? `<div class="banner note small"><span class="b-ico">↺</span><div class="b-body"><b>Hindsight (demo only):</b> in the synthetic data, the next 5 days held: ${esc(d.hindsight.join("; "))}. The radar used only the days up to “today”.</div></div>` : "";
    return `<section class="card panel m-c3" id="panel-c3">
      <div class="panel-head"><div><p class="eyebrow">C3 · Bad Week Radar</p><p class="headline">${esc(d.headline)}</p></div>${statusPill(d.status)}</div>
      <p class="small muted">${esc(d.summary)}</p>
      <div class="legend"><span><i class="dash"></i>their usual (prior 28 days)</span><span><i class="box"></i>last 3 days</span><span>▼ Tx treatment day · ! clinical event</span></div>
      <div class="mini">${minis}</div>
      <div><h3>Why</h3><ul class="evidence">${d.evidence.map((e) => `<li>${esc(e.text)}</li>`).join("")}</ul></div>
      ${hind}
      ${recsBlock(d.recommendations)}
    </section>`;
  }

  function panelC4(d) {
    const day = d.charts.day;
    const toMin = (t) => { const [h, m] = t.split(":").map(Number); return ((h < 4 ? h + 24 : h) - 4) * 60 + m; };
    const pts = day.curve.map((c) => ({ y: c.g, tip: `${c.t} · ${c.g} mg/dL` }));
    const n = pts.length;
    const marks = day.meals.map((ml) => ({ i: Math.min(n - 1, Math.round(toMin(ml.t) / 15)), label: ml.type === "dinner" ? "Dinner " + ml.t : ml.type[0].toUpperCase(), color: ml.type === "dinner" || ml.type === "late snack" ? "var(--m-c4)" : "var(--ink-3)" }));
    const xl = [[0, "4am"], [Math.round(n / 3), "noon"], [Math.round((2 * n) / 3), "8pm"], [n - 1, "4am"]];
    const chart = lineChart(pts, { color: "var(--m-c4)", thr: 140, xlabels: xl, marks, h: 110, aria: "Blood sugar over one day with meals marked; dashed red line at 140 mg/dL" });
    const maxv = Math.max(...d.charts.compare.map((c) => c.value), 1);
    const bars = d.charts.compare.map((c) => `<div class="bar-row"><span>${esc(c.label)} <span class="muted small">(${c.n})</span></span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(2, (100 * c.value) / maxv)}%"></span></span><span class="v">+${c.value}</span></div>`).join("");
    return `<section class="card panel m-c4" id="panel-c4">
      <div class="panel-head"><div><p class="eyebrow">C4 · Dose and Timing</p><p class="headline">${esc(d.headline)}</p></div>${statusPill(d.status)}</div>
      <p class="small muted">${esc(d.summary)}</p>
      <div><div class="mini-title"><span>Blood sugar on ${esc(day.date)} (mg/dL)</span><span>${esc((day.meals.find((m) => m.type === "dinner") || {}).food || "")}</span></div>${chart}
        <div class="legend"><span><i class="red"></i>140 mg/dL, top of the after-meal range</span><span>▼ meal start</span></div></div>
      <div><div class="mini-title"><span>Average 2-hour rise after dinner (mg/dL)</span></div><div class="bars">${bars}</div></div>
      <div><h3>Why</h3><ul class="evidence">${d.evidence.map((e) => `<li>${esc(e.text)}</li>`).join("")}</ul></div>
      <p class="caveat">${esc(d.caveat)}</p>
      ${recsBlock(d.recommendations)}
    </section>`;
  }

  function panelC5(d) {
    const call = M.calls[d.charts.latestCallId];
    const flags = call.flags.map((f) => `<div class="banner alert"><span class="b-ico">▲</span><div class="b-body"><b>${esc(f.kind[0].toUpperCase() + f.kind.slice(1))} · a person must follow up today</b><p class="small">${esc(f.t)} “${esc(f.text)}”</p></div></div>`).join("");
    return `<section class="card panel m-c5" id="panel-c5">
      <div class="panel-head"><div><p class="eyebrow">C5 · Coach’s Copilot</p><p class="headline">${esc(d.headline)}</p></div>${statusPill(d.status === "alert" ? "today" : d.status)}</div>
      <p class="small muted">${esc(d.summary)}</p>
      ${flags}
      <div class="row" style="justify-content:space-between"><div class="score-big"><span class="n">${call.score}</span><span class="muted">/100 coach score</span></div>
        <a class="btn" href="#/call/${call.callId}">Review call →</a></div>
      ${scoreParts(call)}
      <p class="small muted">Call ${call.callNumber}, week ${call.week} · ${esc(call.date)} · ${esc(call.language)} · goal: ${esc(call.goalTopic)} · ${call.durationMin} min</p>
      ${recsBlock(d.recommendations)}
    </section>`;
  }

  function scoreParts(call) {
    const names = { reflectionsPerQuestion: "Reflections per question", complexReflectionPct: "Complex reflections %", openQuestionPct: "Open questions %", miConsistent: "MI-consistent vs persuade/confront" };
    return `<div class="stack">${Object.entries(call.scoreParts).map(([k, p]) => `<div class="part"><span>${names[k]} <span class="muted mono">${esc(p.value)} (target ${esc(p.target)})</span></span><span class="mono">${p.points}/${p.max}</span><span class="track"><span class="fill" style="display:block;width:${(100 * p.points) / p.max}%"></span></span></div>`).join("")}</div>`;
  }

  function recsBlock(recs) {
    return `<div><h3>Next steps</h3><div class="recs">${recs.map((r) => `<div class="rec"><span class="aud ${r.audience}">${r.audience === "survivor" ? "For survivor" : "For coach"}</span><span>${esc(r.text)}</span></div>`).join("")}</div></div>`;
  }

  // ------------------------------------------------------------------ Survivor
  function renderSurvivor(mod, id) {
    const isDemo = mod === "demo";
    const parts = isDemo ? M.composite.parts : { [mod]: id };
    const firstMod = isDemo ? "c5" : mod;
    const det = M.modules[firstMod] && M.modules[firstMod].detail[parts[firstMod]];
    if (!det && previewState === "ready") return stateView("error", "this survivor") ;
    const listItem = !isDemo && M.modules[mod].list.find((x) => x.survivorId === id);
    const title = isDemo ? M.composite.displayName : listItem.displayName;
    const p = det ? det.profile : {};
    const facts = isDemo
      ? `<span>C3 record <b>${parts.c3}</b></span><span>C4 record <b>${parts.c4}</b></span><span>C5 record <b>${parts.c5}</b></span>`
      : `<span>Age <b>${p.age}</b></span><span>Sex <b>${esc(p.sex)}</b></span><span>Cancer <b>${esc(p.cancer)}</b></span><span>Language <b>${esc(p.language)}</b></span>${p.treatment ? `<span>Treatment <b>${esc(p.treatment)}</b></span>` : ""}${p.livesAlone ? `<span>Lives alone <b>${esc(p.livesAlone)}</b></span>` : ""}${p.group ? `<span>Group <b>${esc(p.group)}</b></span>` : ""}${p.coach ? `<span>Coach <b>${esc(p.coach)}</b></span>` : ""}`;
    const head = `<div class="page-head person-head"><div><a class="small" href="#/today">← Today</a><h1>${esc(title)}</h1><div class="facts">${facts}</div></div>
      <div class="row">${isDemo ? '<span class="chip illustrative">Illustrative</span>' : ""}<a class="btn" href="#/patient/${isDemo ? "demo" : mod + "/" + id}">Survivor’s view</a></div></div>`;
    if (previewState !== "ready") return head + stateView(previewState, previewState === "empty" ? "No module has data for this survivor yet. Panels fill in after the first synced wearable day, meal log or call." : "this survivor");
    const note = isDemo ? `<div class="banner note"><span class="b-ico">i</span><div class="b-body small">${esc(M.composite.note)}</div></div>` : "";
    const panel = (m) => {
      const sid = parts[m];
      if (!sid) return emptyPanel(m);
      const d = M.modules[m].detail[sid];
      return m === "c3" ? panelC3(d) : m === "c4" ? panelC4(d) : panelC5(d);
    };
    const order = isDemo ? ["c5", "c3", "c4"] : [mod, ...["c5", "c3", "c4"].filter((m) => m !== mod)];
    const anyToday = Object.entries(parts).some(([m, sid]) => m === "c5" && M.modules.c5.detail[sid].status === "alert");
    const act = `<div class="act-bar">${anyToday ? '<button class="btn danger" data-toast="Escalation sent to the care team (mock)">Escalate to care team</button>' : ""}
      <button class="btn primary" data-toast="Call scheduled for today 2:00 pm (mock)">Schedule call</button>
      <button class="btn" data-toast="Check-in text drafted in their language (mock)">Send check-in text</button>
      <span class="spacer"></span><button class="btn" data-toast="Marked reviewed for today (mock)">Mark reviewed</button></div>`;
    return `${head}${act}${note}<div class="panels">${order.map(panel).join("")}</div>`;
  }

  // ------------------------------------------------------------------ Calls
  function renderCalls() {
    const head = `<div class="page-head"><div><p class="eyebrow">C5 · Coach’s Copilot</p><h1>Calls</h1><p class="sub">Every reviewed call, flags first. Open one to see each line tagged with its motivational-interviewing move.</p></div></div>`;
    if (previewState !== "ready") return head + stateView(previewState, previewState === "empty" ? "No calls reviewed yet. Recorded and live calls appear here as soon as the Copilot tags their first line." : "calls");
    const calls = Object.values(M.calls).sort((a, b) => b.flags.length - a.flags.length || a.score - b.score);
    const rows = calls.map((c) => {
      const who = M.modules.c5.list.find((x) => x.survivorId === c.survivorId);
      const st = c.flags.length ? "today" : c.score < 60 ? "watch" : "ok";
      return `<a class="c-row" href="#/call/${c.callId}"><span><b>${esc(who.displayName)}</b><span class="small muted" style="display:block">Coach ${esc(c.coach.name)} · ${esc(c.date)} · ${esc(c.language)} · ${esc(c.goalTopic)}</span></span>
        <span class="small">${c.flags.length ? esc(c.flags.map((f) => f.kind).join(", ")) + " flag" : c.cues.length + " cues"}</span>
        <span class="mono">${c.score}/100</span>${statusPill(st)}</a>`;
    }).join("");
    return `${head}<div class="calls-list">${rows}</div>`;
  }

  function renderCall(id) {
    const c = M.calls[id];
    if (!c) return stateView("error", "this call");
    const who = M.modules.c5.list.find((x) => x.survivorId === c.survivorId);
    const head = `<div class="page-head"><div><a class="small" href="#/calls">← Calls</a><h1>Call review · ${esc(who.displayName)}</h1>
      <div class="facts"><span>Coach <b>${esc(c.coach.name)}</b> (${esc(c.coach.role)})</span><span>Call <b>${c.callNumber}</b>, week ${c.week}</span><span><b>${esc(c.date)}</b> ${esc(c.start)}</span><span>${esc(c.language)}</span><span>Goal <b>${esc(c.goalTopic)}</b></span><span><b>${c.durationMin}</b> min</span></div></div>
      <a class="btn" href="#/s/c5/${c.survivorId}">Survivor page</a></div>`;
    if (previewState !== "ready") return head + stateView(previewState, previewState === "empty" ? "This call has no lines yet. For a live call, lines appear as people speak." : "this call");
    const flags = c.flags.map((f) => `<div class="banner alert" role="alert"><span class="b-ico">▲</span><div class="b-body"><b>${esc(f.kind[0].toUpperCase() + f.kind.slice(1))} flag at ${esc(f.t)} · a person must follow up today</b><p class="small">“${esc(f.text)}”</p>
      <div class="b-actions"><button class="btn danger" data-toast="Hand-off sent to the care team (mock)">Hand off to care team</button><a class="btn" href="#line-${f.line}">Jump to line ${f.line}</a><button class="btn" data-toast="Marked handled (mock)">Mark handled</button></div></div></div>`).join("");
    const cuesBy = {};
    c.cues.forEach((q) => (cuesBy[q.line] = cuesBy[q.line] || []).push(q));
    const good = new Set(["open question", "simple reflection", "complex reflection", "affirm", "seek collaboration", "emphasize autonomy", "ask permission"]);
    const lines = c.lines.map((l) => {
      const tags = [];
      if (l.move) tags.push(`<span class="tag ${good.has(l.move) ? "good" : l.move === "persuade" || l.move === "confront" ? "bad" : ""} ${l.reviewed ? "rev" : ""}" title="confidence ${l.confidence}">${esc(l.move)}${l.reviewed ? " · double-checked" : ""}</span>`);
      if (l.talk) tags.push(`<span class="tag ${l.talk === "change" ? "change" : ""}">${esc(l.talk)} talk</span>`);
      if (l.flag && l.flag !== "none") tags.push(`<span class="tag flag">▲ ${esc(l.flag)}</span>`);
      const cues = (cuesBy[l.n] || []).map((q) => `<p class="cue"><b>Cue · ${esc(q.kind)}:</b> ${esc(q.text)}</p>`).join("");
      return `<div class="line ${l.speaker} ${l.flag && l.flag !== "none" ? "flagged" : ""}" id="line-${l.n}" data-move="${esc(l.move || l.talk || "")}"><span class="t">${esc(l.t)}</span>
        <div><span class="who">${l.speaker === "coach" ? "Coach " + esc(c.coach.name) : "Participant"}</span><p>${esc(l.text)}</p><div class="tags">${tags.join("")}</div>${cues}</div></div>`;
    }).join("");
    const moves = Object.entries(c.moveCounts).sort((a, b) => b[1] - a[1]);
    const maxm = Math.max(...moves.map((m) => m[1]));
    const moveBars = moves.map(([k, v]) => `<div class="bar-row"><span>${esc(k)}</span><span class="bar-track"><span class="bar-fill" style="display:block;background:${good.has(k) ? "var(--m-c5)" : k === "persuade" || k === "confront" ? "var(--alert)" : "var(--ink-3)"};width:${(100 * v) / maxm}%"></span></span><span class="v">${v}</span></div>`).join("");
    const talk = c.talkCounts;
    const side = `<aside class="call-side">
      <div class="card stack"><p class="eyebrow">Coach score</p><div class="score-big"><span class="n">${c.score}</span><span class="muted">/100</span></div>${scoreParts(c)}
        <p class="small muted">Arithmetic over the line tags, MITI-style targets. Same formula as the Copilot’s live screen.</p></div>
      <div class="card stack"><p class="eyebrow">Coach moves</p><div class="bars">${moveBars}</div>
        <p class="small">Participant talk: <b>${talk.change || 0}</b> change · <b>${talk.sustain || 0}</b> sustain · <b>${talk.neutral || 0}</b> neutral</p></div>
      <div class="card stack"><p class="eyebrow">Supervisor</p><p class="small muted">Agree or correct any tag; corrections feed the accuracy check against supervisor ratings.</p>
        <div class="row"><button class="btn" data-toast="Review saved (mock)">Save review</button><button class="btn" data-toast="Shared with coach for supervision (mock)">Share with coach</button></div></div>
    </aside>`;
    return `${head}${flags}<div class="call-layout"><section class="card"><div class="row" style="justify-content:space-between;margin-bottom:6px"><h2>Transcript</h2><span class="small muted">${c.lines.length} lines · ${c.cues.length} cues · dashed tag = double-checked by the second model</span></div><div class="transcript">${lines}</div></section>${side}</div>`;
  }

  // ------------------------------------------------------------------ Survivor app (patient-facing)
  const T = {
    en: { hi: "Good morning", week: "This week’s focus", why: "Why this?", done: "Done this week", rest: "Go easy on yourself", talk: "Talk to your coach", next: "Your next call", lang: "Language", disclaimer: "This is general guidance from your coaching program, not medical advice. If you have a fever, chest pain or trouble breathing, call your care team now." },
    es: { hi: "Buenos días", week: "Su meta de esta semana", why: "¿Por qué?", done: "Hecho esta semana", rest: "Tómelo con calma", talk: "Hable con su coach", next: "Su próxima llamada", lang: "Idioma", disclaimer: "Esta es orientación general de su programa, no consejo médico. Si tiene fiebre, dolor en el pecho o le falta el aire, llame a su equipo de atención ahora." },
    ht: { hi: "Bonjou", week: "Kreyòl: tradiksyon an ap vini", why: "Poukisa?", done: "", rest: "", talk: "", next: "", lang: "Lang", disclaimer: "Haitian Creole copy needs review by a native speaker before use. Showing English below." },
  };
  function renderPatient(mod, id) {
    const parts = mod === "demo" ? M.composite.parts : { [mod]: id };
    const t = T[lang], en = T.en;
    const L = (k) => t[k] || en[k];
    const c4 = parts.c4 && M.modules.c4.detail[parts.c4];
    const c3 = parts.c3 && M.modules.c3.detail[parts.c3];
    const c5 = parts.c5 && M.modules.c5.detail[parts.c5];
    const head = `<div class="page-head"><div><p class="eyebrow">Survivor-facing</p><h1>Survivor app</h1><p class="sub">What the survivor sees on their phone. Plain words, one focus at a time, in their language. No scores, no risk labels.</p></div></div>`;
    if (previewState !== "ready") return head + stateView(previewState, previewState === "empty" ? "No advice yet. The first tip appears after a week of meal logs or wearable data." : "your plan");
    const recs4 = c4 ? c4.recommendations.filter((r) => r.audience === "survivor") : [];
    const focus = recs4.length ? recs4.map((r) => `<div class="p-card focus"><p class="eyebrow">${L("week")}</p><p class="big">${esc(lang === "es" && r.es ? r.es : r.text)}</p>
        <label class="check"><input type="checkbox" id="chk-${esc(r.text.slice(0, 8)).replace(/\W/g, "")}"> ${L("done")}</label></div>`).join("") : "";
    const why = c4 ? `<div class="p-card"><p class="eyebrow">${L("why")}</p><p class="why">${lang === "es" ? "Cuando cenó después de las 8 pm, su azúcar subió más que con cenas más temprano." : "When you ate dinner after 8 pm, your blood sugar rose more than after earlier dinners."}</p>
        ${c4.charts.compare.slice(0, 2).map((c) => `<div class="bar-row"><span>${esc(lang === "es" ? (c.label.includes("before") ? "Cena temprano" : "Cena tarde") : c.label.includes("before") ? "Early dinner" : "Late dinner")}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${(100 * c.value) / Math.max(...c4.charts.compare.map((x) => x.value), 1)}%"></span></span><span class="v">+${c.value}</span></div>`).join("")}
        <p class="small muted">${lang === "es" ? "Un patrón en sus datos, no una prueba." : "A pattern in your own data, not proof."}</p></div>` : "";
    const rest = c3 && c3.status !== "ok" ? `<div class="p-card"><p class="eyebrow">${L("rest")}</p><p class="why">${lang === "es" ? "Esta semana se ve más cansado/a. Descansar está bien. Las caminatas cortas en casa también cuentan." : esc(c3.recommendations.find((r) => r.audience === "survivor")?.text || "")}</p></div>` : "";
    const next = c5 ? `<div class="p-card"><p class="eyebrow">${L("next")}</p><p class="why">${lang === "es" ? "Con su coach" : "With your coach"} ${esc(c5.profile.coach)} · Tue 2:00 pm</p><button class="btn primary" data-toast="Message sent to your coach (mock)">${L("talk")}</button></div>` : "";
    const phone = `<div class="phone" aria-label="Survivor phone preview">
      <div class="row" style="justify-content:space-between"><h2>${L("hi")}</h2>
        <div class="lang" role="group" aria-label="${L("lang")}">${["en", "es", "ht"].map((k) => `<button data-lang="${k}" aria-pressed="${lang === k}">${k.toUpperCase()}</button>`).join("")}</div></div>
      ${focus}${why}${rest}${next}
      <p class="small muted">${esc(t.disclaimer)}</p></div>`;
    const notes = `<div class="notes-side stack"><h2>Design notes</h2>
      <ul class="evidence"><li>Advice comes from C4 (meal timing, walks) and C3 (rest during a rough patch). The survivor never sees “alert” or “risk”.</li>
      <li>One focus per card, a checkbox to log it, and the reason in one sentence with their own numbers.</li>
      <li>Language follows the survivor’s profile (English, Spanish, Haitian Creole in the C3 cohort). Creole copy is a stub until a native speaker reviews it.</li>
      <li>Safety line is always visible: urgent symptoms go to the care team, not the app.</li>
      <li>${mod === "demo" ? "This preview combines the composite demo survivor’s three records (illustrative)." : "Cards from modules this survivor is not in are hidden."}</li></ul></div>`;
    return `${head}<div class="phone-wrap">${phone}${notes}</div>`;
  }

  // ------------------------------------------------------------------ Stubs
  function renderCare() {
    return `<div class="page-head"><div><p class="eyebrow">Later · Challenge 1</p><h1>Care team risk</h1><p class="sub">For the care-team lead. Predicts which survivors need an ER visit or hospital stay next year, from survey answers plus clinical records.</p></div><span class="chip m-c1"><span class="dot"></span>Not built yet</span></div>
      <div class="stub"><div class="card stack"><h2>Where it shows up</h2><ul class="evidence"><li>A risk badge on each roster row on Today, next to the module chips.</li><li>A “Risk drivers” panel on the survivor page: top factors, calibrated probability, and how confident the data link is.</li><li>A care-team list sorted by risk with filters for age, sex, ethnicity, insurance and cancer type (fairness view).</li></ul></div>
      <div class="card stack"><h2>Honesty rules for the badge</h2><ul class="evidence"><li>MEPS (real survey) and Synthea (synthetic records) share no patient key. Show the link confidence, never a silent join.</li><li>Show a probability with its range, not a red/green verdict.</li><li>Factors are associations, not causes. Say so on the panel.</li></ul>
      <div class="row"><span class="status watch">Risk 18% (12–25%)</span><span class="chip m-c1"><span class="dot"></span>C1 · link confidence medium</span></div><p class="small muted">Sketch of the badge only.</p></div></div>`;
  }
  function renderResearch() {
    return `<div class="page-head"><div><p class="eyebrow">Later · Challenges 6 and 7</p><h1>Research</h1><p class="sub">Drug discovery work for a different user (lab scientists). It gets its own area so it never mixes with survivor data.</p></div><span class="chip"><span class="dot"></span>Not built yet</span></div>
      <div class="state-box"><h2>Separate workspace</h2><p class="muted">Different people, different data, different permissions. The console only links here from navigation. Designer: reserve the slot, no screens needed for the hackathon.</p></div>`;
  }

  // ------------------------------------------------------------------ router
  function parse() {
    const raw = location.hash.replace(/^#/, "") || "/today";
    const [path, q] = raw.split("?");
    const st = new URLSearchParams(q || "").get("state");
    return { parts: path.split("/").filter(Boolean), st };
  }
  function render() {
    const { parts, st } = parse();
    if (st && st !== previewState) { previewState = st; stateSel.value = st; }
    let html, nav = parts[0] || "today";
    try {
      if (nav === "today") html = renderToday();
      else if (nav === "s") { nav = "survivor"; html = parts[1] === "demo" ? renderSurvivor("demo") : renderSurvivor(parts[1], parts[2]); }
      else if (nav === "calls") html = renderCalls();
      else if (nav === "call") { nav = "calls"; html = renderCall(parts[1]); }
      else if (nav === "patient") html = parts[1] === "demo" ? renderPatient("demo") : renderPatient(parts[1], parts[2]);
      else if (nav === "care-team") { nav = "care"; html = renderCare(); }
      else if (nav === "research") html = renderResearch();
      else html = stateView("empty", "This page doesn’t exist. Use the navigation to get back.");
    } catch (e) {
      console.warn(e);
      html = stateView("error", "this page");
    }
    view.innerHTML = html;
    document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
    document.title = "Coach Console";
  }

  // ------------------------------------------------------------------ events
  const toast = document.getElementById("toast");
  let toastT;
  function showToast(msg) { toast.textContent = msg; toast.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (toast.hidden = true), 2400); }
  const tip = document.getElementById("tip");
  document.addEventListener("pointermove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t && t.dataset.tip) { tip.textContent = t.dataset.tip; tip.hidden = false; tip.style.left = Math.min(e.clientX + 12, innerWidth - 250) + "px"; tip.style.top = e.clientY + 14 + "px"; }
    else tip.hidden = true;
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("button, a");
    if (!el) return;
    if (el.dataset.toast) showToast(el.dataset.toast);
    if (el.dataset.filter) { rosterFilter = el.dataset.filter; render(); }
    if (el.dataset.jump) { const g = document.getElementById("g-" + el.dataset.jump); if (g) g.scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (el.dataset.lang) { lang = el.dataset.lang; render(); }
    if (el.hasAttribute("data-retry")) { previewState = "ready"; stateSel.value = "ready"; render(); }
    if (el.getAttribute("href") && el.getAttribute("href").startsWith("#line-")) {
      e.preventDefault(); const tgt = document.getElementById(el.getAttribute("href").slice(1)); if (tgt) tgt.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  stateSel.addEventListener("change", () => { previewState = stateSel.value; render(); });
  window.addEventListener("hashchange", () => { toast.hidden = true; render(); view.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  render();
})();
