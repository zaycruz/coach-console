/* Live call for one patient (#live-<id>). Same model path as the Copilot's own screen: each line goes
   through /api/c5/turn (Clef), low-confidence lines through /api/c5/review (GLM), cue triggers through
   /api/c5/cue. Speech comes from the browser's recogniser (Safari or Chrome); typing works everywhere.
   Above the call: a recap of the last conversation, so whoever picks up today starts where it stopped. */
(function () {
  "use strict";
  const P = window.P360;
  const { esc, fmtDate, pct, post, once, A, MODS, SNAP, LIVE_URL } = P;
  let call = null; // { pid, lines, lastCueAt, speaker, rec, started, coach }
  const justSaved = {}; // KV reads can lag a write by up to a minute; keep this session's saves in hand

  async function lastCall(p) {
    // Saved in-app calls (KV) and, for coaching-program patients, the labelled call history.
    const fetched = SNAP ? [] : await fetch(`/api/calls/${encodeURIComponent(p.id)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const saved = [...(justSaved[p.id] || []).filter((x) => !fetched.some((f) => f.id === x.id)), ...fetched].sort((a, b) => b.at.localeCompare(a.at));
    let labelled = null;
    if (p.mod === "c5") {
      const calls = await once("calls", A.calls).catch(() => []);
      const mine = calls.filter((c) => c.survivorId === p.id).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
      if (mine[0]) labelled = { kind: "labelled", meta: mine[0], all: mine.length };
    }
    const s = saved[0] ? { kind: "saved", meta: saved[0], all: saved.length } : null;
    if (s && (!labelled || s.meta.at.slice(0, 10) >= labelled.meta.date)) return s;
    return labelled;
  }

  function recapFacts(p, last) {
    if (!last) {
      const advice = p.panels.flatMap((pn) => pn.advice || []).slice(0, 3);
      return `<section class="card stack recap" id="recap"><div class="row" style="justify-content:space-between"><h2>No previous call on record</h2>${P.modChip(p.mod)}</div>
        <p class="muted">This is the first coaching call logged for ${esc(p.name)}. What the program says to cover today:</p>
        <p><b>${esc(p.headline)}</b></p>${advice.length ? `<ol class="steps">${advice.map((a) => `<li>${esc(a.title)}</li>`).join("")}</ol>` : ""}</section>`;
    }
    if (last.kind === "saved") {
      const m = last.meta, pl = m.lines.filter((l) => l.speaker === "participant");
      const flags = m.lines.filter((l) => l.flag && l.flag !== "none");
      return `<section class="card stack recap" id="recap" data-date="${esc(m.at.slice(0, 10))}"><div class="row" style="justify-content:space-between"><h2>Last call · ${esc(fmtDate(m.at))}</h2><span class="chip">Logged in Patient 360</span></div>
        <div class="rc-grid"><span>Coach <b>${esc(m.coach)}</b></span><span><b>${m.lines.length}</b> lines</span><span>Coach score <b>${m.score ?? "–"}</b>/100</span><span><b>${flags.length}</b> ${flags.length === 1 ? "line" : "lines"} flagged</span></div>
        ${flags.map((l) => `<p class="small"><span class="tag flag">▲ ${esc(l.flag.replace("_", " "))}</span> “${esc(l.text)}”</p>`).join("")}
        ${pl.slice(-2).map((l) => `<q>${esc(l.text)}</q>`).join("")}${m.note ? `<p class="small muted">Note: ${esc(m.note)}</p>` : ""}<div id="recap-ai"></div></section>`;
    }
    const c = last.meta;
    return `<section class="card stack recap" id="recap" data-date="${esc(c.date)}"><div class="row" style="justify-content:space-between"><h2>Last call · ${esc(fmtDate(c.date))}</h2><a class="small" href="#call-${esc(c.callId)}">Open the full transcript →</a></div>
      <div class="rc-grid"><span>Coach <b>${esc(c.coach.name)}</b></span><span>Call <b>${c.callNumber}</b>, week <b>${c.week}</b></span><span>Goal <b>${esc(c.goalTopic)}</b></span><span>Coach score <b>${c.score ?? "–"}</b>/100</span><span>${esc(c.language)} · ${c.durationMin} min</span></div>
      ${c.flags.length ? c.flags.map((f) => `<p class="small"><span class="tag flag">▲ needs a person</span> ${esc(f.t)} “${esc(f.text)}”</p>`).join("") : `<p class="small muted">No line in that call needed a person.</p>`}
      <div id="recap-ai"></div></section>`;
  }

  async function aiRecap(p, last) {
    const box = document.getElementById("recap-ai");
    if (!box || SNAP || !last) return;
    box.innerHTML = `<p class="small muted">Writing a hand-off note…</p>`;
    let lines;
    if (last.kind === "saved") lines = last.meta.lines.map((l) => ({ speaker: l.speaker, text: l.text }));
    else { const full = await A.call(last.meta.callId).catch(() => null); lines = full ? full.lines.map((l) => ({ t: l.t, speaker: l.speaker, text: l.text, needsPerson: !!l.supervisor.needsHuman })) : []; }
    try {
      const r = await post("/api/recap", { patient: { name: p.name, headline: p.headline, facts: p.facts }, last: { date: last.meta.date || last.meta.at, goal: last.meta.goalTopic, lines } });
      if (!document.getElementById("recap-ai")) return;
      box.innerHTML = `<div class="stack-s" style="border-top:1px solid var(--line);padding-top:12px"><p class="row"><span class="ai-label">AI · check before acting</span><span class="small muted">Hand-off note from the transcript</span></p>
        <p>${esc(r.summary)}</p>${r.pickUp && r.pickUp.length ? `<p class="fig-t">Pick up here</p><ul class="evidence">${r.pickUp.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${r.openConcerns && r.openConcerns.length ? `<p class="fig-t">Still open</p><ul class="evidence">${r.openConcerns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`;
    } catch (e) { box.innerHTML = `<p class="small muted">Hand-off note unavailable (${esc(e.message)}). The facts above are from the record.</p>`; }
  }

  function scoreBox() {
    const s = call ? P.liveScore(call.lines) : null;
    const flags = call ? call.lines.filter((l) => l.live && l.live.flag && l.live.flag !== "none").length : 0;
    return `<div class="card stack"><p class="eyebrow">This call</p><div class="score-pair"><div><span class="n">${s ?? "–"}</span><span class="l">coach score (after 4 coach lines)</span></div><div><span class="n">${flags}</span><span class="l">lines need a person</span></div></div>
      <p class="small muted">MITI-style targets, same arithmetic as the Copilot.</p></div>`;
  }

  async function renderLive(id) {
    const back = `<a class="back" href="#p-${esc(id)}">← Patient</a>`;
    const f = P.forced("this call", "No call yet.");
    if (f) return back + f;
    let p;
    try { p = await once("p:" + id, () => A.patient(id)); } catch (e) { return back + P.errorBox("this patient", e.message); }
    if (!call || call.pid !== id) call = { pid: id, lines: [], lastCueAt: -99, speaker: "coach", rec: null, started: null, coach: "" };
    const last = await lastCall(p);
    setTimeout(() => aiRecap(p, last), 0);
    const head = `${back}<header class="p-head"><div class="stack-s"><p class="eyebrow">Call</p><div class="row"><h1>${esc(p.name)}</h1>${P.statusPill(p.tri)}${P.modChip(p.mod)}</div>
      <div class="facts">${p.facts.slice(0, 6).map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join("")}</div></div><a class="btn" href="#p-${esc(id)}">Health chart</a></header>`;
    const panel = SNAP
      ? `<section class="card stack"><h2>Start a call</h2><p class="muted">This shared copy can’t reach the model. The live site can.</p><a class="btn primary" href="${LIVE_URL}/#live-${esc(id)}" target="_blank" rel="noopener">Open on the live site ↗</a></section>`
      : `<section class="card stack"><div class="sec-head"><h2>Today’s call</h2><p class="small muted">Talk with the mic or type each line. Each line is tagged live by the Copilot; concerns raise a banner, and cues appear only when the coach needs one.</p></div>
        <div class="callbar"><button class="btn primary" id="mic">Start mic</button>
          <div class="seg" id="spk"><button data-s="coach" class="${call.speaker === "coach" ? "on" : ""}">Coach</button><button data-s="participant" class="${call.speaker === "participant" ? "on" : ""}">Patient</button></div>
          <select id="lang" aria-label="Language"><option value="en-US">English</option><option value="es-US">Spanish</option><option value="fr-FR">Haitian Creole (French model)</option></select>
          <span class="small muted">Space switches speaker while the mic is on.</span></div>
        <form class="type-row" id="typeform"><input id="typed" placeholder="Type what was said, press Enter" aria-label="Line text" autocomplete="off"><button class="btn" type="submit">Add line</button></form>
        <div id="flagbox2" class="stack"></div>
        <div class="transcript" id="live-lines">${call.lines.length ? call.lines.map((l) => P.lineHtml(l, call.coach)).join("") : `<div class="live-empty" id="live-empty">No lines yet.</div>`}</div>
        <div class="row"><button class="btn" id="endcall" ${call.lines.length ? "" : "disabled"}>End and save call</button><span class="small muted" id="savestate"></span></div></section>`;
    return `${head}${recapFacts(p, last)}<div class="call-layout">${panel}<aside class="call-side" id="live-side">${scoreBox()}<div class="card stack"><p class="eyebrow">Cues</p><div id="cues"><p class="small muted">Quiet. Cues appear only when the coach needs one.</p></div></div></aside></div>`;
  }

  const clock = () => { if (!call.started) call.started = Date.now(); const s = Math.floor((Date.now() - call.started) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  function paint(l) { const el = document.getElementById("line-" + l.n); if (el) el.outerHTML = P.lineHtml(l, call.coach); }
  function side() { const s = document.getElementById("live-side"); if (s) s.firstElementChild.outerHTML = scoreBox(); }

  async function addLine(speaker, text) {
    const C = call;
    const l = { n: C.lines.length + 1, t: clock(), speaker, text, supervisor: {}, pending: true };
    C.lines.push(l);
    document.getElementById("live-empty")?.remove();
    document.getElementById("live-lines")?.insertAdjacentHTML("beforeend", P.lineHtml(l, C.coach));
    const e = document.getElementById("endcall"); if (e) e.disabled = false;
    const i = C.lines.length - 1;
    const previous = C.lines.slice(Math.max(0, i - 2), i).map((x) => ({ speaker: x.speaker, text: x.text, flag: x.live && x.live.flag && x.live.flag !== "none" ? x.live.flag : undefined }));
    try {
      const r = await post("/api/c5/turn", { line: { speaker, text }, previous });
      l.live = { tag: r.tag, confidence: r.confidence, flag: r.flag };
      if (r.confidence != null && r.confidence < 0.3)
        post("/api/c5/review", { line: { speaker, text }, previous, probabilities: r.probabilities }).then((v) => { const lab = v.label || v.tag; if (lab && call === C) { l.live.tag = lab; l.live.reviewed = true; paint(l); side(); } }).catch(() => {});
    } catch (err) { l.live = { error: err.message }; }
    l.pending = false;
    if (call !== C) return;
    paint(l); side();
    if (l.live.flag && l.live.flag !== "none") document.getElementById("flagbox2")?.insertAdjacentHTML("afterbegin", P.flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Copilot" }));
    const hit = P.cueTrigger(C.lines, i, C.lastCueAt);
    if (!hit) return;
    C.lastCueAt = hit.coachCount;
    post("/api/c5/cue", { trigger: hit.trigger, recent: C.lines.slice(-8).map((x) => ({ speaker: x.speaker, text: x.text, tag: x.live && x.live.tag })) }).then((c) => {
      if (!c.cue || call !== C) return;
      const box = document.getElementById("cues"); if (!box) return;
      box.querySelector("p.small.muted")?.remove();
      box.insertAdjacentHTML("afterbegin", `<p class="cue"><b>${esc(c.cue)}</b>${c.say ? ` <q>${esc(c.say)}</q>` : ""}<span class="why">${esc(hit.trigger)}</span></p>`);
    }).catch(() => {});
  }

  function setSpeaker(s) { call.speaker = s; document.querySelectorAll("#spk button").forEach((b) => b.classList.toggle("on", b.dataset.s === s)); }
  function stopMic() { if (call && call.rec) { const r = call.rec; call.rec = null; r.onend = null; try { r.stop(); } catch (e) { /* already stopped */ } } const m = document.getElementById("mic"); if (m) { m.textContent = "Start mic"; m.classList.remove("rec"); } }
  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { P.showToast("This browser has no speech recognition. Use Safari or Chrome, or type the lines."); return; }
    const rec = new SR(); call.rec = rec;
    rec.lang = document.getElementById("lang").value; rec.continuous = true; rec.interimResults = true;
    let interim = null;
    rec.onresult = (e) => {
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k], text = res[0].transcript.trim();
        if (res.isFinal) { interim?.remove(); interim = null; if (text) addLine(call.speaker, text); }
        else {
          if (!interim) { interim = document.createElement("div"); document.getElementById("live-lines")?.appendChild(interim); }
          interim.className = `line ${call.speaker} interim`;
          interim.innerHTML = `<span class="t">…</span><div><span class="who">${call.speaker === "coach" ? "Coach" : "Patient"}</span><p>${esc(text)}</p></div>`;
        }
      }
    };
    rec.onend = () => { if (call && call.rec === rec) rec.start(); };
    rec.start();
    const m = document.getElementById("mic"); m.textContent = "Stop mic"; m.classList.add("rec");
  }

  async function endCall() {
    const C = call; stopMic();
    const st = document.getElementById("savestate"); if (st) st.textContent = "Saving…";
    try {
      const rec = await post(`/api/calls/${encodeURIComponent(C.pid)}`, { coach: C.coach, score: P.liveScore(C.lines), lines: C.lines.map((l) => ({ speaker: l.speaker, text: l.text, tag: l.live && l.live.tag, flag: l.live && l.live.flag })) });
      (justSaved[C.pid] = justSaved[C.pid] || []).unshift(rec);
      call = null;
      P.showToast("Call saved. It is the recap for the next call.");
      P.render();
    } catch (e) { if (st) st.textContent = `Not saved: ${e.message}`; }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !call) return;
    if (b.id === "mic") call.rec ? stopMic() : startMic();
    else if (b.closest("#spk")) setSpeaker(b.dataset.s);
    else if (b.id === "endcall") endCall();
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "typeform") return;
    e.preventDefault();
    const inp = document.getElementById("typed"), t = inp.value.trim();
    if (!t || !call) return;
    addLine(call.speaker, t); inp.value = "";
    setSpeaker(call.speaker === "coach" ? "participant" : "coach");
  });
  document.addEventListener("keydown", (e) => {
    if (!call || !call.rec || e.code !== "Space" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    e.preventDefault(); setSpeaker(call.speaker === "coach" ? "participant" : "coach");
  });
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#live-")) stopMic(); });

  P.routes.live = renderLive;
})();
