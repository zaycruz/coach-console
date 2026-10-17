/**
 * Patient 360: one origin for the care team's app and the module APIs.
 *   GET  /api/c1/*            -> c1-acute-risk (Care Team Risk), service binding
 *   GET  /api/c3/*            -> c3-rough-patch (Bad Week Radar), service binding
 *   GET  /api/c4/*            -> c4-glucose-guide (Dose and Timing), service binding
 *   GET  /api/c5/survivors[/:id], /api/c5/calls[/:id]
 *                             -> coach-copilot's own /api/c5/* when it answers; until then an adapter over its labelled call set
 *   POST /api/c5/turn|review|cue -> coach-copilot-clef /api/turn|review|cue (the live model)
 *   GET|POST /api/calls/:patientId -> calls started in this app, saved in KV (newest first); GET /api/calls = index of all
 *   GET|POST /api/handoffs    -> hand-offs to the care team (who, when, patient, flagged line, note), KV, newest first
 *   POST /api/recap           -> GLM summary of the last call, for picking the conversation back up
 *   POST /api/ellie           -> Ellie, the clinician assistant: a small GLM tool loop (search/get patient, read page; navigate/open tab/start call)
 *   POST /api/insight         -> Ellie's insight for one patient (headline + up to 3 bullets), cached in KV by patient id + data hash
 * Everything else is the static app in ./public.
 */
import PEOPLE from "./c5-people.json";

