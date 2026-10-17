/* Ellie: the clinician's assistant. Natural language to (1) open a page, (2) find and explain a patient's
   information, (3) answer general medical questions. Plain commands ("open glucose for N0072", "open the first
   one", "start a call with them") are resolved here, instantly. Everything else goes to /api/ellie, a small tool
   loop in the worker (search_patients, get_patient, read_page; navigate, open_tab, start_call). The client sends
   the roster, a summary of the page on screen and the ids Ellie named in earlier turns, so follow-ups like
   "that first patient" resolve. The worker checks every page Ellie wants to open before the app follows it.
   Also: Ellie's insight, a short AI read of the patient on every health chart (.ellie-insight[data-pid]). */
(function () {
  "use strict";
  const P = window.P360;
  const { esc, once, A, MODS, SNAP, LIVE_URL } = P;
  const history = []; // { role: "user" | "ellie", text, ids? } ids = patients Ellie named, in order
  let open = false, busy = false;

  const fab = document.createElement("button");
  fab.className = "ellie-fab"; fab.id = "ellie-fab"; fab.type = "button"; fab.setAttribute("aria-controls", "ellie"); fab.setAttribute("aria-expanded", "false");
  const FAB_OPEN = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Ask Ellie`;
  const FAB_CLOSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>Close Ellie`;
  fab.innerHTML = FAB_OPEN;
  const box = document.createElement("section");
  box.className = "ellie"; box.id = "ellie"; box.hidden = true; box.setAttribute("aria-label", "Ellie assistant");
  box.innerHTML = `<header><b>Ellie</b><span class="small" style="opacity:.75">clinician assistant</span><button type="button" id="ellie-close" aria-label="Close Ellie">Close</button></header>
    <div class="msgs" id="ellie-msgs" aria-live="polite"><div class="m a">Hi, I’m Ellie. I can find patients, explain their numbers, open any page or tab, start a call, and answer general medical questions.<span class="meta">I read the same data you see. Check anything clinical before acting.</span></div></div>
    <div class="sugg" id="ellie-sugg"><button type="button">Who is most at risk of the hospital?</button><button type="button">Open the first one</button><button type="button">Start a call with them</button><button type="button">Who needs a call today?</button><button type="button">What does time in range mean?</button></div>
    <form id="ellie-form"><input id="ellie-q" placeholder="Ask Ellie…" autocomplete="off" aria-label="Ask Ellie"><button type="submit">Send</button></form>`;
  document.body.append(fab, box);

  const msgs = () => document.getElementById("ellie-msgs");
  function say(role, html) { const d = document.createElement("div"); d.className = `m ${role}`; d.innerHTML = html; msgs().appendChild(d); msgs().scrollTop = msgs().scrollHeight; return d; }
  function toggle(v) {
    open = typeof v === "boolean" ? v : !open;
    box.hidden = !open;
    fab.classList.toggle("on", open); fab.setAttribute("aria-expanded", String(open)); fab.innerHTML = open ? FAB_CLOSE : FAB_OPEN;
    if (open) document.getElementById("ellie-q").focus(); else if (box.contains(document.activeElement)) fab.focus();
  }

  const compactRow = (r) => ({ id: r.id, name: r.name, program: MODS[r.mod].name, status: r.tri, headline: r.headline, tags: r.tags.map((t) => t.label) });
  function compactPatient(p) {
    if (!p) return null;
    return { id: p.id, name: p.name, program: MODS[p.mod].name, status: p.tri, headline: p.headline, facts: p.facts, tags: (p.tags || []).map((t) => t.label), ...(p.forEllie ? { forEllie: p.forEllie } : {}),
      kpis: (p.kpis || []).map((k) => `${k.label}: ${k.value}${k.sub ? " (" + k.sub + ")" : ""}`),
      advice: (p.panels || []).flatMap((pn) => (pn.advice || []).map((a) => `${a.title}${a.text ? ": " + a.text : ""}`)).slice(0, 8),
      details: (p.panels || []).map((pn) => pn.title + (pn.lead ? ": " + pn.lead : "")).slice(0, 10),
      footnote: p.footnote || "" };
  }
  let rosterSent = null;
  const rosterForModel = (rows) => rosterSent || (rosterSent = rows.map((r) => ({ id: r.id, name: r.name, mod: r.mod, tri: r.tri, headline: r.headline, tags: (r.tags || []).map((t) => t.label) })));
  const first = (r) => r.name.split(" · ")[0];
  const shortOf = (id) => id.split("-").slice(1).join("-");

  // read_page: what the clinician sees. Headings, KPI cards, first rows of each table. At most ~3 KB.
  function readPage() {
    const v = document.getElementById("view"), t = (el) => (el.textContent || "").replace(/\s+/g, " ").trim(), out = [];
    if (v) {
      v.querySelectorAll("h1, h2, h3").forEach((h) => out.push("# " + t(h)));
      v.querySelectorAll(".kpi").forEach((k) => out.push(`KPI ${t(k.querySelector(".kl") || k)}: ${t(k.querySelector(".kv") || k)}${k.querySelector(".ks") ? " (" + t(k.querySelector(".ks")) + ")" : ""}`));
      v.querySelectorAll("table").forEach((tb) => [...tb.querySelectorAll("tr")].slice(0, 6).forEach((tr) => out.push("| " + [...tr.children].map(t).join(" | "))));
      v.querySelectorAll(".t-row").forEach((r, i) => { if (i < 8) out.push("- " + t(r)); });
    }
    let text = "", n = 0;
    for (const line of out) { if (n + line.length > 2_800) break; text += line.slice(0, 300) + "\n"; n += line.length + 1; }
    return { route: location.hash || "#today", title: (v && v.querySelector("h1") ? t(v.querySelector("h1")) : document.title), text };
  }

  // Find patients the question names: a display-name word, a short id (N0072, P0117) or a full id.
  function findPatients(q, rows) {
    const low = q.toLowerCase();
    const words = new Set(low.split(/[^a-z0-9áéíóúñü-]+/i).filter((w) => w.length >= 3));
    const hits = rows.filter((r) => {
      const f = first(r).toLowerCase(), short = shortOf(r.id).toLowerCase();
      return low.includes(r.id.toLowerCase()) || words.has(short) || (f.length >= 3 && words.has(f));
    });
    if (!hits.length && /today|urgent|call|alert|who|priorit|need/i.test(q)) return rows.filter((r) => r.tri === "today" || r.tri === "alert").slice(0, 10);
    return hits.slice(0, 12);
  }
  const named = (q, rows) => { const low = q.toLowerCase(); return findPatients(q, rows).filter((r) => low.includes(r.id.toLowerCase()) || low.includes(shortOf(r.id).toLowerCase()) || low.includes(first(r).toLowerCase())); };

  const PAGES = [[/glucose|blood sugar|c4/i, "c4"], [/rough week|bad week|wearable|c3/i, "c3"], [/hospital risk|acute|er visit|c1/i, "c1"], [/coaching call|calls? history|c5/i, "c5"], [/health chart|overview|360/i, ""]];
  const VERB = /^\s*(?:please\s+|can you\s+|now\s+)?(open( up)?|show( me)?|go to|take me to|pull up|navigate to|start|begin|call)\b/i;
  const isCall = (q) => /\b(start|begin)\b.*\bcall\b|^\s*call\b/i.test(q);
  function actOn(p, q) {
    if (isCall(q)) return { route: `live-${p.id}`, text: `Starting a call with ${p.name}.`, ids: [p.id] };
    const page = PAGES.find(([re]) => re.test(q)), tab = page ? page[1] : "";
    return { route: `p-${p.id}${tab ? "." + tab : ""}`, text: `Opening ${p.name}${tab ? ", " + MODS[tab].name : ""}.${tab && tab !== p.mod ? ` They aren’t enrolled in ${MODS[tab].name}, so that view will be empty.` : ""}`, ids: [p.id] };
  }
  // "Open the first one", "start a call with them": resolve against the last list Ellie gave.
  const ORD = { first: 0, "1st": 0, top: 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: -1 };
  function resolveRef(q, rows) {
    if (!VERB.test(q) || named(q, rows).length) return null;
    const m = q.toLowerCase().match(/\b(first|1st|top|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/);
    const pron = /\b(them|him|her|that (one|patient|person)|this (one|patient|person)|the same (one|patient|person))\b/i.test(q);
    if (!m && !pron) return null;
    // Ordinals: the latest list long enough ("open the second one" after opening the first still works).
    const need = m && ORD[m[1]] >= 0 ? ORD[m[1]] + 1 : 1;
    const turn = [...history].reverse().find((h) => h.role === "ellie" && h.ids && h.ids.length >= need);
    if (!turn) return null;
    const i = m ? (ORD[m[1]] < 0 ? turn.ids.length - 1 : ORD[m[1]]) : 0;
    const id = turn.ids[i];
    const p = id && rows.find((r) => r.id === id);
    return p ? actOn(p, q) : null;
  }
  // Plain "open X (for Y)" commands are handled here, instantly.
  function quickRoute(q, rows) {
    if (!VERB.test(q)) return null;
    const who = named(q, rows);
    if (who.length === 1) return actOn(who[0], q);
    if (who.length) return null;
    const page = PAGES.find(([re]) => re.test(q));
    const cur = P.current();
    if (cur && page) return { route: `p-${cur.id}${page[1] ? "." + page[1] : ""}`, text: `Opening ${page[1] ? MODS[page[1]].name : "the health chart"} for ${cur.name}.`, ids: [cur.id] };
    if (cur && isCall(q) && /\b(this|current)\b/i.test(q)) return { route: `live-${cur.id}`, text: `Starting a call with ${cur.name}.`, ids: [cur.id] };
    for (const [re, route, text] of [[/patients|everyone|list/i, "patients", "Opening the Patients list."], [/today/i, "today", "Opening Today."], [/\bcalls\b/i, "calls", "Opening Calls."], [/hospital risk|care team/i, "care", "Opening Hospital risk."], [/research/i, "research", "Opening Research."]])
      if (re.test(q)) return { route, text, ids: [] };
    return null;
  }

  // After Ellie lists patients, offer the follow-ups that act on that list.
  function showFollowUps() {
    const s = document.getElementById("ellie-sugg");
    s.innerHTML = `<button type="button">Open the first one</button><button type="button">Start a call with them</button><button type="button">Open the second one</button>`;
    s.hidden = false; msgs().after(s);
  }
  const citeLinks = (ids, rows) => (ids || []).map((id) => { const row = rows.find((x) => x.id === id); return `<a href="#p-${esc(id)}">${esc(row ? first(row) : id)}</a>`; }).join("");

  async function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    document.getElementById("ellie-sugg").hidden = true;
    say("u", esc(q));
    const wait = say("a", `<span class="muted">Thinking…</span>`);
    try {
      const { rows } = await once("roster", A.roster);
      const quick = resolveRef(q, rows) || quickRoute(q, rows);
      if (quick) {
        history.push({ role: "user", text: q }, { role: "ellie", text: quick.text, ids: quick.ids });
        wait.innerHTML = `${esc(quick.text)}<span class="meta">Opened <a href="#${esc(quick.route)}">${esc(quick.route)}</a></span>`;
        wait.dataset.nav = quick.route; location.hash = "#" + quick.route; busy = false; return;
      }
      if (SNAP) { wait.innerHTML = `Ellie needs the live site to reach the model.<span class="meta"><a href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a></span>`; busy = false; return; }
      const counts = rows.reduce((c, r) => ((c[r.tri] = (c[r.tri] || 0) + 1), c), { total: rows.length });
      let matches = named(q, rows).map(compactRow);
      if (matches.length && matches.length <= 2) matches = await Promise.all(matches.map((m) => once("p:" + m.id, () => A.patient(m.id)).then(compactPatient).catch(() => m)));
      const r = await P.post("/api/ellie", { question: q, history: history.slice(-8), page: readPage(), patient: compactPatient(P.current()), matches, counts, roster: rosterForModel(rows) });
      history.push({ role: "user", text: q }, { role: "ellie", text: r.answer, ids: r.cites || [] });
      const label = r.kind === "medical" ? `<span class="ai-label">AI · check before acting</span> ` : "";
      wait.innerHTML = `${esc(r.answer)}<span class="meta">${label}${r.navigate ? `Opened <a href="#${esc(r.navigate)}">${esc(r.navigate)}</a> ` : ""}${citeLinks(r.cites, rows)}</span>`;
      if (r.navigate) { wait.dataset.nav = r.navigate; location.hash = "#" + r.navigate; }
      else if ((r.cites || []).length) showFollowUps();
    } catch (e) { wait.innerHTML = `Sorry, I couldn’t answer that (${esc(e.message)}). Try again.`; }
    busy = false;
    msgs().scrollTop = msgs().scrollHeight;
  }

  fab.addEventListener("click", () => toggle());
  box.addEventListener("click", (e) => {
    if (e.target.closest("#ellie-close")) { toggle(false); return; }
    const s = e.target.closest("#ellie-sugg button"); if (s) ask(s.textContent);
  });
  box.addEventListener("submit", (e) => { e.preventDefault(); const i = document.getElementById("ellie-q"); const q = i.value; i.value = ""; ask(q); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { e.preventDefault(); toggle(false); } });

  // ---------------------------------------------------------------- Ellie's insight on the health chart
  // Contract: the health chart renders <div class="ellie-insight" data-pid="<id>"></div>. We fill every such
  // element that has no data-state yet (set before writing, so our own writes don't re-trigger the observer).
  const insights = new Map();
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const cut15 = (s) => { const w = String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean); return w.length > 15 ? w.slice(0, 15).join(" ").replace(/[,;:.]$/, "") + "…" : w.join(" "); };
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  function fallbackInsight(p) {
    const advice = (p.panels || []).flatMap((pn) => (pn.advice || []).map((a) => a.title)).filter(Boolean);
    return { headline: p.headline || "No summary from this program yet.", bullets: advice.slice(0, 3).map(cut15), fallback: true };
  }
  function paintInsight(el, x) {
    const top = x.fallback ? `<span class="ei-src">From the program’s own summary</span>` : `<span class="ai-label">AI · check before acting</span>`;
    el.innerHTML = `<div class="ei-top"><b>AI Insight</b>${top}</div><p class="ei-line">${esc(x.headline)}</p>${x.bullets && x.bullets.length ? `<ul class="ei-list">${x.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}`;
  }
  // One request per patient+data version, shared by the chart and the prefetch below.
  const inflight = new Map();
  function getInsight(p) {
    const cp = compactPatient(p), key = `ellie-insight:${p.id}:${hash(JSON.stringify(cp))}`;
    const have = insights.get(key) || lsGet(key);
    if (have) return Promise.resolve(have);
    if (!inflight.has(key)) inflight.set(key, P.post("/api/insight", { patient: cp })
      .then((r) => { const x = { headline: r.headline, bullets: r.bullets || [] }; lsSet(key, x); insights.set(key, x); return x; })
      .catch(() => fallbackInsight(p)).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }
  // Prefetch: while Today is on screen, warm the insight for the patients it lists (one at a time, idle),
  // so the chart a clinician opens from Today shows its insight at once.
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function prefetchToday() {
    if (SNAP || !/^#?(today)?$/.test(location.hash)) return;
    try {
      const { rows } = await once("roster", A.roster);
      // Three, four seconds apart: a burst of insight calls used up the model's per-minute limit.
      for (const r of rows.filter((x) => x.tri === "today").slice(0, 3)) {
        if (!/^#?(today)?$/.test(location.hash)) return;
        await sleep(4_000);
        const p = await once("p:" + r.id, () => A.patient(r.id)).catch(() => null);
        if (p) await getInsight(p);
      }
    } catch (e) { /* best effort */ }
  }
  setTimeout(prefetchToday, 2500);
  window.addEventListener("hashchange", () => setTimeout(prefetchToday, 2500));
  async function fillInsight(el) {
    const pid = el.dataset.pid;
    el.dataset.state = "loading";
    el.innerHTML = `<div class="ei-top"><b>AI Insight</b><span class="ei-src">reading the chart…</span></div><div class="ei-skel" aria-hidden="true"><i></i><i></i><i></i></div>`;
    let p = null;
    try { const cur = P.current(); p = cur && cur.id === pid ? cur : await once("p:" + pid, () => A.patient(pid)); }
    catch (e) { el.dataset.state = "error"; el.innerHTML = ""; return; }
    if (SNAP) { paintInsight(el, fallbackInsight(p)); el.dataset.state = "fallback"; return; }
    const x = await getInsight(p);
    if (!el.isConnected) return;
    paintInsight(el, x); el.dataset.state = x.fallback ? "fallback" : "ai";
  }
  function scanInsights() { document.querySelectorAll(".ellie-insight[data-pid]:not([data-state])").forEach(fillInsight); }
  const view = document.getElementById("view");
  if (view && "MutationObserver" in window) new MutationObserver(scanInsights).observe(view, { childList: true, subtree: true });
  scanInsights();

  window.Ellie = { ask, toggle, readPage };
})();
