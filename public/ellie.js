/* Ellie: the clinician's assistant. Natural language to (1) open a page, (2) find and explain a patient's
   information, (3) answer general medical questions. Plain commands ("open glucose for N0072", "open the first
   one", "start a call with them", "who needs me today") are resolved here, instantly, with no model call, so they
   work when the model is rate-limited. Everything else goes to /api/ellie, a small tool loop in the worker
   (search_patients, get_patient, read_page; navigate, open_tab, start_call). The client sends the roster, a summary
   of the page on screen and the ids Ellie named in earlier turns, so follow-ups like "that first patient" resolve.
   The thread lives in sessionStorage for the shift. Cmd/Ctrl+K or "/" opens her.
   Also: Ellie's insight, a short AI read of the patient on every health chart (.ellie-insight[data-pid]). */
(function () {
  "use strict";
  const P = window.P360;
  const { esc, once, A, MODS, SNAP, LIVE_URL } = P;
  const ssGet = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  const saved = ssGet("ellie-thread") || {};
  const history = Array.isArray(saved.history) ? saved.history : []; // { role: "user" | "ellie", text, ids? } ids = patients Ellie named, in order
  const bubbles = Array.isArray(saved.bubbles) ? saved.bubbles : []; // { cls, html } rendered turns, for reload
  let open = false, busy = false, lastQ = "";
  const persist = () => ssSet("ellie-thread", { history: history.slice(-30), bubbles: bubbles.slice(-40) });

  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const fab = document.createElement("button");
  fab.className = "ellie-fab"; fab.id = "ellie-fab"; fab.type = "button"; fab.setAttribute("aria-controls", "ellie"); fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-label", "Ask Ellie"); fab.setAttribute("aria-keyshortcuts", "Meta+K Control+K /"); fab.title = `Ask Ellie (${MAC ? "⌘K" : "Ctrl K"} or /)`;
  const ICON_OPEN = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  const FAB_OPEN = `${ICON_OPEN}<span class="fab-l">Ask Ellie</span><kbd class="fab-k">${MAC ? "⌘K" : "Ctrl K"}</kbd>`;
  const FAB_CLOSE = `${ICON_CLOSE}<span class="fab-l">Close Ellie</span>`;
  fab.innerHTML = FAB_OPEN;
  const box = document.createElement("section");
  box.className = "ellie"; box.id = "ellie"; box.hidden = true; box.setAttribute("aria-label", "Ellie assistant");
  box.innerHTML = `<header><b>Ellie</b><span class="small" style="opacity:.75">clinician assistant</span><button type="button" id="ellie-clear" aria-label="Clear the conversation">Clear</button><button type="button" id="ellie-close" aria-label="Close Ellie">Close</button></header>
    <div class="msgs" id="ellie-msgs" aria-live="polite"><div class="m a">Hi, I’m Ellie. I can find patients, explain their numbers, open any page or tab, start a call, and answer general medical questions.<span class="meta">I read the same data you see. Check anything clinical before acting.</span></div></div>
    <div class="sugg" id="ellie-sugg"></div>
    <form id="ellie-form"><input id="ellie-q" placeholder="Ask Ellie…" autocomplete="off" aria-label="Ask Ellie"><button type="submit">Send</button></form>`;
  document.body.append(fab, box);

  const msgs = () => document.getElementById("ellie-msgs");
  function say(role, html) { const d = document.createElement("div"); d.className = `m ${role}`; d.innerHTML = html; msgs().appendChild(d); msgs().scrollTop = msgs().scrollHeight; return d; }
  const keep = (el) => { bubbles.push({ cls: el.className, html: el.innerHTML }); persist(); };
  const docked = () => window.matchMedia("(min-width: 1200px)").matches;
  function toggle(v) {
    open = typeof v === "boolean" ? v : !open;
    box.hidden = !open;
    document.body.classList.toggle("ellie-open", open);
    fab.classList.toggle("on", open); fab.setAttribute("aria-expanded", String(open)); fab.innerHTML = open ? FAB_CLOSE : FAB_OPEN;
    fab.setAttribute("aria-label", open ? "Close Ellie" : "Ask Ellie");
    if (open) { document.getElementById("ellie-q").focus(); msgs().scrollTop = msgs().scrollHeight; } else if (box.contains(document.activeElement)) fab.focus();
  }

  // ---------------------------------------------------------------- what Ellie knows about a patient
  const compactRow = (r) => ({ id: r.id, name: r.name, program: MODS[r.mod].name, status: r.tri, headline: r.headline, tags: r.tags.map((t) => t.label) });
  // The patient's own words: the adapter's concern overlay first, then the C5 "Lines that need a person" panel and call flags.
  function quotesOf(p) {
    const out = [];
    if (p.concern && p.concern.text) out.push(`${p.concern.where ? p.concern.where + ": " : ""}“${p.concern.text}”`);
    (p.panels || []).forEach((pn) => {
      if (pn.id === "concerns") (pn.list || []).forEach((t) => out.push(String(t)));
      (pn.calls || []).forEach((c) => (c.flags || []).forEach((f) => out.push(`${c.callNumber ? "call " + c.callNumber : "logged call"}${f.kind ? " (" + f.kind + ")" : ""}: “${f.text}”`)));
    });
    const seen = new Set();
    return out.filter((x) => { const k = (x.match(/“([^”]+)”/) || [, x])[1].toLowerCase().replace(/\W+/g, " ").trim(); return !seen.has(k) && seen.add(k); }).slice(0, 4);
  }
  function compactPatient(p) {
    if (!p) return null;
    return { id: p.id, name: p.name, program: MODS[p.mod].name, status: p.tri, headline: p.headline, summary: p.summary || "", facts: p.facts, tags: (p.tags || []).map((t) => t.label),
      patientWords: quotesOf(p), ...(p.forEllie ? { forEllie: p.forEllie } : {}),
      kpis: (p.kpis || []).map((k) => `${k.label}: ${k.value}${k.sub ? " (" + k.sub + ")" : ""}`),
      advice: (p.panels || []).flatMap((pn) => (pn.advice || []).map((a) => `${a.title}${a.text ? ": " + a.text : ""}`)).slice(0, 8),
      details: (p.panels || []).map((pn) => pn.title + (pn.lead ? ": " + pn.lead : "")).slice(0, 10),
      footnote: p.footnote || "" };
  }
  let rosterSent = null, rosterSrc = null;  // rebuilt when the cached roster is replaced (after a save or hand-off)
  const rosterForModel = (rows) => rosterSrc === rows && rosterSent ? rosterSent : (rosterSrc = rows, rosterSent = rows.map((r) => ({ id: r.id, name: r.name, mod: r.mod, tri: r.tri, headline: r.headline, tags: (r.tags || []).map((t) => t.label) })));
  // The name a clinician says: the real first name (C5), else the short id (some views put age/sex first).
  const first = (r) => { const seg = String(r.name || "").split(" · ")[0].trim(); return !seg || /^\d/.test(seg) || /^unnamed/i.test(seg) ? shortOf(r.id) : seg; };
  const shortOf = (id) => id.split("-").slice(1).join("-");
  const nameOf = (id, rows) => { const r = rows.find((x) => x.id === id); return r ? first(r) : shortOf(id); };

  // Severity inside a status, worst first: urgent 7-day ER risk, then call concerns, then each program's own number.
  const num = (s, re) => { const m = String(s).match(re); return m ? +m[1] : null; };
  function sev(r) {
    const h = `${r.headline} ${(r.tags || []).map((t) => t.label || t).join(" ")}`;
    if (r.mod === "c3") { const er = num(h, /ER or hospital risk (\d+(?:\.\d+)?)%/i), x = num(h, /about (\d+(?:\.\d+)?)x usual/i); return er != null ? 1000 + (x || 0) * 10 + er : num(h, /rough patch risk (\d+)%/i) || 0; }
    if (r.mod === "c5") return r.tri === "today" ? 900 : 50;
    if (r.mod === "c1") return num(h, /(?:acute care|ER or hospital) risk (\d+(?:\.\d+)?)%/i) || 0;
    const tir = num(h, /(\d+(?:\.\d+)?)% in range/i), lows = num(h, /(\d+(?:\.\d+)?)% of readings below/i);
    return Math.max(tir != null ? 100 - tir : 0, lows != null ? lows * 10 : 0);
  }
  const RANK = { today: 0, alert: 1, watch: 2, ok: 3 };
  // Same order as Today: app.js's sortRows when it is exported (always on a copy: it sorts in place), else ours.
  const ordered = (rows) => { const c = [...rows]; return typeof P.sortRows === "function" ? P.sortRows(c) || c : c.sort((a, b) => RANK[a.tri] - RANK[b.tri] || (a.prio ?? 200) - (b.prio ?? 200) || sev(b) - sev(a)); };
  const keyNum = (r) => {
    if (r.reason) return r.reason;
    const t = (r.tags || []).map((x) => x.label || x);
    return (t.find((l) => /ER\/hospital|Acute care|In range|Lows|Rough patch|Rough week|need a person/i.test(l)) || r.headline || "").replace(/\s+/g, " ").slice(0, 90);
  };

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
    if (!hits.length && /today|urgent|call|alert|who|priorit|need/i.test(q)) return ordered(rows.filter((r) => r.tri === "today" || r.tri === "alert")).slice(0, 10);
    return hits.slice(0, 12);
  }
  const named = (q, rows) => { const low = q.toLowerCase(); return findPatients(q, rows).filter((r) => low.includes(r.id.toLowerCase()) || low.includes(shortOf(r.id).toLowerCase()) || low.includes(first(r).toLowerCase())); };

  const PAGES = [[/glucose|blood sugar|c4/i, "c4"], [/rough week|bad week|wearable|c3/i, "c3"], [/hospital risk|acute|er visit|c1/i, "c1"], [/coaching call|calls? history|c5/i, "c5"], [/health chart|overview|360/i, ""]];
  const VERB = /^\s*(?:please\s+|can you\s+|now\s+|ok\s+)?(open( up)?|show( me)?|go (to|back to)|take me to|pull up|navigate to|start|begin|call|back to)\b/i;
  const isCall = (q) => /\b(start|begin)\b.*\bcall\b|^\s*call\b/i.test(q);
  function actOn(p, q) {
    if (isCall(q)) return { route: `live-${p.id}`, text: `Starting a call with ${first(p)}.`, ids: [p.id] };
    const page = PAGES.find(([re]) => re.test(q)), tab = page ? page[1] : "";
    return { route: `p-${p.id}${tab ? "." + tab : ""}`, text: `Opening ${first(p)}${tab ? ", " + MODS[tab].name : ""}.${tab && tab !== p.mod ? ` They aren’t enrolled in ${MODS[tab].name}, so that view will be empty.` : ""}`, ids: [p.id] };
  }
  // "Open the first one", "start a call with them": resolve against the last list Ellie gave.
  const ORD = { first: 0, "1st": 0, top: 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: -1 };
  function resolveRef(q, rows) {
    if (!VERB.test(q) || named(q, rows).length) return null;
    const m = q.toLowerCase().match(/\b(first|1st|top|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/);
    const pron = /\b(them|their|him|his|her|that (one|patient|person)|this (one|patient|person)|the same (one|patient|person))\b/i.test(q);
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
    if (cur && page) return { route: `p-${cur.id}${page[1] ? "." + page[1] : ""}`, text: `Opening ${page[1] ? MODS[page[1]].name : "the health chart"} for ${first(cur)}.${page[1] && page[1] !== cur.mod ? ` They aren’t enrolled in ${MODS[page[1]].name}, so that view will be empty.` : ""}`, ids: [cur.id] };
    if (cur && isCall(q) && /\b(this|current)\b/i.test(q)) return { route: `live-${cur.id}`, text: `Starting a call with ${first(cur)}.`, ids: [cur.id] };
    for (const [re, route, text] of [[/patients|everyone|list/i, "patients", "Opening the Patients list."], [/today/i, "today", "Opening Today."], [/\bcalls\b/i, "calls", "Opening Calls."], [/hospital risk|care team/i, "care", "Opening Hospital risk."], [/research/i, "research", "Opening Research."]])
      if (re.test(q)) return { route, text, ids: [] };
    return null;
  }
  // A name that fits two patients ("open Rosa"): ask which one, with chips that carry the short id.
  function whichOne(q, rows) {
    const low = q.toLowerCase(), who = named(q, rows);
    if (who.length < 2) return null;
    const byName = {};
    who.forEach((r) => { const f = first(r).toLowerCase(); if (low.includes(f) && !low.includes(shortOf(r.id).toLowerCase())) (byName[f] = byName[f] || []).push(r); });
    const dup = Object.values(byName).find((g) => g.length > 1);
    if (!dup) return null;
    const nm = first(dup[0]), re = new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return { text: `${dup.length} patients are called ${nm}. Which one?`, chips: dup.map((r) => ({ label: `${r.name} · ${MODS[r.mod].name}`, q: q.replace(re, shortOf(r.id)) })), ids: [] };
  }
  // "Who needs me today?": the same list and order as Today (adapters roster tri === "today"), no model.
  const TODAY_Q = /\b(who|which|whom|list|show)\b.*\b(today|need(s)? (me|a person|a call|attention|follow)|call (first|today)|urgent|priorit)/i;
  function todayAnswer(q, rows) {
    if (!TODAY_Q.test(q) || /\b(why|explain|mean|hospital|\ber\b|admission|glucose|sugar|rough)\b/i.test(q) || /\bstart\b/i.test(q)) return null;
    const list = ordered(rows.filter((r) => r.tri === "today"));
    if (!list.length) return { text: "By Today’s list: nobody is marked Act today right now.", ids: [], route: "" };
    const show = list.slice(0, 12);
    const lines = show.map((r, i) => `${i + 1}. ${first(r)} (${MODS[r.mod].name}): ${keyNum(r)}`);
    return { text: `By Today’s list (Act today, urgent ER risk first, then calls that need a person): ${list.length} patient${list.length === 1 ? "" : "s"} need${list.length === 1 ? "s" : ""} a person today.\n${lines.join("\n")}${list.length > show.length ? `\n${list.length - show.length} more on Today.` : ""}`, ids: show.map((r) => r.id), route: "" };
  }

  // ---------------------------------------------------------------- rendering an answer
  const ROUTE_NAME = { today: "Today", patients: "Patients", "patients-today": "Patients · Act today", "patients-alert": "Patients · Alert", "patients-watch": "Patients · Keep an eye on", calls: "Calls", care: "Hospital risk", research: "Research" };
  function routeLabel(route, rows) {
    const m = route.match(/^(p|live)-([a-z0-9]+-[A-Za-z0-9]+)(?:\.(c\d))?$/);
    if (m) return m[1] === "live" ? `Call with ${nameOf(m[2], rows)}` : `${nameOf(m[2], rows)} · ${m[3] ? MODS[m[3]].name : "Health chart"}`;
    if (/^call-/.test(route)) return "the call";
    return ROUTE_NAME[route] || "the page";
  }
  // Answer text: escape, drop echoed "[ids: …]", and turn cited ids (full, short or route) into the patient's name.
  function linkify(text, ids, rows) {
    let h = esc(String(text || "").replace(/\s*\[ids?:[^\]]*\]/gi, "").trim());
    for (const id of ids || []) {
      const nm = nameOf(id, rows), sh = shortOf(id), a = (label) => `<a href="#p-${esc(id)}">${esc(label)}</a>`;
      h = h.replace(new RegExp(`#?(?:p|live)-${id}(?:\\.c\\d)?|\\b${id}\\b`, "g"), () => a(nm));
      if (sh !== nm) h = h.replace(new RegExp(`(?<![\\w>-])${sh}\\b(?![^<]*</a>)`, "g"), () => (h.includes(esc(nm)) ? a(sh) : a(nm)));
      else if (!h.includes(`>${esc(nm)}</a>`)) h = h.replace(new RegExp(`(?<![\\w>-])${sh}\\b`), () => a(nm));
    }
    return h;
  }
  const metaHtml = (route, ids, rows, label = "", body = "") => {
    const navId = (route.match(/^(?:p|live)-([a-z0-9]+-[A-Za-z0-9]+)/) || [])[1];
    const opened = route ? `Opened <a href="#${esc(route)}">${esc(routeLabel(route, rows))}</a> ` : "";
    const rest = (ids || []).filter((id) => id !== navId && !body.includes(`href="#p-${esc(id)}"`)).slice(0, 12).map((id) => `<a href="#p-${esc(id)}">${esc(nameOf(id, rows))}</a>`).join("");
    return opened || rest || label ? `<span class="meta">${label}${opened}${rest}</span>` : "";
  };

  // Suggestion chips: rebuilt from the last answer, so the next step is one tap.
  const DEFAULT_CHIPS = ["Who needs me today?", "Who is most at risk of the hospital?", "What does time in range mean?"];
  function chips(list) {
    const s = document.getElementById("ellie-sugg");
    s.innerHTML = list.map((c) => typeof c === "string" ? `<button type="button">${esc(c)}</button>` : `<button type="button" data-q="${esc(c.q)}">${esc(c.label)}</button>`).join("");
    s.hidden = !list.length;
  }
  function chipsFor(turn, rows) {
    if (turn && turn.chips) return turn.chips;
    const ids = (turn && turn.ids) || [];
    const ps = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    if (!ps.length) return DEFAULT_CHIPS;
    const act = (p, ord) => (p.mod === "c1" ? { label: `Open ${first(p)}’s hospital risk`, q: `open ${ord} hospital risk` } : { label: `Start a call with ${first(p)}`, q: `start a call with ${ord}` });
    if (ps.length === 1) { const p = ps[0]; return [act(p, "them"), { label: `Open ${first(p)}’s health chart`, q: `open them` }, `Why is ${first(p)} ${p.tri === "ok" ? "on track" : "flagged"}?`, "Who needs me today?"]; }
    return [{ label: `Open ${first(ps[0])}`, q: "open the first one" }, act(ps[0], "the first one"), { label: `Open ${first(ps[1])}`, q: "open the second one" }, ps[2] && { label: `Open ${first(ps[2])}`, q: "open the third one" }].filter(Boolean);
  }
  // Answer the turn: render, remember it, follow the route. Phones and narrow screens close the panel so the page shows.
  function finish(wait, q, out, rows, label = "") {
    history.push({ role: "user", text: q }, { role: "ellie", text: out.text, ids: out.ids || [], chips: out.chips });
    const body = linkify(out.text, out.ids, rows);
    wait.innerHTML = `${body}${metaHtml(out.route || "", out.ids, rows, label, body)}`;
    keep(wait);
    chips(chipsFor(history[history.length - 1], rows));
    if (out.route) { wait.dataset.nav = out.route; location.hash = "#" + out.route; if (!docked()) setTimeout(() => toggle(false), 650); }
  }

  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function askModel(payload, wait) {
    try { return await P.post("/api/ellie", payload); }
    catch (e) {
      console.warn("Ellie: first try failed", e);
      wait.innerHTML = `<span class="muted">Ellie is busy, retrying…</span>`;
      await sleep(2_500);
      return P.post("/api/ellie", payload);
    }
  }

  async function ask(q, shown) {
    if (busy || !q.trim()) return;
    busy = true; lastQ = q;
    document.getElementById("ellie-sugg").hidden = true;
    keep(say("u", esc(shown || q)));
    const wait = say("a", `<span class="muted">Thinking…</span>`);
    let rows = [];
    try {
      ({ rows } = await once("roster", A.roster));
      const pick = whichOne(q, rows);
      if (pick) { finish(wait, q, pick, rows); return; }
      const quick = resolveRef(q, rows) || quickRoute(q, rows) || todayAnswer(q, rows);
      if (quick) { finish(wait, q, quick, rows); return; }
      if (SNAP) { wait.innerHTML = `Ellie needs the live site to reach the model. Opening pages and “who needs me today” still work here.<span class="meta"><a href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a></span>`; return; }
      const counts = rows.reduce((c, r) => ((c[r.tri] = (c[r.tri] || 0) + 1), c), { total: rows.length });
      let matches = named(q, rows).map(compactRow);
      if (matches.length && matches.length <= 2) matches = await Promise.all(matches.map((m) => once("p:" + m.id, () => A.patient(m.id)).then(compactPatient).catch(() => m)));
      const r = await askModel({ question: q, history: history.slice(-8).map(({ role, text, ids }) => ({ role, text, ids })), page: readPage(), patient: compactPatient(P.current()), matches, counts, roster: rosterForModel(rows) }, wait);
      const label = r.kind === "medical" ? `<span class="ai-label">AI · check before acting</span> ` : "";
      finish(wait, q, { text: r.answer, ids: r.cites || [], route: r.navigate || "" }, rows, label);
    } catch (e) {
      console.warn("Ellie:", e);
      wait.innerHTML = `Ellie is busy right now, so I couldn’t answer that. Opening pages, “open the first one” and “who needs me today” still work.<span class="meta"><button type="button" class="ellie-retry">Try again</button></span>`;
      chips(chipsFor([...history].reverse().find((h) => h.role === "ellie"), rows));
    } finally {
      busy = false;
      msgs().scrollTop = msgs().scrollHeight;
    }
  }

  fab.addEventListener("click", () => toggle());
  box.addEventListener("click", (e) => {
    if (e.target.closest("#ellie-close")) { toggle(false); return; }
    if (e.target.closest("#ellie-clear")) { history.length = 0; bubbles.length = 0; persist(); [...msgs().children].slice(1).forEach((n) => n.remove()); chips(DEFAULT_CHIPS); document.getElementById("ellie-q").focus(); return; }
    const rt = e.target.closest(".ellie-retry"); if (rt) { rt.closest(".m").remove(); const u = [...msgs().querySelectorAll(".m.u")].pop(); if (u) u.remove(); bubbles.pop(); persist(); ask(lastQ); return; }
    const s = e.target.closest("#ellie-sugg button"); if (s) ask(s.dataset.q || s.textContent, s.textContent);
  });
  box.addEventListener("submit", (e) => { e.preventDefault(); const i = document.getElementById("ellie-q"); const q = i.value; i.value = ""; ask(q); });
  box.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" && e.target.id === "ellie-q" && !e.target.value && lastQ) { e.preventDefault(); e.target.value = lastQ; } });
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) { e.preventDefault(); toggle(false); return; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); if (!open) toggle(true); else document.getElementById("ellie-q").focus(); return; }
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) { e.preventDefault(); if (!open) toggle(true); else document.getElementById("ellie-q").focus(); }
  });

  // Restore the thread from this tab's session, then the chips that follow from the last answer.
  bubbles.forEach((b) => { const d = document.createElement("div"); d.className = b.cls; d.innerHTML = b.html; msgs().appendChild(d); });
  chips(DEFAULT_CHIPS);
  if (history.length) once("roster", A.roster).then(({ rows }) => chips(chipsFor([...history].reverse().find((h) => h.role === "ellie"), rows))).catch(() => {});

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
    const said = quotesOf(p)[0];
    return { headline: said ? `The patient said: ${said.replace(/^[^“]*“/, "“")}` : p.headline || "No summary from this program yet.", bullets: advice.slice(0, 3).map(cut15), fallback: true };
  }
  function paintInsight(el, x) {
    const top = x.fallback ? `<span class="ei-src">From the program’s own record</span>` : `<span class="ai-label">AI · check before acting</span>`;
    el.innerHTML = `<div class="ei-top"><b>Ellie’s insight</b>${top}</div><p class="ei-line">${esc(x.headline)}</p>${x.bullets && x.bullets.length ? `<ul class="ei-list">${x.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}`;
  }
  // One request per patient+data version, shared by the chart and the prefetch below.
  const inflight = new Map();
  function getInsight(p) {
    const cp = compactPatient(p), key = `ellie-insight:${p.id}:${hash(JSON.stringify(cp))}`;
    const have = insights.get(key) || lsGet(key);
    if (have) return Promise.resolve(have);
    if (!inflight.has(key)) inflight.set(key, P.post("/api/insight", { patient: cp }).catch(() => sleep(2_500).then(() => P.post("/api/insight", { patient: cp })))
      .then((r) => { const x = { headline: r.headline, bullets: r.bullets || [] }; lsSet(key, x); insights.set(key, x); return x; })
      .catch(() => fallbackInsight(p)).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }
  // Prefetch: while Today is on screen, warm the insight for the patients it lists (one at a time, idle),
  // so the chart a clinician opens from Today shows its insight at once.
  async function prefetchToday() {
    if (SNAP || !/^#?(today)?$/.test(location.hash)) return;
    try {
      const { rows } = await once("roster", A.roster);
      for (const r of ordered(rows.filter((x) => x.tri === "today")).slice(0, 8)) {
        if (!/^#?(today)?$/.test(location.hash)) return;
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
    el.innerHTML = `<div class="ei-top"><b>Ellie’s insight</b><span class="ei-src">reading the chart…</span></div><div class="ei-skel" aria-hidden="true"><i></i><i></i><i></i></div>`;
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

  window.Ellie = { ask, toggle, readPage, severity: sev };
})();