interface Fetcher { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }
declare const caches: { default: Cache };
interface KV { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
interface Ai { run(model: string, input: unknown): Promise<unknown> }
interface Env { ASSETS: Fetcher; C1: Fetcher; C3: Fetcher; C4: Fetcher; C5: Fetcher; AI: Ai; CALLS: KV }

interface CallLine {
  line_number: number; time_in_call: string; speaker: "coach" | "participant"; text: string;
  coach_move: string | null; participant_talk: string | null; needs_human: string | null;
}
interface Call {
  call_id: string; participant_id: string; coach_id: string; call_number: number; program_week: number;
  date: string; start_time: string; language: string; goal_topic: string; duration_min: number; lines: CallLine[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });

// Same arithmetic as the Copilot's live screen (coach-copilot/public/index.html updateScore).
const SUPPORT = new Set(["affirm", "seek collaboration", "emphasize autonomy", "ask permission"]);
export function scoreMoves(moves: string[]) {
  const n = (t: string) => moves.filter((m) => m === t).length;
  const oq = n("open question"), cq = n("closed question"), sr = n("simple reflection"), cr = n("complex reflection");
  const ad = moves.filter((m) => SUPPORT.has(m)).length, na = n("persuade") + n("confront");
  const q = oq + cq, r = sr + cr;
  const parts = {
    reflectionsPerQuestion: { value: q ? +(r / q).toFixed(2) : null, target: 2, points: Math.round(30 * Math.min((q ? r / q : r ? 2 : 0) / 2, 1)), max: 30 },
    complexReflectionPct: { value: r ? Math.round((100 * cr) / r) : null, target: 40, points: Math.round(20 * Math.min((r ? cr / r : 0) / 0.4, 1)), max: 20 },
    openQuestionPct: { value: q ? Math.round((100 * oq) / q) : null, target: 50, points: Math.round(20 * Math.min((q ? oq / q : 0) / 0.5, 1)), max: 20 },
    miConsistent: { value: `${ad} vs ${na}`, target: "no persuade or confront", points: Math.round(30 * (ad + na ? ad / (ad + na) : 1)), max: 30 },
  };
  const score = moves.length < 4 ? null : Object.values(parts).reduce((s, p) => s + p.points, 0);
  return { score, parts };
}

const FLAG_WORDS: Record<string, string[]> = {
  distress: ["hopeless", "no point", "sin esperanza", "no vale la pena", "give up", "rendirme"],
  social: ["food", "comida", "money", "dinero", "rent", "renta", "ride", "transport", "pay"],
};
// Supervisor labels say only yes/no; the live model gives the kind. This guess is for the roster headline only.
const flagKind = (t: string) => Object.entries(FLAG_WORDS).find(([, ws]) => ws.some((w) => t.toLowerCase().includes(w)))?.[0] ?? "medical";

let cache: { at: number; calls: Call[] } | null = null;
async function loadCalls(env: Env): Promise<Call[]> {
  if (cache && Date.now() - cache.at < 300_000) return cache.calls;
  const r = await env.C5.fetch("https://coach-copilot/demo-calls.json");
  if (!r.ok) throw new Error(`coach-copilot demo-calls.json: HTTP ${r.status}`);
  const calls = ((await r.json()) as { calls: Call[] }).calls;
  cache = { at: Date.now(), calls };
  return calls;
}

function callView(c: Call) {
  const p = (PEOPLE.participants as Record<string, Record<string, string>>)[c.participant_id];
  const coach = (PEOPLE.coaches as Record<string, Record<string, string>>)[c.coach_id];
  const moves = c.lines.filter((l) => l.speaker === "coach" && l.coach_move).map((l) => l.coach_move as string);
  const { score, parts } = scoreMoves(moves);
  const flags = c.lines.filter((l) => l.needs_human === "yes").map((l) => ({ line: l.line_number, t: l.time_in_call, kind: flagKind(l.text), text: l.text }));
  return {
    callId: c.call_id, survivorId: `c5-${c.participant_id}`, participantName: p?.first_name ?? c.participant_id,
    coach: { id: c.coach_id, name: coach?.name ?? c.coach_id, role: coach?.role ?? "" },
    date: c.date, start: c.start_time, language: c.language, goalTopic: c.goal_topic,
    callNumber: c.call_number, week: c.program_week, durationMin: c.duration_min,
    labels: "supervisor", score, scoreParts: parts, flags,
    lines: c.lines.map((l) => ({ n: l.line_number, t: l.time_in_call, speaker: l.speaker, text: l.text,
      supervisor: l.speaker === "coach" ? { move: l.coach_move } : { talk: l.participant_talk, needsHuman: l.needs_human === "yes" } })),
  };
}

type View = ReturnType<typeof callView>;
const statusOf = (v: Pick<View, "flags" | "score">) => (v.flags.length ? "alert" : v.score != null && v.score < 60 ? "watch" : "ok");
const headlineOf = (v: View) =>
  v.flags.length ? `${v.flags[0].kind[0].toUpperCase() + v.flags[0].kind.slice(1)} concern at ${v.flags[0].t} in call ${v.callNumber}: a person must follow up today`
  : v.score != null && v.score < 60 ? `Coach score ${v.score}/100 on call ${v.callNumber}: below the 60 target`
  : `Coach score ${v.score ?? "–"}/100 on call ${v.callNumber}`;

async function c5(env: Env, path: string[]) {
  const views = (await loadCalls(env)).map(callView);
  if (path[0] === "calls" && !path[1]) {
    return json(views.map(({ lines, ...v }) => ({ ...v, status: statusOf(v), lines: lines.length }))
      .sort((a, b) => b.flags.length - a.flags.length || (a.score ?? 0) - (b.score ?? 0)));
  }
  if (path[0] === "calls") {
    const v = views.find((x) => x.callId === path[1]);
    return v ? json({ ...v, status: statusOf(v) }) : json({ error: "call not found", callId: path[1] }, 404);
  }
  const byPerson = new Map<string, View[]>();
  for (const v of views) byPerson.set(v.survivorId, [...(byPerson.get(v.survivorId) ?? []), v]);
  const latestFirst = (vs: View[]) => [...vs].sort((a, b) => b.date.localeCompare(a.date));
  const rank = { alert: 0, watch: 1, ok: 2 } as const;
  if (path[0] === "survivors" && !path[1]) {
    const rows = [...byPerson.entries()].map(([id, vs]) => {
      const worst = [...vs].sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)])[0];
      const p = (PEOPLE.participants as Record<string, Record<string, string>>)[id.slice(3)];
      return { survivorId: id, displayName: `${worst.participantName} · ${p ? `${p.age}${p.sex[0].toUpperCase()} · ${p.cancer_type}` : id.slice(3)}`,
        status: statusOf(worst), headline: headlineOf(worst), updatedAt: latestFirst(vs)[0].date };
    });
    return json(rows.sort((a, b) => rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank] || a.survivorId.localeCompare(b.survivorId)));
  }
  if (path[0] === "survivors") {
    const vs = byPerson.get(path[1]);
    if (!vs) return json({ error: "survivor not found", survivorId: path[1] }, 404);
    const worst = [...vs].sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)])[0];
    const p = (PEOPLE.participants as Record<string, Record<string, string>>)[path[1].slice(3)];
    return json({
      survivorId: path[1], displayName: `${worst.participantName} · ${p ? `${p.age}${p.sex[0].toUpperCase()} · ${p.cancer_type}` : ""}`,
      status: statusOf(worst), headline: headlineOf(worst),
      summary: p ? `${p.age}-year-old ${p.sex}, ${p.cancer_type} cancer. Program focus: ${p.program_focus}. Calls in ${p.call_language}. Coach ${worst.coach.name} (${worst.coach.role}).` : "",
      profile: p ? { firstName: p.first_name, age: +p.age, sex: p.sex, cancerType: p.cancer_type, language: p.call_language, focus: p.program_focus, coach: worst.coach.name } : {},
      evidence: [
        ...worst.flags.map((f) => ({ kind: `flag-${f.kind}`, text: `${f.t} “${f.text}”`, source: "supervisor label" })),
        ...latestFirst(vs).map((v) => ({ kind: "call", text: `Call ${v.callNumber} (week ${v.week}, ${v.date}): coach score ${v.score ?? "–"}/100`, callId: v.callId })),
      ],
      recommendations: worst.flags.length
        ? worst.flags.map((f) => ({ action: { medical: "Tell the care team today and log the hand-off.", social: "Connect to a navigator today (food, money, transport).", distress: "Check in today and connect to psycho-oncology support." }[f.kind], urgency: "today" }))
        : statusOf(worst) === "watch" ? [{ action: "Review this call with the coach in supervision; start with the cue moments.", urgency: "this week" }]
        : [{ action: "No action. Keep the call schedule.", urgency: "routine" }],
      charts: { calls: latestFirst(vs).map(({ lines, ...v }) => ({ ...v, status: statusOf(v), lines: lines.length })) },
    });
  }
  return json({ error: "not found" }, 404);
}

