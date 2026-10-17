/* Ellie: the clinician's assistant. Natural language to (1) open a page, (2) find and explain a patient's
   information, (3) answer general medical questions. Patients are found here, in code, by name or ID, and
   only those (plus the patient on screen) go to the model. The worker checks every page Ellie wants to
   open against the known routes and ids before the app follows it. */
(function () {
  "use strict";
  const P = window.P360;
  const { esc, once, A, MODS, SNAP, LIVE_URL } = P;
  const history = [];
  let open = false, busy = false;

  const fab = document.createElement("button");
  fab.className = "ellie-fab"; fab.id = "ellie-fab"; fab.type = "button";
  fab.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Ask Ellie`;
  const box = document.createElement("section");
  box.className = "ellie"; box.id = "ellie"; box.hidden = true; box.setAttribute("aria-label", "Ellie assistant");
  box.innerHTML = `<header><b>Ellie</b><span class="small" style="opacity:.75">clinician assistant</span><button type="button" id="ellie-close" aria-label="Close Ellie">Close</button></header>
    <div class="msgs" id="ellie-msgs" aria-live="polite"><div class="m a">Hi, I’m Ellie. Ask me to open a page, find a patient, explain what their numbers mean, or a general medical question.<span class="meta">I read the same data you see. Check anything clinical before acting.</span></div></div>
    <div class="sugg" id="ellie-sugg"><button type="button">Who needs a call today?</button><button type="button">Open glucose for N0072</button><button type="button">What does time in range mean?</button></div>
    <form id="ellie-form"><input id="ellie-q" placeholder="Ask Ellie…" autocomplete="off" aria-label="Ask Ellie"><button type="submit">Send</button></form>`;
  document.body.append(fab, box);

  const msgs = () => document.getElementById("ellie-msgs");
  function say(role, html) { const d = document.createElement("div"); d.className = `m ${role}`; d.innerHTML = html; msgs().appendChild(d); msgs().scrollTop = msgs().scrollHeight; return d; }
  function toggle(v) { open = v ?? !open; box.hidden = !open; fab.hidden = open; if (open) document.getElementById("ellie-q").focus(); }

  const compactRow = (r) => ({ id: r.id, name: r.name, program: MODS[r.mod].name, status: r.tri, headline: r.headline, tags: r.tags.map((t) => t.label) });
  function compactPatient(p) {
    if (!p) return null;
    return { id: p.id, name: p.name, program: MODS[p.mod].name, status: p.tri, headline: p.headline, facts: p.facts, tags: (p.tags || []).map((t) => t.label),
      kpis: (p.kpis || []).map((k) => `${k.label}: ${k.value}${k.sub ? " (" + k.sub + ")" : ""}`),
      advice: (p.panels || []).flatMap((pn) => (pn.advice || []).map((a) => `${a.title}${a.text ? ": " + a.text : ""}`)).slice(0, 8),
      details: (p.panels || []).map((pn) => pn.title + (pn.lead ? ": " + pn.lead : "")).slice(0, 10),
      footnote: p.footnote || "" };
  }
  // Find patients the question names: a display-name word, a short id (N0072, P0117) or a full id.
  function findPatients(q, rows) {
    const low = q.toLowerCase();
    const words = new Set(low.split(/[^a-z0-9áéíóúñü-]+/i).filter((w) => w.length >= 3));
    const hits = rows.filter((r) => {
      const first = r.name.split(" · ")[0].toLowerCase(), short = r.id.split("-").slice(1).join("-").toLowerCase();
      return low.includes(r.id.toLowerCase()) || words.has(short) || (first.length >= 3 && words.has(first));
    });
    if (!hits.length && /today|urgent|call|alert|who|priorit|need/i.test(q)) return rows.filter((r) => r.tri === "today" || r.tri === "alert").slice(0, 10);
    return hits.slice(0, 12);
  }

  // Plain "open X (for Y)" commands are handled here, instantly; everything else goes to the model.
  const PAGES = [[/glucose|blood sugar|c4/i, "c4"], [/rough week|bad week|wearable|c3/i, "c3"], [/hospital risk|acute|er visit|c1/i, "c1"], [/coaching call|calls? history|c5/i, "c5"], [/health chart|overview|360/i, ""]];
  function quickRoute(q, rows) {
    if (!/^\s*(open|show|go to|take me to|pull up|navigate to)\b/i.test(q)) return null;
    const who = findPatients(q, rows).filter((r) => q.toLowerCase().includes(r.id.toLowerCase()) || q.toLowerCase().includes(r.id.split("-").slice(1).join("-").toLowerCase()) || q.toLowerCase().includes(r.name.split(" · ")[0].toLowerCase()));
    const page = PAGES.find(([re]) => re.test(q));
    if (who.length === 1) {
      const p = who[0];
      if (/\bcall\b/i.test(q) && /start|begin|new/i.test(q)) return { route: `live-${p.id}`, text: `Starting a call with ${p.name}.` };
      if (/app|phone/i.test(q)) return { route: `app-${p.id}`, text: `Opening ${p.name}’s app view.` };
      const tab = page ? page[1] : "";
      return { route: `p-${p.id}${tab ? "." + tab : ""}`, text: `Opening ${p.name}${tab ? ", " + MODS[tab].name : ""}.${tab && tab !== p.mod ? ` They aren’t enrolled in ${MODS[tab].name}, so that view will be empty.` : ""}` };
    }
    if (who.length) return null;
    const cur = P.current();
    if (cur && page && page[1] !== undefined) return { route: `p-${cur.id}${page[1] ? "." + page[1] : ""}`, text: `Opening ${page[1] ? MODS[page[1]].name : "the health chart"} for ${cur.name}.` };
    for (const [re, route, text] of [[/patients|everyone|list/i, "patients", "Opening the Patients list."], [/today/i, "today", "Opening Today."], [/calls/i, "calls", "Opening Calls."], [/hospital risk|care team/i, "care", "Opening Hospital risk."], [/research/i, "research", "Opening Research."]])
      if (re.test(q)) return { route, text };
    return null;
  }

  async function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    document.getElementById("ellie-sugg").hidden = true;
    say("u", esc(q));
    const wait = say("a", `<span class="muted">Thinking…</span>`);
    if (SNAP) { wait.innerHTML = `Ellie needs the live site to reach the model.<span class="meta"><a href="${LIVE_URL}" target="_blank" rel="noopener">Open the live site ↗</a></span>`; busy = false; return; }
    try {
      const { rows } = await once("roster", A.roster);
      const quick = quickRoute(q, rows);
      if (quick) {
        history.push({ role: "user", text: q }, { role: "ellie", text: quick.text });
        wait.innerHTML = `${esc(quick.text)}<span class="meta">Opened <a href="#${esc(quick.route)}">${esc(quick.route)}</a></span>`;
        wait.dataset.nav = quick.route; location.hash = "#" + quick.route; busy = false; return;
      }
      const counts = rows.reduce((c, r) => ((c[r.tri] = (c[r.tri] || 0) + 1), c), { total: rows.length });
      let matches = findPatients(q, rows).map(compactRow);
      if (matches.length && matches.length <= 2) matches = await Promise.all(matches.map((m) => once("p:" + m.id, () => A.patient(m.id)).then(compactPatient).catch(() => m)));
      const r = await P.post("/api/ellie", { question: q, history, page: { route: location.hash || "#today", title: document.querySelector("#view h1")?.textContent || "" }, patient: compactPatient(P.current()), matches, counts });
      history.push({ role: "user", text: q }, { role: "ellie", text: r.answer });
      const cites = (r.cites || []).map((id) => { const row = rows.find((x) => x.id === id); return `<a href="#p-${esc(id)}">${esc(row ? row.name : id)}</a>`; }).join("");
      const label = r.kind === "medical" ? `<span class="ai-label">AI · check before acting</span> ` : "";
      wait.innerHTML = `${esc(r.answer)}<span class="meta">${label}${r.navigate ? `Opened <a href="#${esc(r.navigate)}">${esc(r.navigate)}</a> ` : ""}${cites}</span>`;
      if (r.navigate) { wait.dataset.nav = r.navigate; location.hash = "#" + r.navigate; }
    } catch (e) { wait.innerHTML = `Sorry, I couldn’t answer that (${esc(e.message)}). Try again.`; }
    busy = false;
    msgs().scrollTop = msgs().scrollHeight;
  }

  fab.addEventListener("click", () => toggle(true));
  box.addEventListener("click", (e) => {
    if (e.target.id === "ellie-close") toggle(false);
    if (e.target.closest("#ellie-sugg button")) ask(e.target.textContent);
  });
  box.addEventListener("submit", (e) => { e.preventDefault(); const i = document.getElementById("ellie-q"); const q = i.value; i.value = ""; ask(q); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) toggle(false); });
  window.Ellie = { ask, toggle };
})();
