/**
 * Patient 360: one origin for the care team's app and the module APIs.
 *   GET  /api/c1/*            -> c1-acute-risk (Care Team Risk), service binding
 *   GET  /api/c3/*            -> c3-rough-patch (Bad Week Radar), service binding
 *   GET  /api/c4/*            -> c4-glucose-guide (Dose and Timing), service binding
 *   GET  /api/c5/survivors[/:id], /api/c5/calls[/:id]
 *                             -> coach-copilot's own /api/c5/* when it answers; until then an adapter over its labelled call set
 *   POST /api/c5/turn|review|cue -> coach-copilot-clef /api/turn|review|cue (the live model)
 *   GET|POST /api/calls/:patientId -> calls started in this app, saved in KV (newest first)
 *   POST /api/recap           -> GLM summary of the last call, for picking the conversation back up
 *   POST /api/ellie           -> Ellie, the clinician assistant (GLM, JSON answer + optional page to open)
 * Everything else is the static app in ./public.
 */
import PEOPLE from "./c5-people.json";

interface Fetcher { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }
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
async function glm(env: Env, system: string, user: string, schema: Record<string, unknown>, maxTokens = 1_200) {
  const call = () => env.AI.run(GLM, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_completion_tokens: maxTokens, reasoning_effort: "low",
    response_format: { type: "json_schema", json_schema: schema },
  });
  const raw = await call().catch(() => call());
  if (!isRec(raw)) return null;
  const choice = Array.isArray(raw.choices) && isRec(raw.choices[0]) ? raw.choices[0] : null;
  const text = choice && isRec(choice.message) ? choice.message.content : raw.response;
  if (isRec(text)) return text;
  if (typeof text !== "string") return null;
  try { const p: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); return isRec(p) ? p : null; } catch { return null; }
}
const clip = (x: unknown, n: number) => JSON.stringify(x ?? null).slice(0, n);

// Routes Ellie may open. Anything else she suggests is dropped.
const ROUTE_OK = /^(today|patients(-(today|alert|watch|ok))?|calls|care|research|app(-[a-z0-9-]+)?|call-[A-Za-z0-9]+|live-[a-z0-9]+-[A-Za-z0-9]+|p-[a-z0-9]+-[A-Za-z0-9]+(\.(c1|c3|c4|c5))?)$/;

async function ellie(env: Env, body: Record<string, unknown>) {
  const question = String(body.question || "").slice(0, 1_000).trim();
  if (!question) return json({ error: "question is required" }, 400);
  const history = (Array.isArray(body.history) ? body.history : []).slice(-6).map((m) => (isRec(m) ? `${m.role === "user" ? "Clinician" : "Ellie"}: ${String(m.text || "").slice(0, 400)}` : "")).join("\n");
  const system = `You are Ellie, the assistant inside Patient 360, a care-team console for cancer survivors (synthetic hackathon data).
You help a clinician (1) move around the app, (2) find and explain a patient's information, (3) answer general medical questions.
Rules:
- Patient facts come ONLY from the PATIENTS and PAGE context below. Never invent a number, date, diagnosis or name. If the context lacks it, say so and suggest the page that has it.
- Cite the patient ids you used in "cites".
- For medical questions give concise, mainstream clinical information (guideline level), say when it depends on the person, and never diagnose or prescribe for a specific patient. Flag emergencies plainly.
- To open a page, set "navigate" to one route token, else "". Routes: today | patients | patients-today | patients-alert | patients-watch | calls | care (hospital risk list) | research | app-<id> (patient's phone view) | p-<id> (patient health chart) | p-<id>.c1 (hospital risk) | p-<id>.c3 (rough weeks) | p-<id>.c4 (glucose) | p-<id>.c5 (coaching calls) | live-<id> (start a call) | call-<callId>. Only use ids present in the context.
- Plain words, short. Two to five sentences unless asked for more. No markdown tables.`;
  const user = `PAGE: ${clip(body.page, 300)}
PATIENT ON SCREEN: ${clip(body.patient, 6_000)}
PATIENTS MATCHING THE QUESTION: ${clip(body.matches, 5_000)}
COUNTS: ${clip(body.counts, 400)}
${history ? "CONVERSATION SO FAR:\n" + history + "\n" : ""}QUESTION: ${question}`;
  const schema = { name: "ellie", strict: true, schema: { type: "object", additionalProperties: false, required: ["answer", "navigate", "cites", "kind"], properties: {
    answer: { type: "string" }, navigate: { type: "string" }, cites: { type: "array", items: { type: "string" } },
    kind: { type: "string", enum: ["navigation", "patient", "medical", "other"] } } } };
  const r = await glm(env, system, user, schema);
  if (!r || typeof r.answer !== "string") return json({ error: "Ellie could not answer just now. Try again." }, 502);
  const known = new Set<string>([...(Array.isArray(body.matches) ? body.matches : []), body.patient].filter(isRec).map((p) => String(p.id)));
  const nav = typeof r.navigate === "string" ? r.navigate.replace(/^#/, "").trim() : "";
  const navId = (nav.match(/^(?:p|live|app)-([a-z0-9]+-[A-Za-z0-9]+)/) || [])[1];
  return json({
    answer: r.answer, kind: r.kind,
    navigate: nav && ROUTE_OK.test(nav) && (!navId || known.has(navId)) ? nav : "",
    cites: (Array.isArray(r.cites) ? r.cites : []).map(String).filter((c) => known.has(c)),
    model: GLM,
  });
}

async function recap(env: Env, body: Record<string, unknown>) {
  const system = `You write a hand-off note so a health coach can pick up a coaching conversation with a cancer survivor. Use ONLY the transcript and facts given. No diagnosis. Plain words.`;
  const user = `PATIENT: ${clip(body.patient, 1_500)}\nLAST CALL: ${clip(body.last, 9_000)}`;
  const schema = { name: "recap", strict: true, schema: { type: "object", additionalProperties: false, required: ["summary", "pickUp", "openConcerns"], properties: {
    summary: { type: "string" }, pickUp: { type: "array", items: { type: "string" } }, openConcerns: { type: "array", items: { type: "string" } } } } };
  const r = await glm(env, system, user, schema, 900);
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
  const saved = { id: crypto.randomUUID(), at: new Date().toISOString(), coach: String(c.coach || "Coach").slice(0, 60), lines, score: typeof c.score === "number" ? c.score : null, note: String(c.note || "").slice(0, 2_000) };
  await env.CALLS.put(key, JSON.stringify([saved, ...list].slice(0, 20)));
  return json(saved, 201);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return env.ASSETS.fetch(req);
    const [, mod, ...rest] = parts;
    try {
      if (mod === "health") return json({ ok: true });
      if (mod === "ellie" && req.method === "POST") return await ellie(env, (await req.json()) as Record<string, unknown>);
      if (mod === "recap" && req.method === "POST") return await recap(env, (await req.json()) as Record<string, unknown>);
      if (mod === "calls" && rest.length === 1 && (req.method === "GET" || req.method === "POST")) return await savedCalls(env, req, rest[0]);
      if ((mod === "c1" || mod === "c3" || mod === "c4") && req.method === "GET") {
        const r = await ({ c1: env.C1, c3: env.C3, c4: env.C4 }[mod] as Fetcher).fetch(`https://${mod}${url.pathname}${url.search}`);
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
      }
      if (mod === "c5" && req.method === "POST" && C5_POST.has(rest[0]) && rest.length === 1) {
        const r = await env.C5.fetch(`https://coach-copilot/api/${rest[0]}`, { method: "POST", headers: { "content-type": "application/json" }, body: await req.text() });
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