const C5_POST = new Set(["turn", "review", "cue"]);

// ---------------------------------------------------------------- GLM (same model and call shape as coach-copilot)
const GLM = "@cf/zai-org/glm-5.3-flash";
const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const FALLBACK_LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
async function glm(env: Env, system: string, user: string, schema: Record<string, unknown>, maxTokens = 1_200) {
  const call = () => env.AI.run(GLM, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_completion_tokens: maxTokens, reasoning_effort: "low",
    response_format: { type: "json_schema", json_schema: schema },
  });
  // Workers AI rate-limits GLM per minute (error 3021) when the room is busy. Retry once after a pause, then
  // fall back to Llama 3.3 70B with the same JSON schema, so Ellie, insights and recaps keep answering.
  const fallback = () => env.AI.run(FALLBACK_LLM, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens,
    response_format: { type: "json_schema", json_schema: (schema as { schema: unknown }).schema },
  });
  const raw = await call().catch(async (e) => { if (/3021|rate limit/i.test(String(e))) await new Promise((ok) => setTimeout(ok, 1_200)); return call(); }).catch(() => fallback()).catch(() => null);
  if (!isRec(raw)) return null;
  const choice = Array.isArray(raw.choices) && isRec(raw.choices[0]) ? raw.choices[0] : null;
  const text = choice && isRec(choice.message) ? choice.message.content : raw.response;
  if (isRec(text)) return text;
  if (typeof text !== "string") return null;
  try { const p: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); return isRec(p) ? p : null; } catch { return null; }
}
const clip = (x: unknown, n: number) => JSON.stringify(x ?? null).slice(0, n);

// Routes Ellie may open. Anything else she suggests is dropped.
const ROUTE_OK = /^(today|patients(-(today|alert|watch|ok))?|calls|care|research|call-[A-Za-z0-9]+|live-[a-z0-9]+-[A-Za-z0-9]+|p-[a-z0-9]+-[A-Za-z0-9]+(\.(c1|c3|c4|c5))?)$/;

// ---------------------------------------------------------------- Ellie: a small tool loop (JSON steps, GLM)
// Each step the model returns one flat object: a data tool to run (search_patients, get_patient, read_page),
// an action that ends the turn (navigate, open_tab, start_call), or "answer". The worker runs data tools and
// loops (max 4 model calls). The client pre-sends the page summary, the roster and the ids from earlier turns,
// so most asks take one or two calls.
type Row = { id: string; name: string; mod: string; tri: string; headline: string; tags: string[] };
const PROG_NAME: Record<string, string> = { c1: "Hospital risk", c3: "Rough weeks", c4: "Glucose", c5: "Coaching calls" };
const TRI_RANK: Record<string, number> = { today: 0, alert: 1, watch: 2, ok: 3 };
const shortId = (id: string) => id.split("-").slice(1).join("-");
// ER/hospital chance on a roster row: C1 "Acute care risk 73%", C3 "ER/hospital 12%" (urgent rows).
const hospRisk = (r: Row) => { const m = `${r.headline} ${r.tags.join(" ")}`.match(/(?:acute care risk|hospital risk|ER\/hospital)\s*(\d+(?:\.\d+)?)%/i); return m ? +m[1] : -1; };
// Severity inside a status, worst first (same rule as ellie.js sev): urgent 7-day ER risk, call concerns, then each
// program's own number (C1 next-year risk, C4 lowest time in range or most lows). Lists feed "the first one".
const numIn = (s: string, re: RegExp) => { const m = s.match(re); return m ? +m[1] : null; };
function sev(r: Row) {
  const h = `${r.headline} ${r.tags.join(" ")}`;
  if (r.mod === "c3") { const er = numIn(h, /ER or hospital risk (\d+(?:\.\d+)?)%/i), x = numIn(h, /about (\d+(?:\.\d+)?)x usual/i); return er != null ? 1000 + (x || 0) * 10 + er : numIn(h, /rough patch risk (\d+)%/i) || 0; }
  if (r.mod === "c5") return r.tri === "today" ? 900 : 50;
  if (r.mod === "c1") return numIn(h, /(?:acute care|ER or hospital) risk (\d+(?:\.\d+)?)%/i) || 0;
  const tir = numIn(h, /(\d+(?:\.\d+)?)% in range/i), lows = numIn(h, /(\d+(?:\.\d+)?)% of readings below/i);
  return Math.max(tir != null ? 100 - tir : 0, lows != null ? lows * 10 : 0);
}
const bySeverity = (x: Row, y: Row) => (TRI_RANK[x.tri] ?? 9) - (TRI_RANK[y.tri] ?? 9) || sev(y) - sev(x);
const first = (r: Row) => r.name.split(" · ")[0] || shortId(r.id);

