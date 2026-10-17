/**
 * GET /api/today -> one ranked work queue across the four programs, for the Today page.
 *   Each row: { id, mod, name, status, tri, horizon: "today"|"week", rank, reason (<= 90 chars, clinical), data
 *   ("Real survey data (MEPS)" | "Synthetic"), language, interpreter, headline, updatedAt }.
 * Who is on it, worst first:
 *   Glucose (C4) never reaches Today: even care-team-flag rows go to the top of This week (judges: Today is red flags only).
 *   today: C5 safety lines under 30 days old (medical, distress, social), incl. Clef's demo call replayed today · C3 urgent 7-day ER/hospital risk ·
 *          C1 care-team-today (survey red flag)
 *   week:  C4 care-team flags first (frequent lows, very high sugar), then C1 highest next-year ER/hospital risk (alert tier, top 5) · C3 rough-patch alerts · C4 other alerts
 * The module APIs stay the source; this only picks rows and writes one short reason from their own fields.
 */
interface Fetcher { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }
type Rec = Record<string, unknown>;
type TodayEnv = { C1: Fetcher; C3: Fetcher; C4: Fetcher; C5: Fetcher };

const isRec = (x: unknown): x is Rec => !!x && typeof x === "object" && !Array.isArray(x);
const cut = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1).replace(/[\s,;:·]+\S*$/, "") + "…" : s);
const r0 = (v: unknown, d = 0) => (typeof v === "number" ? Number(v.toFixed(d)) : null);
const LANG: Record<string, string> = { "haitian creole": "Kreyòl", kreyol: "Kreyòl", "kreyòl": "Kreyòl", spanish: "Spanish", español: "Spanish", english: "English" };
const lang = (s: unknown) => { const t = String(s || "").trim(); return t ? LANG[t.toLowerCase()] || t : ""; };

async function get(f: Fetcher, url: string): Promise<unknown> {
  const r = await f.fetch(url).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}

