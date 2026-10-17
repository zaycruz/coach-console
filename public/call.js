/* Live call for one patient (#live-<id>). Same model path as Clef's own screen: each line goes
   through /api/c5/turn (Clef), low-confidence lines through /api/c5/review (GLM), cue triggers through
   /api/c5/cue. Speech: the browser records short clips (MediaRecorder, any current browser), each clip
   goes to /api/stt (Workers AI Whisper) and comes back as one line for the current speaker. Typing works too.
   "Play as live" (P.playCall) replays a recorded call line by line through this same view, for demos.
   Above the call: a recap of the last conversation, so whoever picks up today starts where it stopped. */
(function () {
  "use strict";
  const P = window.P360;
  const { esc, fmtDate, post, once, A, SNAP, LIVE_URL } = P;
  let call = null; // { pid, lines, lastCueAt, speaker, started, coach, queue, replay }
  let mic = null; // { on, stream, ctx, an, data, rec, mime, segAt, heard, lastLoud, iv, started, C }
  let pendingReplay = null;
  // KV reads can lag a write by up to a minute; this session's saves live in Adapter.local.calls (shared with Today).
  const justSaved = A.local.calls;
  const coachOf = (m) => (m.coach && m.coach !== "Coach" ? m.coach : "not recorded"); // older saves stored a placeholder
  const SPK = { coach: "Coach", participant: "Patient" };

  async function lastCall(p) {
    // Saved in-app calls (KV) and, for coaching-program patients, the labelled call history.
    const fetched = SNAP ? [] : await fetch(`/api/calls/${encodeURIComponent(p.id)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).then((l) => (Array.isArray(l) ? l.filter((x) => !(x && x.test) || /(?:^|;\s*)p360test=1/.test(document.cookie)) : [])).catch(() => []);
    const saved = [...(justSaved[p.id] || []).filter((x) => !fetched.some((f) => f.id === x.id)), ...fetched].sort((a, b) => b.at.localeCompare(a.at));
    let labelled = null;
    if (p.mod === "c5") {
      const calls = await once("calls", A.calls).catch(() => []);
      const mine = calls.filter((c) => c.survivorId === p.id).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
      if (mine[0]) labelled = { kind: "labelled", meta: mine[0], all: mine.length, full: await once("call:" + mine[0].callId, () => A.call(mine[0].callId)).catch(() => null) };
    }
    const s = saved[0] ? { kind: "saved", meta: saved[0], all: saved.length } : null;
    if (s && (!labelled || s.meta.at.slice(0, 10) >= labelled.meta.date)) return s;
    return labelled;
  }

  // Past-call transcript in a fixed-height box. No element ids, so it never collides with the live lines.
  function pastLines(lines, coachName) {
    if (!lines || !lines.length) return "";
    const rows = lines.map((l) => {
      const tag = l.tag || (l.supervisor && (l.speaker === "coach" ? l.supervisor.move : l.supervisor.talk && l.supervisor.talk + " talk"));
      const flag = (l.flag && l.flag !== "none") || (l.supervisor && l.supervisor.needsHuman);
      return `<div class="line ${l.speaker} ${flag ? "flagged" : ""}"><span class="t">${esc(l.t || "")}</span><div><span class="who">${l.speaker === "coach" ? "Coach " + esc(coachName || "") : "Patient"}</span><p>${esc(l.text)}</p>
        <div class="tags">${tag ? `<span class="tag sup">${esc(tag)}</span>` : ""}${flag ? `<span class="tag flag">▲ ${esc(l.flag && l.flag !== "none" ? l.flag.replace("_", " ") : "needs a person")}</span>` : ""}</div></div></div>`;
    }).join("");
    return `<details class="rc-lines"><summary>Full transcript · ${lines.length} lines, tagged</summary><div class="transcript scroll short">${rows}</div></details>`;
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
        <div class="rc-grid"><span>Coach <b>${esc(coachOf(m))}</b></span><span><b>${m.lines.length}</b> lines</span><span>Coach score <b>${m.score ?? "–"}</b>/100</span><span><b>${flags.length}</b> ${flags.length === 1 ? "line" : "lines"} flagged</span></div>
        ${flags.map((l) => `<p class="small"><span class="tag flag">▲ ${esc(l.flag.replace("_", " "))}</span> “${esc(l.text)}”</p>`).join("")}
        ${pl.slice(-2).map((l) => `<q>${esc(l.text)}</q>`).join("")}${m.note ? `<p class="small muted">Note: ${esc(m.note)}</p>` : ""}${pastLines(m.lines, coachOf(m))}<div id="recap-ai"></div></section>`;
    }
    const c = last.meta;
    return `<section class="card stack recap" id="recap" data-date="${esc(c.date)}"><div class="row" style="justify-content:space-between"><h2>Last call · ${esc(fmtDate(c.date))}</h2><a class="small" href="#call-${esc(c.callId)}">Open the call record →</a></div>
      <div class="rc-grid"><span>Coach <b>${esc(c.coach.name)}</b></span><span>Call <b>${c.callNumber}</b>, week <b>${c.week}</b></span><span>Goal <b>${esc(c.goalTopic)}</b></span><span>Coach score <b>${c.score ?? "–"}</b>/100</span><span>${esc(c.language)} · ${c.durationMin} min</span></div>
      ${c.flags.length ? c.flags.map((f) => `<p class="small"><span class="tag flag">▲ needs a person</span> ${esc(f.t)} “${esc(f.text)}”</p>`).join("") : `<p class="small muted">No line in that call needed a person.</p>`}
      ${last.full ? pastLines(last.full.lines, c.coach.name) : ""}<div id="recap-ai"></div></section>`;
  }

  async function aiRecap(p, last) {
    const box = document.getElementById("recap-ai");
    if (!box || SNAP || !last) return;
    box.innerHTML = `<p class="small muted">Writing a hand-off note…</p>`;
    let lines;
    if (last.kind === "saved") lines = last.meta.lines.map((l) => ({ speaker: l.speaker, text: l.text }));
    else { const full = last.full || await A.call(last.meta.callId).catch(() => null); lines = full ? full.lines.map((l) => ({ t: l.t, speaker: l.speaker, text: l.text, needsPerson: !!l.supervisor.needsHuman })) : []; }
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
      <p class="small muted" title="Targets from the Motivational Interviewing Treatment Integrity (MITI) code">Scored against standard motivational-interviewing targets.</p></div>`;
  }

  function replayBar() {
    const R = call.replay, c = R.c;
    const state = R.running ? `Line <b>${R.i}</b> of ${c.lines.length}` : R.i >= c.lines.length ? "Replay finished." : `Stopped at line ${R.i} of ${c.lines.length}.`;
    return `<div class="replay-bar" id="replaybar"><span class="rec-dot ${R.running ? "" : "off"}"></span><div class="stack-s" style="flex:1;min-width:0"><b>Replaying call ${c.callNumber} with ${esc(c.participantName)} (${esc(fmtDate(c.date))}, ${esc(c.language)}) as if live</b>
      <span class="small">${state} · one line every 1.5 s · grey tag = supervisor label, outlined = Clef now</span></div>
      ${R.running ? `<button class="btn" id="replaystop">Stop replay</button>` : `<button class="btn primary" data-play="${esc(c.callId)}">Play again</button>`}<a class="btn" href="#call-${esc(c.callId)}">Call record</a></div>`;
  }
  const paintReplay = () => { const b = document.getElementById("replaybar"); if (b && call && call.replay) b.outerHTML = replayBar(); };

  function micMsg() {
    if (!mic) return "";
    return `<span class="rec-dot"></span><b>Recording</b><span class="mono" id="mic-t">00:00</span><span class="lvl" aria-hidden="true"><span id="mic-lvl"></span></span>
      <span class="small">Lines go to <b id="mic-spk">${SPK[call.speaker]}</b>. A pause ends the line. <kbd>Space</kbd> ends it and switches speaker.</span>`;
  }

  // One call script in the patient's language (Spanish, Kreyòl), for a coach without an interpreter on the line.
  // Plain, short sentences; red flags first. Draft wording: have a qualified medical interpreter review before real use.
  const SCRIPTS = {
    es: { title: "Guion de llamada · Español", lines: [
      ["Saludo", "Hola, habla [nombre], su coach de salud del programa. ¿Es buen momento para hablar unos minutos?"],
      ["Cómo está", "¿Cómo se ha sentido desde nuestra última llamada? ¿Qué ha sido lo más difícil esta semana?"],
      ["Señales de alarma", "¿Ha tenido fiebre de 38 °C (100.4 °F) o más, escalofríos, dolor de pecho, falta de aire, una caída, una pierna hinchada o se ha sentido sin esperanza? Si dice que sí: llame hoy al equipo de cuidado o vaya a emergencias."],
      ["Necesidades", "¿Tiene lo que necesita en casa: comida, sus medicinas y cómo llegar a sus citas?"],
      ["Meta", "¿Qué pequeño paso quiere intentar antes de nuestra próxima llamada?"],
      ["Confirmar", "Para estar seguros, ¿me puede decir con sus palabras qué va a hacer si tiene fiebre?"],
      ["Cierre", "Gracias. Lo/la llamo de nuevo el [día]. Si algo cambia, llame al equipo de cuidado."]] },
    ht: { title: "Script apèl · Kreyòl", lines: [
      ["Bonjou", "Bonjou, se [non] ki la, coach sante ou nan pwogram nan. Èske ou gen kèk minit pou nou pale?"],
      ["Siy danje", "Èske ou te gen lafyèv 38 °C (100.4 °F) oswa plis, frison, doulè nan pwatrin, difikilte pou respire, ou te tonbe, yon janm ki anfle, oswa ou santi ou pa gen espwa? Si wi: rele ekip swen an jodi a oswa ale nan ijans."],
      ["Bezwen", "Èske ou gen sa ou bezwen lakay ou: manje, medikaman, ak transpò pou randevou ou?"],
      ["Fèmen", "Mèsi. M ap rele ou ankò [jou]. Si yon bagay chanje, rele ekip swen an."]] },
  };
  const langOf = (p) => { const l = String((p.facts.find(([k]) => k === "Language") || [])[1] || (p.profile && p.profile.language) || "").toLowerCase(); return /span|espa/.test(l) ? "es" : /creole|kreyòl|kreyol|haiti/.test(l) ? "ht" : ""; };
  const scriptBox = (code) => { const sc = SCRIPTS[code]; return sc ? `<details class="more call-script" open><summary>${esc(sc.title)} <span class="chip-lang need">Interpreter recommended</span></summary><ol class="script">${sc.lines.map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(v)}</li>`).join("")}</ol><p class="small muted">Draft translation for this demo. Have a qualified medical interpreter review it before use with patients.</p></details>` : ""; };

  async function renderLive(id) {
    const back = `<a class="back" href="#p-${esc(id)}">← Patient</a>`;
    const f = P.forced("this call", "No call yet.");
    if (f) return back + f;
    let p;
    try { p = await once("p:" + id, () => A.patient(id)); } catch (e) { return back + P.errorBox("this patient", e.message); }
    if (pendingReplay && pendingReplay.survivorId === id) {
      stopMic();
      const c = pendingReplay; pendingReplay = null;
      call = { pid: id, lines: [], lastCueAt: -99, speaker: "coach", started: null, coach: c.coach.name, queue: Promise.resolve(), replay: { c, i: 0, running: true } };
      const C = call; setTimeout(() => runReplay(C), 700);
    } else if (!call || call.pid !== id) { stopMic(); call = { pid: id, lines: [], lastCueAt: -99, speaker: "coach", started: null, coach: P.coach ? P.coach() : "", queue: Promise.resolve(), replay: null }; }
    const R = call.replay;
    const last = R ? null : await lastCall(p);
    if (!R) setTimeout(() => aiRecap(p, last), 0);
    const head = `${back}<header class="p-head"><div class="stack-s"><p class="eyebrow">Call</p><div class="row"><h1>${esc(p.name)}</h1>${P.statusPill(p.tri)}${P.modChip(p.mod)}</div>
      <div class="facts">${p.facts.slice(0, 6).map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join("")}</div></div><a class="btn" href="#p-${esc(id)}">Health chart</a></header>`;
    const controls = R ? replayBar()
      : `<div class="callbar"><button class="btn primary ${mic ? "rec" : ""}" id="mic">${mic ? "Stop mic" : "Start mic"}</button>
          <div class="seg" id="spk"><button data-s="coach" class="${call.speaker === "coach" ? "on" : ""}">Coach</button><button data-s="participant" class="${call.speaker === "participant" ? "on" : ""}">Patient</button></div>
          <select id="lang" aria-label="Language spoken">${[["en", "English"], ["es", "Spanish"], ["ht", "Haitian Creole"], ["", "Detect language"]].map(([v, t]) => `<option value="${v}" ${v === (langOf(p) || "en") ? "selected" : ""}>${t}</option>`).join("")}</select>
          <button class="btn" id="nextline" ${mic ? "" : "hidden"}>Next line</button></div>
        <div class="mic-state" id="micstate" aria-live="polite">${micMsg()}</div>
        ${scriptBox(langOf(p))}
        <form class="type-row" id="typeform"><input id="typed" placeholder="Or type what was said, press Enter" aria-label="Line text" autocomplete="off"><button class="btn" type="submit">Add line</button></form>`;
    const panel = SNAP
      ? `<section class="card stack"><h2>Start a call</h2><p class="muted">This shared copy can’t reach the model. The live site can.</p><a class="btn primary" href="${LIVE_URL}/#live-${esc(id)}" target="_blank" rel="noopener">Open on the live site ↗</a></section>`
      : `<section class="card stack"><div class="sec-head"><h2>${R ? "Call replay" : "Today’s call"}</h2><p class="small muted">${R ? "A recorded call, sent line by line through Clef exactly as a live call would be." : "Use the mic or type each line. Clef tags each line as it arrives. A concern raises a banner. A cue appears only when the coach needs one."}</p></div>
        ${controls}
        <div id="flagbox2"></div>
        <div class="transcript scroll" id="live-lines">${call.lines.length ? call.lines.map((l) => P.lineHtml(l, call.coach)).join("") : `<div class="live-empty" id="live-empty">${R ? "Starting the replay…" : "No lines yet. Start the mic, or type the first line."}</div>`}</div>
        ${R ? "" : `<div class="row"><button class="btn" id="endcall" ${call.lines.length ? "" : "disabled"}>End and save call</button><span class="small muted" id="savestate"></span></div>`}</section>`;
    return `${head}${R ? "" : recapFacts(p, last)}<div class="call-layout">${panel}<aside class="call-side" id="live-side">${scoreBox()}<div class="card stack"><p class="eyebrow">Cues</p><div id="cues"><p class="small muted">Quiet. Cues appear only when the coach needs one.</p></div></div></aside></div>`;
  }

  const clock = () => { if (!call.started) call.started = Date.now(); const s = Math.floor((Date.now() - call.started) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  function paint(l) { const el = document.getElementById("line-" + l.n); if (el) el.outerHTML = P.lineHtml(l, call.coach); }
  function side() { const s = document.getElementById("live-side"); if (s) s.firstElementChild.outerHTML = scoreBox(); }
  // Append to the scrolling transcript; follow the newest line unless the reader has scrolled up.
  function append(html) {
    const box = document.getElementById("live-lines"); if (!box) return null;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    document.getElementById("live-empty")?.remove();
    box.insertAdjacentHTML("beforeend", html);
    if (near) box.scrollTop = box.scrollHeight;
    return box.lastElementChild;
  }

  async function addLine(speaker, text, opt) {
    const C = call, o = opt || {};
    const l = { n: C.lines.length + 1, t: o.t || clock(), speaker, text, supervisor: o.supervisor || {}, pending: true };
    C.lines.push(l);
    append(P.lineHtml(l, C.coach));
    const e = document.getElementById("endcall"); if (e) e.disabled = false;
    const i = C.lines.length - 1;
    const previous = C.lines.slice(Math.max(0, i - 2), i).map((x) => ({ speaker: x.speaker, text: x.text, flag: x.live && x.live.flag && x.live.flag !== "none" ? x.live.flag : undefined }));
    try {
      const r = await track(C, post("/api/c5/turn", { line: { speaker, text }, previous }));
      l.live = { tag: r.tag, confidence: r.confidence, flag: r.flag };
      if (r.confidence != null && r.confidence < 0.3)
        track(C, post("/api/c5/review", { line: { speaker, text }, previous, probabilities: r.probabilities })).then((v) => { const lab = v.label || v.tag; if (lab && call === C) { l.live.tag = lab; l.live.reviewed = true; paint(l); side(); } }).catch(() => {});
    } catch (err) { l.live = { error: err.message }; }
    l.pending = false;
    if (call !== C) return;
    paint(l); side();
    if (l.live.flag && l.live.flag !== "none") { const fb = document.getElementById("flagbox2"); if (fb) fb.innerHTML = P.flagList([...fb.querySelectorAll(".flag-row")].map((r) => r.outerHTML).concat(P.flagBanner({ t: l.t, line: l.n, kind: l.live.flag, text: l.text, src: "Clef" }))); }
    const hit = P.cueTrigger(C.lines, i, C.lastCueAt);
    if (!hit) return;
    C.lastCueAt = hit.coachCount;
    post("/api/c5/cue", { trigger: hit.trigger, recent: C.lines.slice(-8).map((x) => ({ speaker: x.speaker, text: x.text, tag: x.live && x.live.tag })) }).then((c) => {
      if (!c.cue || call !== C) return;
      const box = document.getElementById("cues"); if (!box) return;
      box.querySelector("p.small.muted")?.remove();
      box.insertAdjacentHTML("afterbegin", P.cueHtml(c, hit.trigger, C.lines));
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ Play as live
  async function runReplay(C) {
    const R = C.replay, lines = R.c.lines;
    paintReplay();
    while (call === C && R.running && R.i < lines.length) {
      const l = lines[R.i], t0 = Date.now();
      R.i++;
      await addLine(l.speaker, l.text, { t: l.t, supervisor: l.supervisor });
      if (call !== C) return;
      paintReplay();
      await new Promise((ok) => setTimeout(ok, Math.max(0, 1500 - (Date.now() - t0))));
    }
    R.running = false;
    if (call === C) paintReplay();
  }
  async function playCall(callId) {
    let c;
    try { c = await once("call:" + callId, () => A.call(callId)); } catch (e) { P.showToast(`Can’t load that call: ${e.message}`); return; }
    if (call && call.replay) call.replay.running = false;
    stopMic();
    call = null;
    pendingReplay = c;
    const h = "#live-" + c.survivorId;
    if (location.hash === h) P.render(); else location.hash = h;
  }

  // ------------------------------------------------------------------ Mic: short recorded clips -> /api/stt
  function setSpeaker(s) {
    call.speaker = s;
    document.querySelectorAll("#spk button").forEach((b) => b.classList.toggle("on", b.dataset.s === s));
    const m = document.getElementById("mic-spk"); if (m) m.textContent = SPK[s];
  }
  function micError(kind, msg) {
    const text = {
      unsupported: "This browser can’t record audio. Type each line below, or open this page in a current Chrome, Safari, Edge or Firefox.",
      denied: "The microphone is blocked for this site. Allow it in the browser’s site settings (the icon left of the address), then press Start mic again. Until then, type each line below.",
      nomic: "No microphone found. Connect one and press Start mic again, or type each line below.",
      error: `The microphone could not start (${msg || "unknown error"}). Type each line below.`,
    }[kind];
    const box = document.getElementById("micstate");
    if (box) box.innerHTML = `<div class="banner warn"><span class="b-ico">!</span><div class="b-body">${esc(text)}</div></div>`;
    document.getElementById("typed")?.focus();
  }
  function micUi() {
    const m = document.getElementById("mic"); if (m) { m.textContent = mic ? "Stop mic" : "Start mic"; m.classList.toggle("rec", !!mic); m.disabled = false; }
    const n = document.getElementById("nextline"); if (n) n.hidden = !mic;
    const s = document.getElementById("micstate"); if (s && (mic || !s.querySelector(".banner"))) s.innerHTML = micMsg();
  }

  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return micError("unsupported");
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = AC ? new AC() : null; // made inside the click, so Safari lets it run
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    const btn = document.getElementById("mic"); if (btn) { btn.disabled = true; btn.textContent = "Waiting for permission…"; }
    const box = document.getElementById("micstate"); if (box) box.innerHTML = `<span class="small"><b>Allow the microphone</b> when the browser asks. Nothing is recorded until you do.</span>`;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) {
      if (ctx) ctx.close().catch(() => {});
      micUi();
      return micError(e.name === "NotAllowedError" || e.name === "SecurityError" ? "denied" : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? "nomic" : "error", e.message);
    }
    if (!call || !location.hash.startsWith("#live-")) { stream.getTracks().forEach((t) => t.stop()); if (ctx) ctx.close().catch(() => {}); return; }
    let an = null;
    if (ctx) { try { an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an); } catch (e) { an = null; } }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
    mic = { on: true, stream, ctx, an, data: an ? new Uint8Array(an.fftSize) : null, rec: null, mime, segAt: 0, heard: false, lastLoud: 0, started: Date.now(), C: call };
    segment();
    if (!mic) return;
    mic.iv = setInterval(tick, 100);
    micUi();
  }

  function segment() {
    const m = mic;
    let r;
    try { r = new MediaRecorder(m.stream, m.mime ? { mimeType: m.mime } : undefined); } catch (e) { stopMic(); micError("error", e.message); return; }
    const chunks = [];
    r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    r.onstop = () => { const meta = r.meta; if (meta && meta.keep && chunks.length) send(new Blob(chunks, { type: r.mimeType || m.mime || "audio/webm" }), meta); };
    m.rec = r; m.segAt = Date.now(); m.heard = !m.an; m.lastLoud = Date.now();
    r.start();
  }
  // Close the current clip under the current speaker; open the next one at once on the same stream.
  function cut() {
    const m = mic; if (!m || !m.rec) return;
    const r = m.rec; m.rec = null;
    r.meta = { keep: m.heard && Date.now() - m.segAt > 600, speaker: m.C.speaker, t: clock(), C: m.C };
    try { r.stop(); } catch (e) { /* already stopped */ }
    if (m.on) segment();
  }
  function tick() {
    const m = mic; if (!m) return;
    const now = Date.now();
    // A stalled meter (context not running, e.g. iOS "interrupted") must never drop speech: use timed 5 s clips instead.
    if (m.an && m.ctx.state !== "running") { m.heard = true; if (now - m.segAt > 5000) cut(); }
    else if (m.an) {
      m.an.getByteTimeDomainData(m.data);
      let s = 0; for (let k = 0; k < m.data.length; k++) { const v = (m.data[k] - 128) / 128; s += v * v; }
      const rms = Math.sqrt(s / m.data.length);
      if (rms > 0.012) { m.heard = true; m.lastLoud = now; }
      const lv = document.getElementById("mic-lvl"); if (lv) lv.style.width = Math.min(100, rms * 400) + "%";
      const len = now - m.segAt;
      if ((m.heard && now - m.lastLoud > 900 && len > 1500) || len > 8000) cut();
    } else if (now - m.segAt > 5000) cut();
    const t = document.getElementById("mic-t");
    if (t) { const s = Math.floor((now - m.started) / 1000); t.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
  }
  function send(blob, meta) {
    const C = meta.C, lang = (document.getElementById("lang") || {}).value || "";
    const ph = call === C ? append(`<div class="line ${meta.speaker} interim"><span class="t">${esc(meta.t)}</span><div><span class="who">${SPK[meta.speaker]}</span><p class="muted">Transcribing…</p></div></div>`) : null;
    const req = fetch(`/api/stt?lang=${encodeURIComponent(lang)}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }));
    // Clips can come back out of order; add lines in the order they were spoken.
    C.queue = C.queue.then(() => req).then((j) => {
      if (ph) ph.remove();
      if (j.text && call === C) addLine(meta.speaker, j.text, { t: meta.t });
    }).catch((e) => { if (ph) ph.remove(); if (call === C) P.showToast(`A clip could not be transcribed (${e.message}). Type that line if it matters.`); });
  }
  function stopMic() {
    const m = mic; if (!m) return;
    m.on = false;
    cut();
    clearInterval(m.iv);
    m.stream.getTracks().forEach((t) => t.stop());
    if (m.ctx) m.ctx.close().catch(() => {});
    mic = null;
    micUi();
  }

  // Every Clef tag and second-model retag still in flight for this call. End call waits for them (up to 10 s), so the
  // saved score is the score of every line the coach saw tagged, not of the lines that happened to be back.
  function track(C, p) { (C.inflight = C.inflight || new Set()).add(p); const done = () => C.inflight.delete(p); p.then(done, done); return p; }
  async function settled(C, ms = 10000) {
    const until = Date.now() + ms;
    while (C.inflight && C.inflight.size && Date.now() < until) await Promise.race([Promise.allSettled([...C.inflight]), new Promise((r) => setTimeout(r, until - Date.now()))]);
  }

  async function endCall() {
    const C = call; stopMic();
    const st = document.getElementById("savestate"); if (st) st.textContent = "Saving…";
    try {
      await settled(C);
      const p = await once("p:" + C.pid, () => A.patient(C.pid)).catch(() => null);
      const coach = C.coach || (P.coach ? P.coach() : "");
      const rec = await post(`/api/calls/${encodeURIComponent(C.pid)}`, { coach, name: p ? p.name : "", score: P.liveScore(C.lines), lines: C.lines.map((l) => ({ speaker: l.speaker, text: l.text, tag: l.live && l.live.tag, flag: l.live && l.live.flag })) });
      A.remember.call({ ...rec, pid: rec.pid || C.pid, name: rec.name || (p ? p.name : "") });
      // The saved call is now the latest call everywhere: Today, Patients, the patient page and Calls re-read it.
      P.memo.delete("roster"); P.memo.delete("p:" + C.pid);
      call = null;
      const concern = rec.lines.find((l) => l.flag && /^(medical|distress|social)$/.test(l.flag));
      P.showToast(concern ? `Call saved by ${rec.coach}. Clef flagged “${concern.text.slice(0, 60)}”: ${p ? P.A.shortName(p.name) : "the patient"} is on Act today.` : `Call saved by ${rec.coach} · hand-off note ready below.`);
      P.render();
    } catch (e) { if (st) st.textContent = `Not saved: ${e.message}`; }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.play) { e.preventDefault(); playCall(b.dataset.play); return; }
    if (!call) return;
    if (b.id === "mic") mic ? stopMic() : startMic();
    else if (b.id === "nextline") cut();
    else if (b.id === "replaystop") { if (call.replay) { call.replay.running = false; paintReplay(); } }
    else if (b.closest("#spk")) { cut(); setSpeaker(b.dataset.s); }
    else if (b.id === "endcall") endCall();
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "typeform") return;
    e.preventDefault();
    const inp = document.getElementById("typed"), t = inp.value.trim();
    if (!t || !call) return;
    addLine(call.speaker, t); inp.value = "";
    if (!mic) setSpeaker(call.speaker === "coach" ? "participant" : "coach");
  });
  // Space while recording: end this line and switch speaker (also when a button has focus, so it can't toggle the mic).
  document.addEventListener("keydown", (e) => {
    if (!call || !mic || e.code !== "Space" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    e.preventDefault(); cut(); setSpeaker(call.speaker === "coach" ? "participant" : "coach");
  });
  document.addEventListener("keyup", (e) => { if (mic && e.code === "Space" && e.target.tagName === "BUTTON") e.preventDefault(); });
  window.addEventListener("hashchange", () => {
    if (location.hash.startsWith("#live-")) return;
    stopMic();
    if (call && call.replay) call.replay.running = false;
  });

  P.routes.live = renderLive;
  P.playCall = playCall;
})();