function searchPatients(rows: Row[], a: { query?: string; status?: string; program?: string; sort?: string }) {
  const words = String(a.query || "").toLowerCase().split(/[^a-z0-9áéíóúñü%/-]+/i).filter((w) => w.length >= 3 && !/^(who|the|and|patient|patients|most|risk|with|for|are|is)$/.test(w));
  let hits = rows.filter((r) => (!a.status || r.tri === a.status || (a.status === "alert" && r.tri === "today")) && (!a.program || r.mod === a.program));
  if (words.length) {
    const scored = hits.map((r) => { const hay = `${r.id} ${r.name} ${r.headline} ${r.tags.join(" ")} ${PROG_NAME[r.mod] || ""}`.toLowerCase(); return { r, s: words.filter((w) => hay.includes(w)).length }; });
    const best = scored.filter((x) => x.s > 0);
    if (best.length) hits = best.sort((x, y) => y.s - x.s || bySeverity(x.r, y.r)).map((x) => x.r);
    else hits = [...hits].sort(bySeverity);
  } else hits = [...hits].sort(bySeverity);
  if (a.sort === "hospital") hits = hits.filter((r) => hospRisk(r) >= 0).sort((x, y) => hospRisk(y) - hospRisk(x));
  else if (a.sort === "priority") hits = [...hits].sort(bySeverity);
  return { total: hits.length, order: "most severe first", patients: hits.slice(0, 8).map((r) => ({ id: r.id, name: r.name, program: PROG_NAME[r.mod] || r.mod, status: r.tri, headline: r.headline.slice(0, 160), ...(hospRisk(r) >= 0 ? { hospitalRiskPct: hospRisk(r) } : {}) })) };
}

// Raw module record for one patient, by the same path the router uses. Charts are dropped (long arrays).
async function getPatient(env: Env, id: string) {
  const mod = id.split("-")[0];
  if (!/^[a-z0-9]+-[A-Za-z0-9]+$/.test(id) || !["c1", "c3", "c4", "c5"].includes(mod)) return { error: "unknown patient id" };
  let r: Response;
  if (mod === "c5") {
    const native = await env.C5.fetch(`https://coach-copilot/api/c5/survivors/${id}`).catch(() => null);
    r = native && native.ok && (native.headers.get("content-type") || "").includes("json") ? native : await c5(env, ["survivors", id]);
  } else r = await ({ c1: env.C1, c3: env.C3, c4: env.C4 }[mod] as Fetcher).fetch(`https://${mod}/api/${mod}/survivors/${encodeURIComponent(id)}`);
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const d = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!isRec(d)) return { error: "bad response" };
  const { charts, ...rest } = d;
  return { id, program: PROG_NAME[mod], ...rest };
}

const ELLIE_SCHEMA = { name: "ellie_step", strict: true, schema: { type: "object", additionalProperties: false,
  required: ["tool", "query", "status", "program", "sort", "id", "route", "answer", "cites", "kind"], properties: {
    tool: { type: "string", enum: ["answer", "search_patients", "get_patient", "read_page", "navigate", "open_tab", "start_call"] },
    query: { type: "string" }, status: { type: "string", enum: ["", "today", "alert", "watch", "ok"] },
    program: { type: "string", enum: ["", "c1", "c3", "c4", "c5"] }, sort: { type: "string", enum: ["", "hospital", "priority"] },
    id: { type: "string" }, route: { type: "string" }, answer: { type: "string" },
    cites: { type: "array", items: { type: "string" } }, kind: { type: "string", enum: ["navigation", "patient", "medical", "other"] } } } };

