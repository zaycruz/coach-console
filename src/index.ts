/**
 * Patient 360: one origin for the care team's app and the module APIs.
 *   GET  /api/c1/*            -> c1-acute-risk (Care Team Risk), service binding
 *   GET  /api/c3/*            -> c3-rough-patch (Bad Week Radar), service binding
 *   GET  /api/c4/*            -> c4-glucose-guide (Dose and Timing), service binding
 *   GET  /api/c5/survivors[/:id], /api/c5/calls[/:id]
 *                             -> coach-copilot's own /api/c5/* when it answers; until then an adapter over its labelled call set
 *   POST /api/c5/turn|review|cue -> coach-copilot-clef /api/turn|review|cue (the live model)
 * Everything else is the static app in ./public.
 */
import PEOPLE from "./c5-people.json";

interface Fetcher { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }
interface Env { ASSETS: Fetcher; C1: Fetcher; C3: Fetcher; C4: Fetcher; C5: Fetcher }

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return env.ASSETS.fetch(req);
    const [, mod, ...rest] = parts;
    try {
      if (mod === "health") return json({ ok: true });
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