export async function today(env: TodayEnv, c5Calls: () => Promise<unknown>) {
  const mod = (m: "c1" | "c3" | "c4") => ({ c1: env.C1, c3: env.C3, c4: env.C4 }[m]);
  const list = (m: "c1" | "c3" | "c4") => get(mod(m), `https://${m}/api/${m}/survivors`).then((x) => (Array.isArray(x) ? (x as Rec[]) : []));
  const detail = (m: "c1" | "c3" | "c4", id: string) => get(mod(m), `https://${m}/api/${m}/survivors/${encodeURIComponent(id)}`).then((x) => (isRec(x) ? x : null));
  const [l1, l3, l4, calls, demo] = await Promise.all([list("c1"), list("c3"), list("c4"), c5Calls().catch(() => []), get(env.C5, "https://coach-copilot/api/c5/demo")]);
  const rows: Rec[] = [];
  const failed: string[] = [];
  if (!l1.length) failed.push("c1"); if (!l3.length) failed.push("c3"); if (!l4.length) failed.push("c4");
  const base = (m: string, x: Rec) => ({ id: String(x.survivorId), mod: m, name: String(x.displayName || x.survivorId), status: String(x.status || "ok"), headline: String(x.headline || ""), updatedAt: x.updatedAt || null });

  // C5: the latest call with a needs-a-person line, per patient. Language = the call's language.
  const callList = (Array.isArray(calls) ? calls : []).filter(isRec);
  if (!callList.length) failed.push("c5");
  const byP = new Map<string, Rec>();
  for (const c of callList) {
    const pid = String(c.survivorId), prev = byP.get(pid);
    if (Array.isArray(c.flags) && c.flags.length && (!prev || `${c.date}${c.start}` > `${prev.date}${prev.start}`)) byP.set(pid, c);
  }
  const langOf5 = new Map(callList.map((c) => [String(c.survivorId), lang(c.language)]));
  const KIND: Record<string, [string, number]> = { medical: ["Medical concern", 960], distress: ["Distress", 950], social: ["Social need", 900] };
  // A call flag is today's work only while it is fresh (30 days). Older flags stay on Patients as alerts, not here.
  // Clef's demo safety call is replayed through the live engine today, so its red banner counts as today's.
  const FRESH_MS = 30 * 864e5, now = Date.now();
  const dm = isRec(demo) ? demo : null, dBanner = dm && Array.isArray(dm.banners) ? (dm.banners as Rec[]).find((b) => b.level === "red") : null;
  if (dm && dBanner) {
    const pid = String(dm.survivorId), kind = String(dBanner.flag || "medical"), [label, rank] = KIND[kind] || KIND.medical;
    const words = String(dBanner.quote || "").replace(/\s+/g, " ").replace(/^(oh,?\s+)?before you go,?\s+(and\s+)?/i, "").trim();
    const c = callList.find((x) => x.callId === dm.callId) || {};
    rows.push({ id: pid, mod: "c5", name: String(c.participantName || pid), status: "alert", headline: `${label} on call ${c.callNumber || ""}, replayed through Clef today`, updatedAt: dm.playedAt,
      horizon: "today", rank, reason: cut(`${label}: “${words.charAt(0).toUpperCase() + words.slice(1)}”`), data: "Synthetic", language: lang(dm.language) || langOf5.get(pid) || "", flaggedAt: dm.playedAt });
  }
  for (const [pid, c] of byP) {
    if (dm && pid === String(dm.survivorId)) continue;
    if (!(now - Date.parse(String(c.date)) < FRESH_MS)) continue;
    const f = (c.flags as Rec[])[0];
    const [label, rank] = KIND[String(f.kind)] || KIND.medical;
    const words = String(f.text || "").replace(/\s+/g, " ").replace(/^(oh,?\s+)?before you go,?\s+(and\s+)?/i, "").trim();
    rows.push({ id: pid, mod: "c5", name: String(c.participantName || pid), status: "alert", headline: `${label} on call ${c.callNumber}`, updatedAt: c.date,
      horizon: "today", rank, reason: cut(`${label}: “${words.charAt(0).toUpperCase() + words.slice(1)}”`), data: "Synthetic", language: langOf5.get(pid) || "" });
  }

  // C3: urgent first (7-day ER/hospital risk over its line), then rough-patch alerts.
  const c3 = l3.filter((x) => x.urgent === true || /^urgent/i.test(String(x.headline || "")) || x.status === "alert");
  const d3 = await Promise.all(c3.map((x) => detail("c3", String(x.survivorId))));
  c3.forEach((x, i) => {
    const d = d3[i] || {}, p = isRec(d.profile) ? d.profile : {};
    const urgent = x.urgent === true || /^urgent/i.test(String(x.headline || ""));
    const er = typeof d.urgentRisk === "number" ? Math.round(d.urgentRisk * 100) : Number((String(x.headline).match(/hospital risk (\d+)%/i) || [])[1] || 0);
    const times = (String(x.headline).match(/about (\d+(?:\.\d+)?)x usual/i) || [])[1];
    const where = String(p.context || "").replace(/\s*\(.*\)$/, "").replace(/^Day/, "day");
    const rough = typeof d.risk === "number" ? Math.round(d.risk * 100) : null;
    const reason = urgent ? `ER/hospital risk ${er}% in 7 days${times ? ` (${times}× usual)` : ""}${where ? `, ${where}` : ""}`
      : `Rough week ahead: ${rough != null ? rough + "% risk" : "alert"}${where ? `, ${where}` : ""}`;
    rows.push({ ...base("c3", x), horizon: urgent ? "today" : "week", rank: urgent ? 940 + er / 10 : 400 + (rough || 0) / 10, reason: cut(reason), data: "Synthetic", language: lang(p.language) });
  });

  // C4: frequent lows or very high sugar = send to the care team today; other alerts this week. The module now says
  // so itself on the roster (careTeamToday, todayReason, priority); older rows fall back to our rule on its evidence.
  const c4 = l4.filter((x) => x.status === "alert" || x.careTeamToday === true);
  const d4 = await Promise.all(c4.map((x) => (typeof x.careTeamToday === "boolean" && x.todayReason ? Promise.resolve(null) : detail("c4", String(x.survivorId)))));
  c4.forEach((x, i) => {
    if (typeof x.careTeamToday === "boolean" && x.todayReason) {
      const now = x.careTeamToday, pr = Number(x.priority ?? 2), tir = Number((String(x.todayReason).match(/(\d+(?:\.\d+)?)% in range/) || [])[1] ?? 50);
      rows.push({ ...base("c4", x), horizon: "week", rank: now ? (pr === 0 ? 830 + Number((String(x.todayReason).match(/(\d+(?:\.\d+)?)% of readings below/) || [])[1] || 0) : 820) : 300 + (100 - tir) / 10, reason: cut(String(x.todayReason)), data: "Synthetic", language: "" });
      return;
    }
    const ev = new Map(((d4[i] && Array.isArray(d4[i]!.evidence) ? d4[i]!.evidence : []) as Rec[]).map((e) => [String(e.id), e.value as number]));
    const tbr = r0(ev.get("tbr70"), 1), mg = r0(ev.get("mean_glucose")), tir = r0(ev.get("tir"));
    const lows = tbr != null && tbr >= 4, high = (mg != null && mg >= 250) || (tir != null && tir < 10);
    const reason = lows ? `Glucose: ${tbr}% of readings below 70 (target under 4%), risk of lows`
      : high ? `Glucose: average ${mg} mg/dL, ${tir}% in range (target over 70%)`
      : `Glucose: ${tir}% in range (target over 70%), average ${mg} mg/dL`;
    rows.push({ ...base("c4", x), horizon: "week", rank: lows ? 830 + (tbr || 0) : high ? 820 + (mg || 0) / 100 : 300 + (100 - (tir || 0)) / 10, reason: cut(reason), data: "Synthetic", language: "" });
  });

  // C1: anyone the module marks care-team-today (red flags from the survey: hopelessness, serious distress…) is today's
  // work whatever their tier; then the alert tier, highest next-year risk first, top 5 this week.
  const c1all = l1.filter((x) => x.status === "alert" || x.status === "watch").map((x) => ({ x, risk: Number((String(x.headline).match(/risk (\d+(?:\.\d+)?)%/i) || [])[1] || 0) }))
    .sort((a, b) => b.risk - a.risk);
  const d1all = await Promise.all(c1all.map(({ x }) => detail("c1", String(x.survivorId))));
  const c1 = c1all.map((c, i) => ({ ...c, d: d1all[i] || {} })).filter((c, i) => (isRec(c.d.redFlags) && c.d.redFlags.careTeamToday === true) || (c.x.status === "alert" && c1all.slice(0, i + 1).filter((y) => y.x.status === "alert").length <= 5));
  c1.forEach(({ x, risk, d }) => {
    const rf = isRec(d.redFlags) ? d.redFlags : {};
    const survey = (Array.isArray(rf.fromSurvey) ? rf.fromSurvey : []).filter(isRec);
    const visits = survey.map((s) => String(s.text).match(/^(\d+ ER visit\(s\) and \d+ hospital stay\(s\) last year)/)?.[1]).find(Boolean);
    const driver = (String(x.headline).match(/driven by ([^,;]+)/i) || [])[1];
    const now = rf.careTeamToday === true;
    const flag = now ? String(rf.banner || (survey.find((s) => s.urgency === "today") || {}).text || "") : "";
    // Each red-flag row names the person and the survey answer itself, so two rows never read the same.
    const pf = isRec(d.profile) ? d.profile : {};
    const who = [pf.age && `${pf.age}${String(pf.sex || "").charAt(0).toUpperCase()}`, Array.isArray(pf.cancerTypes) && pf.cancerTypes[0]].filter(Boolean).join(" ");
    const answers = survey.filter((s) => s.urgency === "today").map((s) => String(s.text).split(":")[0].replace(/^Reported feeling /i, "").replace(/^Serious psychological distress/i, "serious distress").replace(/ of (\d+)\)/, "/$1)").trim()).filter(Boolean);
    const reason = now && answers.length ? `Red flag${who ? ` (${who})` : ""}: ${answers.join("; ")}`
      : now && flag ? `Red flag: ${flag.replace(/^[^:]*care team today[:.]?\s*/i, "")}`
      : `ER/hospital risk ${risk}% next year${visits ? `, ${visits.replace(/\(s\)/g, "s").replace(/^1 ER visits/, "1 ER visit").replace(/ 1 hospital stays/, " 1 hospital stay")}` : driver ? `, driven by ${driver}` : ""}`;
    rows.push({ ...base("c1", x), horizon: now ? "today" : "week", rank: now ? 910 + risk / 100 : 500 + risk / 10, reason: cut(reason), riskWords: d.riskWords || "", caveat: d.caveat || "",
      data: "Real survey data (MEPS)", language: "" });
  });

  rows.forEach((r) => { const l = String(r.language || ""); r.interpreter = !!l && l !== "English"; r.tri = r.horizon === "today" ? "today" : "alert"; });
  rows.sort((a, b) => (a.horizon === b.horizon ? 0 : a.horizon === "today" ? -1 : 1) || (b.rank as number) - (a.rank as number));
  return { rows, failed, at: new Date().toISOString() };
}