// Ellie never shows infrastructure text: any failure is a plain "busy" the client retries once.
const ELLIE_BUSY = "Ellie is busy";
async function ellie(env: Env, body: Record<string, unknown>) {
  try { return await ellieTurn(env, body); } catch (e) { console.warn("ellie", (e as Error).message); return json({ error: ELLIE_BUSY }, 503); }
}
async function ellieTurn(env: Env, body: Record<string, unknown>) {
  const question = String(body.question || "").slice(0, 1_000).trim();
  if (!question) return json({ error: "question is required" }, 400);
  const rows: Row[] = (Array.isArray(body.roster) ? body.roster : []).slice(0, 2_000).filter(isRec).map((r) => ({
    id: String(r.id || ""), name: String(r.name || ""), mod: String(r.mod || String(r.id || "").split("-")[0]), tri: String(r.tri || r.status || "ok"),
    headline: String(r.headline || ""), tags: (Array.isArray(r.tags) ? r.tags : []).map(String) })).filter((r) => r.id);
  const hist = (Array.isArray(body.history) ? body.history : []).filter(isRec).slice(-8);
  // Ids Ellie mentioned earlier, newest turn first, each turn in the order she listed them.
  const memory: string[] = [];
  for (const m of [...hist].reverse()) for (const id of Array.isArray(m.ids) ? m.ids : []) if (!memory.includes(String(id))) memory.push(String(id));
  const onScreen = isRec(body.patient) ? body.patient : null;
  const known = new Set<string>([...rows.map((r) => r.id), ...memory, ...(Array.isArray(body.matches) ? body.matches : []).filter(isRec).map((p) => String(p.id)), ...(onScreen ? [String(onScreen.id)] : [])]);
  // The model often writes the short id (P02185); map it back to the full one (c3-P02185).
  const resolve = (x: unknown) => { const s = String(x || "").replace(/^#/, "").trim(); if (known.has(s)) return s; const lo = s.toLowerCase(); return [...known].find((k) => k.toLowerCase() === lo || shortId(k).toLowerCase() === lo) || ""; };
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name || (onScreen && onScreen.id === id ? String(onScreen.name || "") : "") || id;
  const memLines = memory.slice(0, 12).map((id, i) => `${i + 1}. ${id} (${nameOf(id)})`).join("\n");
  const convo = hist.map((m) => `${m.role === "user" ? "Clinician" : "Ellie"}: ${String(m.text || "").slice(0, 400)}${Array.isArray(m.ids) && m.ids.length ? ` (patients named: ${m.ids.slice(0, 8).map((id) => nameOf(String(id))).join(", ")})` : ""}`).join("\n");
  const page = clip(body.page, 3_200);

  const system = `You are Ellie, the assistant inside Patient 360, a console for health coaches and care-team leads who look after cancer survivors (synthetic hackathon data). Your user is a clinician, never the patient. Call the people "patients", never "survivors".
Each step, return ONE JSON object. Set "tool" to:
- "search_patients": find patients in the roster. Fields: query (words, name or id; "" for all), status (today|alert|watch|ok or ""), program (c1 hospital risk | c3 rough weeks | c4 glucose | c5 coaching calls, or ""), sort ("hospital" = highest ER/hospital chance first, "priority" = most urgent first, or "").
- "get_patient": the full record for one patient. Field: id.
- "read_page": what is on the clinician's screen (already shown below as PAGE; only call it if PAGE is empty).
- "navigate": open a page and end the turn. Field: route, one of: today | patients | patients-today | patients-alert | patients-watch | calls | care (hospital risk list) | research | p-<id> (health chart) | call-<callId>.
- "open_tab": open one program tab of a patient and end the turn. Fields: id, program ("" = health chart).
- "start_call": open a live call with a patient and end the turn. Field: id.
- "answer": reply to the clinician and end the turn.
For navigate/open_tab/start_call/answer also fill "answer" (one short sentence for actions, e.g. "Opening S2480BBDE's hospital risk.") and "cites".
Rules:
- Patient facts come ONLY from the context and tool results. Never invent a number, date, diagnosis, name or id. If you lack a fact, use a tool or say so.
- "Who is most at risk of the hospital / ER": search_patients with sort "hospital". "Who needs a call / attention today": search_patients with sort "priority".
- "That patient", "them", "the first/second one" refer to RECENT PATIENTS below, in that order (1 = first). Act on them directly; do not search again.
- "cites": the full ids of patients your answer talks about, in the order you mention them. Do not cite the on-screen patient unless your answer is about them.
- Medical questions: concise mainstream clinical information (guideline level), say when it depends on the person, never diagnose or prescribe for a specific patient. Flag emergencies plainly. kind "medical".
- When you rank or list patients, start by naming the lens in a few words, e.g. "By hospital risk (next year):" or "By glucose, lowest time in range first:". Keep the order search_patients returned (most severe first); never re-sort by id.
- "Who needs me / a call today": the Act today list (search_patients status "today", sort "priority"), and give its total.
- Refer to patients by name (the part of "name" before " · "). Never write "[ids: …]", routes such as p-c1-S123 or full ids like c5-P0002 in "answer"; put ids in "cites".
- Plain words, short: two to five sentences unless asked for more. When listing patients, give each name with its key number. No markdown tables. Fill unused fields with "" or [].`;
  const base = `PAGE (read_page): ${page}
PATIENT ON SCREEN: ${clip(onScreen, 5_000)}
PATIENTS NAMED IN THE QUESTION: ${clip(body.matches, 4_000)}
ROSTER COUNTS: ${clip(body.counts, 300)} (${rows.length} patients searchable)
${memLines ? "RECENT PATIENTS (most recent list first):\n" + memLines + "\n" : ""}${convo ? "CONVERSATION SO FAR:\n" + convo + "\n" : ""}QUESTION: ${question}`;

  // Fast path: the two ranking questions clinicians ask most are answered straight from the roster, no model
  // call (6 s -> instant). Everything else goes through the tool loop.
  const ql = question.toLowerCase();
  const rank = /\b(who|which|top|most|highest|list|show)\b/.test(ql) && !/\b(why|what does|explain|mean)\b/.test(ql)
    ? /hospital|\ber\b|admission|acute/.test(ql) ? "hospital" : /\b(call|attention|urgent|today|priorit)/.test(ql) && !/\bstart\b/.test(ql) ? "priority" : "" : "";
  if (rank && rows.length) {
    const line = (r: Row, i: number) => `${i + 1}. ${first(r)} (${PROG_NAME[r.mod] || r.mod}): ${r.headline.replace(/\s+/g, " ").slice(0, 90)}`;
    let answer = "", cites: string[] = [];
    if (rank === "hospital") {
      // Two horizons, never mixed in one ranking: urgent 7-day ER risk (Rough weeks) first, then next-year risk (Hospital risk).
      const week = rows.filter((r) => r.mod === "c3" && r.tri === "today" && hospRisk(r) >= 0).sort(bySeverity);
      const year = rows.filter((r) => r.mod === "c1" && hospRisk(r) >= 0).sort((x, y) => hospRisk(y) - hospRisk(x)).slice(0, 5);
      const all = [...week, ...year];
      answer = (week.length ? `Urgent this week, by 7-day ER/hospital risk (Rough weeks):\n${week.map(line).join("\n")}\n` : "") +
        (year.length ? `By next-year ER/hospital risk (Hospital risk model, ${rows.filter((r) => r.mod === "c1" && hospRisk(r) >= 0).length} scored):\n${year.map((r, i) => line(r, i + week.length)).join("\n")}` : "");
      cites = all.map((r) => r.id);
    } else {
      const today = rows.filter((r) => r.tri === "today").sort(bySeverity), top = today.slice(0, 12);
      answer = top.length ? `By Today’s list (Act today, urgent ER risk first): ${today.length} need a person today.\n${top.map(line).join("\n")}` : "";
      cites = top.map((r) => r.id);
    }
    if (cites.length) return json({ answer: answer.trim() + `\nSay "open the first one" or "start a call with them".`, kind: "patient", navigate: "", cites, steps: ["search_patients"], model: "roster" });
  }

  const results: string[] = [];
  const steps: string[] = [];
  for (let i = 0; i < 4; i++) {
    const last = i === 3;
    const user = base + (results.length ? "\n\nTOOL RESULTS:\n" + results.join("\n") : "") + (last ? "\n\nYou must finish now: tool \"answer\" (or an action)." : "");
    const r = await glm(env, system, user, ELLIE_SCHEMA, 900);
    if (!r) return json({ error: ELLIE_BUSY }, 503);
    const tool = String(r.tool || "answer");
    steps.push(tool);
    if (!last && (tool === "search_patients" || tool === "get_patient" || tool === "read_page")) {
      let out: unknown;
      if (tool === "search_patients") {
        const res = searchPatients(rows, { query: String(r.query || ""), status: String(r.status || ""), program: String(r.program || ""), sort: String(r.sort || "") });
        out = res;
      } else if (tool === "get_patient") {
        const id = resolve(r.id) || String(r.id || "");
        out = await getPatient(env, id).catch((e) => ({ error: (e as Error).message }));
        if (isRec(out) && !out.error) known.add(id);
      } else out = body.page || "(no page summary)";
      results.push(`${results.length + 1}. ${tool}(${JSON.stringify({ query: r.query, status: r.status, program: r.program, sort: r.sort, id: r.id }).slice(0, 200)}) -> ${clip(out, 4_000)}`);
      continue;
    }
    // Final step: an action or an answer.
    let nav = "";
    const id = resolve(r.id);
    if (tool === "navigate") {
      const route = String(r.route || "").replace(/^#/, "").trim();
      // Accept short ids too: p-P02185.c1, live-P02185 -> the full id.
      const m = route.match(/^(p|live)-(.+?)(\.(c1|c3|c4|c5))?$/);
      const full = m ? (resolve(m[2]) ? `${m[1]}-${resolve(m[2])}${m[3] || ""}` : "") : route;
      if (full && ROUTE_OK.test(full)) nav = full;
    } else if (tool === "open_tab" && id) nav = `p-${id}${/^c[1345]$/.test(String(r.program)) ? "." + r.program : ""}`;
    else if (tool === "start_call" && id) nav = `live-${id}`;
    else if (tool === "answer" && id && /^\s*(opening|starting)\b/i.test(String(r.answer || ""))) nav = /^\s*starting/i.test(String(r.answer)) ? `live-${id}` : `p-${id}`;
    const answer = String(r.answer || "").replace(/\s*\[ids?:[^\]]*\]/gi, "").trim() || (nav ? "Opening it now." : "Sorry, I couldn't work that out. Try asking another way.");
    const low = answer.toLowerCase();
    // Cites = the model's cites plus any patient id written in the answer, ordered by where each first appears
    // in the answer, so "the first one" next turn means the first patient the clinician read.
    const pos = (id: string) => { const i = low.indexOf(shortId(id).toLowerCase()); return i < 0 ? Infinity : i; };
    const inText = (low.match(/\b[a-z0-9]*\d[a-z0-9]*\b/g) || []).map((w) => resolve(w)).filter(Boolean);
    const cites: string[] = [];
    for (const c of [...(Array.isArray(r.cites) ? r.cites : []), ...inText]) {
      const full = resolve(c);
      if (!full || cites.includes(full)) continue;
      // The on-screen patient is cited only when the answer is about them.
      if (onScreen && full === String(onScreen.id) && !low.includes(shortId(full).toLowerCase()) && !low.includes(nameOf(full).split(" · ")[0].toLowerCase())) continue;
      cites.push(full);
    }
    cites.sort((a, b) => pos(a) - pos(b) || 0);
    const navId = (nav.match(/^(?:p|live)-([a-z0-9]+-[A-Za-z0-9]+)/) || [])[1];
    if (navId && !cites.includes(navId)) cites.unshift(navId);
    return json({ answer, kind: String(r.kind || (nav ? "navigation" : "other")), navigate: nav, cites, steps, model: GLM });
  }
  return json({ error: ELLIE_BUSY }, 503);
}

// ---------------------------------------------------------------- Ellie's insight: one line + up to 3 bullets per patient
const insightMem = new Map<string, unknown>();
const words15 = (s: unknown) => { const w = String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean); return w.length > 15 ? w.slice(0, 15).join(" ").replace(/[,;:]$/, "") + "…" : w.join(" "); };
async function insight(env: Env, body: Record<string, unknown>) {
  const p = isRec(body.patient) ? body.patient : null;
  const id = p ? String(p.id || "") : "";
  if (!p || !/^[a-z0-9]+-[A-Za-z0-9]+$/.test(id)) return json({ error: "patient with an id is required" }, 400);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(p)));
  const hash = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `insight:${id}:${hash}`;
  const hit = insightMem.get(key) ?? JSON.parse((await env.CALLS.get(key).catch(() => null)) || "null");
  if (hit) { insightMem.set(key, hit); return json({ ...(hit as object), cached: true }); }
  const system = `You write "Ellie's insight" for a clinician (health coach or care-team lead) opening a cancer survivor's health chart. Use ONLY the patient data given, from every program it covers. If the data has "forEllie", that sentence is the hospital-risk bullet and is added for you: do not write another hospital-risk bullet. Return one headline sentence (what matters most right now, at most 20 words) and up to 3 bullets, each a recommendation or insight of at most 15 words, most important first. Lead with the action. Keep the numbers from the data. Call the person "the patient", never "survivor" or "participant". No diagnosis, no prescribing, no invented facts. Plain words.
The chart already shows the program's headline (given as "headline"). Do NOT repeat it or restate the alert ("medical concern needs follow-up", "a person must follow up today"). Add what it hides: when "patientWords" has a flagged line, the headline must name that symptom or need in plain clinical words (e.g. "New shortness of breath on light exertion (kitchen walk); call today and tell the care team.") and may quote up to 8 of the patient's words. Otherwise name the driver or trend behind the numbers.`;
  const schema = { name: "insight", strict: true, schema: { type: "object", additionalProperties: false, required: ["headline", "bullets"], properties: {
    headline: { type: "string" }, bullets: { type: "array", items: { type: "string" } } } } };
  const ask = () => glm(env, system, `PATIENT: ${clip(p, 6_000)}`, schema, 500);
  let r = await ask();
  if (!r || typeof r.headline !== "string" || !r.headline.trim()) r = await ask(); // GLM drops a JSON answer now and then
  if (!r || typeof r.headline !== "string" || !r.headline.trim()) return json({ error: "insight unavailable" }, 502);
  let bullets = (Array.isArray(r.bullets) ? r.bullets : []).map(words15).filter(Boolean).slice(0, 3);
  // C1's forEllie line (risk in words + driver + caveat) is used verbatim so the caveat is never dropped.
  if (typeof p.forEllie === "string" && p.forEllie.trim()) bullets = [p.forEllie.trim(), ...bullets.filter((b) => !/hospital risk|\bER\b/i.test(b))].slice(0, 3);
  const out = { id, headline: String(r.headline).trim().split(/(?<=[.!?])\s/)[0].slice(0, 220), bullets, model: GLM };
  insightMem.set(key, out);
  await env.CALLS.put(key, JSON.stringify(out)).catch(() => {});
  return json(out);
}

async function recap(env: Env, body: Record<string, unknown>) {
  const system = `You write a hand-off note so a health coach can pick up a coaching conversation with a cancer survivor. Use ONLY the transcript and facts given. No diagnosis. Plain words.`;
  const user = `PATIENT: ${clip(body.patient, 1_500)}\nLAST CALL: ${clip(body.last, 9_000)}`;
  const schema = { name: "recap", strict: true, schema: { type: "object", additionalProperties: false, required: ["summary", "pickUp", "openConcerns"], properties: {
    summary: { type: "string" }, pickUp: { type: "array", items: { type: "string" } }, openConcerns: { type: "array", items: { type: "string" } } } } };
  const r = (await glm(env, system, user, schema, 900)) || (await glm(env, system, user, schema, 900)); // one retry
  if (!r) return json({ error: "recap unavailable" }, 502);
  return json({ ...r, model: GLM });
}

async function savedCalls(env: Env, req: Request, pid: string) {
  if (!/^[a-z0-9]+-[A-Za-z0-9]+$/.test(pid)) return json({ error: "bad patient id" }, 400);
  const key = `calls:${pid}`;
  const list: unknown[] = JSON.parse((await env.CALLS.get(key)) || "[]");
  if (req.method === "GET") return new Response(JSON.stringify(list), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const c = (await req.json()) as Record<string, unknown>;
  const lines = (Array.isArray(c.lines) ? c.lines : []).slice(0, 400).filter(isRec).map((l) => ({ speaker: l.speaker === "coach" ? "coach" : "participant", text: String(l.text || "").slice(0, 1_000), tag: l.tag ? String(l.tag) : null, flag: l.flag ? String(l.flag) : null }));
  if (!lines.length) return json({ error: "a call needs at least one line" }, 400);
  const saved = { id: crypto.randomUUID(), pid, name: String(c.name || "").slice(0, 80), at: new Date().toISOString(), coach: String(c.coach || "").trim().slice(0, 60) || "Unknown coach", lines, score: typeof c.score === "number" ? c.score : null, note: String(c.note || "").slice(0, 2_000) };
  await env.CALLS.put(key, JSON.stringify([saved, ...list].slice(0, 20)));
  // One cross-patient index so Today and the Calls list see every saved call (and its flagged lines) in one read.
  const idx: unknown[] = JSON.parse((await env.CALLS.get("calls:index").catch(() => null)) || "[]");
  const entry = { id: saved.id, pid, name: saved.name, at: saved.at, coach: saved.coach, score: saved.score, lines: lines.length, flags: lines.filter((l) => l.flag && l.flag !== "none").map((l) => ({ flag: l.flag, text: l.text })) };
  await env.CALLS.put("calls:index", JSON.stringify([entry, ...idx].slice(0, 200))).catch(() => {});
  return json(saved, 201);
}
const noStore = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function allSavedCalls(env: Env) { return noStore(JSON.parse((await env.CALLS.get("calls:index").catch(() => null)) || "[]")); }

// Hand-offs to the care team: who, when, which patient, the flagged line and a note. Newest first, in KV.
async function handoffs(env: Env, req: Request) {
  const list: unknown[] = JSON.parse((await env.CALLS.get("handoffs").catch(() => null)) || "[]");
  if (req.method === "GET") return noStore(list);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const pid = String(b.patientId || "");
  if (!/^[a-z0-9]+-[A-Za-z0-9]+$/.test(pid)) return json({ error: "patientId is required" }, 400);
  const h = { id: crypto.randomUUID(), at: new Date().toISOString(), patientId: pid, name: String(b.name || "").slice(0, 80), coach: String(b.coach || "").trim().slice(0, 60) || "Unknown coach",
    to: String(b.to || "Care team").slice(0, 60), flag: String(b.flag || "").slice(0, 500), note: String(b.note || "").slice(0, 2_000) };
  await env.CALLS.put("handoffs", JSON.stringify([h, ...list].slice(0, 300)));
  return json(h, 201);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return env.ASSETS.fetch(req);
    const [, mod, ...rest] = parts;
    try {
      if (mod === "health") return json({ ok: true });
      if (mod === "insight" && req.method === "POST") return await insight(env, (await req.json()) as Record<string, unknown>);
      if (mod === "ellie" && req.method === "POST") return await ellie(env, (await req.json()) as Record<string, unknown>);
      if (mod === "recap" && req.method === "POST") return await recap(env, (await req.json()) as Record<string, unknown>);
      if (mod === "stt" && req.method === "POST") return await (await import("./stt")).stt(env, req);
      if (mod === "calls" && rest.length === 0 && req.method === "GET") return await allSavedCalls(env);
      if (mod === "calls" && rest.length === 1 && (req.method === "GET" || req.method === "POST")) return await savedCalls(env, req, rest[0]);
      if (mod === "handoffs" && rest.length === 0 && (req.method === "GET" || req.method === "POST")) return await handoffs(env, req);
      if ((mod === "c1" || mod === "c3" || mod === "c4") && req.method === "GET") {
        // Module data changes rarely: serve from this colo's edge cache for 60 s (first paint ~0.5 s faster).
        const key = new Request(url.toString(), { method: "GET" });
        const hit = await caches.default.match(key).catch(() => undefined);
        if (hit) return hit;
        const r = await ({ c1: env.C1, c3: env.C3, c4: env.C4 }[mod] as Fetcher).fetch(`https://${mod}${url.pathname}${url.search}`);
        const out = new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
        if (r.ok) ctx.waitUntil(caches.default.put(key, out.clone()).catch(() => {}));
        return out;
      }
      if (mod === "c5" && req.method === "POST" && C5_POST.has(rest[0]) && rest.length === 1) {
        // The Copilot rate-limits bursts (429): back off and retry twice so a replay or "Run live Copilot" doesn't drop tags.
        const body = await req.text();
        let r = await env.C5.fetch(`https://coach-copilot/api/${rest[0]}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        for (let k = 1; r.status === 429 && k <= 2; k++) {
          await new Promise((ok) => setTimeout(ok, 700 * k + Math.floor(Math.random() * 400)));
          r = await env.C5.fetch(`https://coach-copilot/api/${rest[0]}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        }
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
      }
      if (mod === "c5" && req.method === "GET") {
        // Prefer the Copilot's own suite endpoints; fall back to the adapter while they 404.
        const native = await env.C5.fetch(`https://coach-copilot${url.pathname}${url.search}`).catch(() => null);
        if (native && native.ok && (native.headers.get("content-type") || "").includes("json"))
          return new Response(native.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "x-c5-source": "native" } });
        return await c5(env, rest);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: `module unavailable: ${(e as Error).message}`, module: mod }, 502);
    }
  },
};
