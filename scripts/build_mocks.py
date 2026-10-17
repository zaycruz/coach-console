"""Build contract-shaped mock data for the Coach Console prototype.

Reads the hackathon synthetic datasets in ~/Downloads and writes:
  prototype/mock-data.js        window.MOCK = {...}  (loaded by <script>, works on file://)
  mock/api/<module>/survivors.json and mock/api/<module>/survivors/<id>.json  (contract docs)

Run: python3 -I scripts/build_mocks.py
Fixed choices, no randomness: the same input files give the same output.
"""
import csv
import json
import os
import statistics as st
import sys
from datetime import date, datetime, timedelta

HOME = os.path.expanduser("~")
DL = os.path.join(HOME, "Downloads")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AS_OF = "2026-10-17T07:30:00"  # demo "this morning"


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(st.mean(xs), 1) if xs else None


# ---------------------------------------------------------------- C3 Bad Week Radar
def c3_window(days, i):
    """Signals for the 3 days ending at index i vs the 28 days before them."""
    recent = days[max(0, i - 2): i + 1]
    base = days[max(0, i - 30): max(0, i - 2)]
    def r(key):
        b, n = mean(d[key] for d in base), mean(d[key] for d in recent)
        return b, n
    out = {}
    for k in ("steps", "sleep_minutes", "resting_heart_rate", "hrv_rmssd_ms", "daily_feeling_1_to_5"):
        out[k] = r(k)
    worn = mean(d["minutes_watch_worn"] for d in recent)
    out["worn"] = worn
    return out


def c3_score(sig):
    """Simple, explainable rule: count signals past threshold vs the person's own baseline."""
    hits = []
    (bs, ns) = sig["steps"]
    if bs and ns is not None and ns < 0.65 * bs:
        hits.append(("steps", f"Steps {round(100 * (ns - bs) / bs)}% vs usual ({int(ns):,} vs {int(bs):,}/day)"))
    (bz, nz) = sig["sleep_minutes"]
    if bz and nz is not None and abs(nz - bz) > 60:
        hits.append(("sleep", f"Sleep {'+' if nz > bz else '−'}{int(abs(nz - bz))} min/night vs usual"))
    (bh, nh) = sig["resting_heart_rate"]
    if bh and nh is not None and nh - bh >= 5:
        hits.append(("rhr", f"Resting heart rate +{round(nh - bh, 1)} bpm vs usual"))
    (bf, nf) = sig["daily_feeling_1_to_5"]
    if bf and nf is not None and nf <= bf - 1:
        hits.append(("feeling", f"Daily check-in {nf}/5 (usual {bf}/5)"))
    if sig["worn"] is not None and sig["worn"] < 900:
        hits.append(("worn", f"Watch worn only {int(sig['worn'] / 60)} h/day"))
    status = "alert" if len(hits) >= 3 else "watch" if len(hits) >= 1 else "ok"
    return status, hits


def build_c3():
    data = json.load(open(os.path.join(DL, "Challenge3_Bad_Week_Radar/synthetic_data/synthetic_250_patients.json")))
    picks = {"alert": [], "watch": [], "ok": []}
    for p in data["patients"]:
        days = p["days"]
        if len(days) < 60:
            continue
        # Candidate "this morning": 2 days before the first ER visit after day 45, else day 60.
        idx = None
        for i, d in enumerate(days):
            if i > 45 and d["events"] and "ER visit" in d["events"]:
                idx = i - 2
                break
        if idx is None:
            idx = 59
        sig = c3_window(days, idx)
        status, hits = c3_score(sig)
        if len(picks[status]) < 3:
            picks[status].append((p, idx, sig, status, hits))
        if all(len(v) >= 3 for v in picks.values()):
            break
    lst, det = [], {}
    for status in ("alert", "watch", "ok"):
        for p, idx, sig, s, hits in picks[status][:2 if status == "ok" else 3]:
            sid = p["patient_id"]
            days = p["days"]
            window = days[max(0, idx - 27): idx + 1]
            after = days[idx + 1: idx + 6]
            nxt = [d["events"] for d in after if d["events"]]
            name = f"{sid} · {p['sex'][0].upper()}, {p['age']}"
            headline = hits[0][1] if hits else "Within usual range on every signal"
            if s == "alert":
                headline = f"Rough patch likely: {len(hits)} signals off her/his usual" if False else f"Rough patch likely · {len(hits)} signals off usual"
            notes = [{"date": d["date"], "text": d["diary_note"]} for d in window if d["diary_note"]][-3:]
            ev = [{"kind": k, "text": t} for k, t in hits]
            ev += [{"kind": "diary", "text": f"Diary {n['date']}: “{n['text']}”"} for n in notes]
            ctx = days[idx]
            recs = []
            if s == "alert":
                recs = [
                    {"audience": "coach", "text": "Call before the scheduled check-in. Ask how the last 3 days felt; don’t lead with the numbers."},
                    {"audience": "coach", "text": "If fever, shortness of breath or no food intake comes up, route to the care team today."},
                    {"audience": "survivor", "text": "Rest is OK this week. Short walks around the house count."},
                ]
            elif s == "watch":
                recs = [
                    {"audience": "coach", "text": "Send a check-in text today; review again tomorrow morning."},
                    {"audience": "survivor", "text": "Your sleep looks different this week. Want to talk about it on your next call?"},
                ]
            else:
                recs = [{"audience": "coach", "text": "No action. Keep the regular call schedule."}]
            lst.append({"survivorId": sid, "displayName": name, "status": s, "headline": headline, "updatedAt": AS_OF})
            det[sid] = {
                "survivorId": sid, "status": s, "headline": headline,
                "summary": f"{p['cancer_type'].title()} cancer, stage {p['stage']}, {p['treatment_plan'].lower()}. "
                           f"Treatment phase: {ctx['treatment_phase']}"
                           + (f", cycle {int(ctx['treatment_cycle'])} day {int(ctx['day_of_cycle'])}" if ctx["treatment_cycle"] else "") + ". "
                           f"Last 3 days compared with this person’s own previous 28 days.",
                "profile": {"age": p["age"], "sex": p["sex"], "language": p["preferred_language"], "cancer": p["cancer_type"],
                            "stage": p["stage"], "treatment": p["treatment_plan"], "livesAlone": p["lives_alone"],
                            "milesToClinic": p["miles_to_clinic"], "device": p["device"]},
                "evidence": ev,
                "recommendations": recs,
                "charts": {
                    "baseline": {k: sig[k][0] for k in ("steps", "sleep_minutes", "resting_heart_rate", "daily_feeling_1_to_5")},
                    "days": [{"date": d["date"], "steps": d["steps"], "sleep": d["sleep_minutes"], "rhr": d["resting_heart_rate"],
                              "feeling": d["daily_feeling_1_to_5"], "treatment": d["treatment_today"], "event": d["events"]} for d in window],
                },
                "hindsight": nxt,  # what happened next in the synthetic data (demo only; never shown as a prediction input)
            }
    return lst, det


# ---------------------------------------------------------------- C4 Dose and Timing
def hm(t):
    h, m = t.split(":")
    return int(h) + int(m) / 60


def build_c4():
    data = json.load(open(os.path.join(DL, "Challenge4_Dose_and_Timing/synthetic_data/synthetic_100_people.json")))
    rows = []
    for p in data["people"]:
        g = p.get("glucose_every_15_min") or []
        if not g:
            continue
        # Columnar: {"timestamp": [...], "glucose_mg_dl": [...], "steps_15min": [...]}
        steps = g.get("steps_15min") or [None] * len(g["timestamp"])
        gl = [(datetime.fromisoformat(t), v, s) for t, v, s in zip(g["timestamp"], g["glucose_mg_dl"], steps) if v]
        if not gl:
            continue
        def rise(meal):
            t0 = datetime.fromisoformat(f"{meal['date']}T{meal['time']}")
            pre = [v for t, v, _ in gl if t0 - timedelta(minutes=30) <= t <= t0]
            post = [v for t, v, _ in gl if t0 < t <= t0 + timedelta(hours=2)]
            if not pre or len(post) < 4:
                return None
            return max(post) - pre[-1]
        dinners = []
        for m in p["meals"]:
            if m["meal_type"] not in ("dinner", "late snack"):
                continue
            r = rise(m)
            if r is None:
                continue
            dinners.append({"time": m["time"], "rise": r, "walk": m.get("walked_after_min") or 0, "food": m["food"], "carbs": m["carbs_g"], "date": m["date"]})
        late = [d["rise"] for d in dinners if hm(d["time"]) >= 20 or hm(d["time"]) < 4]
        early = [d["rise"] for d in dinners if 16 <= hm(d["time"]) < 19.5]
        walk = [d["rise"] for d in dinners if d["walk"] >= 10]
        nowalk = [d["rise"] for d in dinners if d["walk"] < 10]
        tir_hi = round(100 * sum(1 for _, v, _ in gl if v > 140) / len(gl))
        rows.append((p, gl, dinners, mean(late), mean(early), mean(walk), mean(nowalk), tir_hi, len(late), len(early)))
    # Prefer people with both late and early dinners so the comparison is visible.
    rows = [r for r in rows if r[8] >= 3 and r[9] >= 3 and r[3] is not None and r[4] is not None]
    rows.sort(key=lambda r: -(r[3] - r[4]))
    chosen = rows[:3] + rows[len(rows) // 2: len(rows) // 2 + 2] + rows[-2:]
    lst, det = [], {}
    for p, gl, dinners, late, early, walk, nowalk, hi, nl, ne in chosen:
        sid = p["participant_id"]
        gap = round(late - early)
        status = "alert" if hi >= 25 or gap >= 35 else "watch" if hi >= 10 or gap >= 15 else "ok"
        headline = (f"Dinners after 8 pm rise {gap} mg/dL more than earlier dinners" if gap >= 10
                    else f"{hi}% of readings above 140 mg/dL" if hi >= 10 else "Blood sugar back to range within 2 h after most meals")
        # One illustrative day: the day with the latest dinner that has full glucose coverage.
        best = max(dinners, key=lambda d: (hm(d["time"]) if hm(d["time"]) >= 4 else hm(d["time"]) + 24))
        day0 = datetime.fromisoformat(best["date"] + "T04:00")
        curve = [{"t": t.strftime("%H:%M"), "g": v} for t, v, _ in gl if day0 <= t < day0 + timedelta(hours=24)]
        meals = [{"t": m["time"], "type": m["meal_type"], "food": m["food"], "carbs": m["carbs_g"], "walk": m.get("walked_after_min") or 0}
                 for m in p["meals"] if m["eating_day"] == best["date"]]
        dd = [d for d in p["days"] if d["food_logged"] == "yes"]
        fast = mean(d["overnight_fast_hours"] for d in dd)
        lastate = [d["last_ate"] for d in dd if d["last_ate"]]
        ev = [
            {"kind": "late-vs-early", "text": f"Average 2-hour rise: {round(late)} mg/dL after {nl} late dinners vs {round(early)} after {ne} earlier dinners"},
        ]
        if walk is not None and nowalk is not None:
            ev.append({"kind": "walk", "text": f"Walk of 10+ min after dinner: rise {round(walk)} vs {round(nowalk)} mg/dL without"})
        ev.append({"kind": "fast", "text": f"Average overnight fast {fast} h (program goal 13 h)"})
        ev.append({"kind": "range", "text": f"{hi}% of sensor readings above 140 mg/dL in weeks 1–2"})
        recs = [
            {"audience": "survivor", "text": "Try to finish dinner by 7:30 pm on 4 nights this week.", "es": "Intente terminar la cena antes de las 7:30 pm 4 noches esta semana."},
            {"audience": "survivor", "text": "On nights you eat late, walk 10 minutes right after.", "es": "Las noches que cene tarde, camine 10 minutos justo después."},
            {"audience": "coach", "text": "Open the next call with the late-dinner pattern; ask what makes early dinners hard (work shift, family)."},
        ]
        if p["work_schedule"] == "night shift":
            recs.insert(0, {"audience": "coach", "text": "Night-shift worker: a long ‘overnight’ fast means something different here. Use time since last meal, not clock time."})
        lst.append({"survivorId": sid, "displayName": f"{sid} · {p['sex'][0].upper()}, {p['age']}", "status": status, "headline": headline, "updatedAt": AS_OF})
        det[sid] = {
            "survivorId": sid, "status": status, "headline": headline,
            "summary": f"{p['cancer_type'].title()} cancer survivor, {p['years_since_treatment']} years after treatment. "
                       f"Group: {p['group']}. Start blood sugar: {p['blood_sugar_group']}. {p['food_background']} food background, {p['work_schedule']}.",
            "profile": {"age": p["age"], "sex": p["sex"], "language": p["preferred_language"], "cancer": p["cancer_type"],
                        "group": p["group"], "bloodSugarGroup": p["blood_sugar_group"], "work": p["work_schedule"], "food": p["food_background"]},
            "evidence": ev,
            "recommendations": recs,
            "caveat": "Pattern in this person’s own data, not proof of cause. Late and early dinners also differ in what was eaten.",
            "charts": {
                "day": {"date": best["date"], "curve": curve, "meals": meals},
                "compare": [
                    {"label": "Dinner before 7:30 pm", "value": round(early), "n": ne},
                    {"label": "Dinner after 8 pm", "value": round(late), "n": nl},
                ] + ([{"label": "Walked 10+ min after", "value": round(walk), "n": sum(1 for d in dinners if d["walk"] >= 10)}] if walk is not None else []),
                "lastAteHistogram": [sum(1 for t in lastate if int(t[:2]) == h) for h in range(16, 24)],
            },
        }
    return lst, det


# ---------------------------------------------------------------- C5 Coach's Copilot
MI_CONSISTENT = {"open question", "simple reflection", "complex reflection", "affirm", "seek collaboration",
                 "emphasize autonomy", "ask permission"}


def score_call(lines):
    """Arithmetic score over tags, same targets as coach-copilot: R:Q 2 (30), %CR 40 (20), %OQ 50 (20), MI-consistent (30)."""
    mv = [l["coach_move"] for l in lines if l["speaker"] == "coach" and l["coach_move"]]
    q = sum(m.endswith("question") for m in mv)
    oq = sum(m == "open question" for m in mv)
    r = sum(m.endswith("reflection") for m in mv)
    cr = sum(m == "complex reflection" for m in mv)
    cons = sum(m in MI_CONSISTENT for m in mv)
    inc = sum(m in ("persuade", "confront") for m in mv)
    rq = r / q if q else 0
    parts = {
        "reflectionsPerQuestion": {"value": round(rq, 2), "target": 2, "points": round(30 * min(1, rq / 2)), "max": 30},
        "complexReflectionPct": {"value": round(100 * cr / r) if r else 0, "target": 40, "points": round(20 * min(1, (cr / r if r else 0) / 0.4)), "max": 20},
        "openQuestionPct": {"value": round(100 * oq / q) if q else 0, "target": 50, "points": round(20 * min(1, (oq / q if q else 0) / 0.5)), "max": 20},
        "miConsistent": {"value": f"{cons} vs {inc}", "target": "0 persuade/confront", "points": round(30 * (cons / (cons + inc) if cons + inc else 1)), "max": 30},
    }
    return sum(p["points"] for p in parts.values()), parts


FLAG_WORDS = {
    "medical": ["chest", "fever", "fiebre", "fell", "fall", "caí", "swollen", "hinchad", "dolor en el pecho", "breath"],
    "distress": ["hopeless", "no point", "sin esperanza", "no vale la pena", "give up"],
    "social": ["food", "comida", "money", "dinero", "rent", "ride", "transport"],
}


def flag_kind(text):
    t = text.lower()
    for k, ws in FLAG_WORDS.items():
        if any(w in t for w in ws):
            return k
    return "medical"


def build_c5():
    base = os.path.join(DL, "Challenge5_Coaches_Copilot/synthetic_data")
    calls = json.load(open(os.path.join(base, "synthetic_300_calls.json")))["calls"]
    people = {r["participant_id"]: r for r in csv.DictReader(open(os.path.join(base, "synthetic_participants.csv")))}
    coaches = {r["coach_id"]: r for r in csv.DictReader(open(os.path.join(base, "synthetic_coaches.csv")))}
    lab = [c for c in calls if c["labelled"] == "yes"]
    flagged = [c for c in lab if any(l["needs_human"] == "yes" for l in c["lines"])]
    scored = sorted(((score_call(c["lines"])[0], c) for c in lab if c not in flagged), key=lambda x: x[0])
    chosen = flagged + [c for _, c in scored[:2]] + [c for _, c in scored[len(scored) // 2: len(scored) // 2 + 1]] + [c for _, c in scored[-2:]]
    lst, det, call_out = [], {}, {}
    for c in chosen:
        pid = c["participant_id"]
        pp, co = people[pid], coaches[c["coach_id"]]
        score, parts = score_call(c["lines"])
        flags = []
        tagged = []
        prev_coach = None
        for l in c["lines"]:
            row = {"n": l["line_number"], "t": l["time_in_call"], "speaker": l["speaker"], "text": l["text"]}
            if l["speaker"] == "coach":
                row["move"] = l["coach_move"]
                # Illustrative confidence: lower on the two labels Clef confuses most (per coach-copilot README).
                row["confidence"] = 0.24 if l["coach_move"] in ("complex reflection", "affirm") and l["line_number"] % 3 == 0 else 0.86
                row["reviewed"] = row["confidence"] < 0.3
            else:
                row["talk"] = l["participant_talk"]
                if l["needs_human"] == "yes":
                    row["flag"] = flag_kind(l["text"])
                    flags.append({"line": l["line_number"], "kind": row["flag"], "text": l["text"], "t": l["time_in_call"]})
                else:
                    row["flag"] = "none"
            tagged.append(row)
        # Cues from the same rule triggers coach-copilot uses (subset).
        cues = []
        closed_run = 0
        for i, row in enumerate(tagged):
            if row["speaker"] != "coach":
                if row.get("talk") == "change" and i + 1 < len(tagged) and tagged[i + 1].get("move") in ("closed question", "give information", "persuade"):
                    cues.append({"line": tagged[i + 1]["n"], "kind": "missed change talk", "text": "They just said why they want to change. Reflect it back before moving on."})
                continue
            if row["move"] in ("persuade", "confront"):
                cues.append({"line": row["n"], "kind": row["move"], "text": "Ask permission before advice, or offer options and let them choose."})
            closed_run = closed_run + 1 if row["move"] == "closed question" else 0
            if closed_run == 3:
                cues.append({"line": row["n"], "kind": "3 closed questions", "text": "Try an open question: “What would make this week easier?”"})
        status = "alert" if flags else "watch" if score < 60 else "ok"
        headline = (f"{flags[0]['kind'].title()} flag at {flags[0]['t']}: act today" if flags
                    else f"Coach score {score}/100 · {len(cues)} coaching cues" if status == "watch" else f"Coach score {score}/100 · on target")
        mc = {}
        for row in tagged:
            if row.get("move"):
                mc[row["move"]] = mc.get(row["move"], 0) + 1
        talk = {}
        for row in tagged:
            if row.get("talk"):
                talk[row["talk"]] = talk.get(row["talk"], 0) + 1
        call_out[c["call_id"]] = {
            "callId": c["call_id"], "survivorId": pid, "coach": {"id": co["coach_id"], "name": co["first_name"], "role": co["role"]},
            "date": c["date"], "start": c["start_time"], "language": c["language"], "goalTopic": c["goal_topic"],
            "callNumber": c["call_number"], "week": c["program_week"], "durationMin": c["duration_min"],
            "score": score, "scoreParts": parts, "flags": flags, "cues": cues, "moveCounts": mc, "talkCounts": talk, "lines": tagged,
        }
        lst.append({"survivorId": pid, "displayName": f"{pp['first_name']} · {pid}", "status": status, "headline": headline, "updatedAt": AS_OF})
        det[pid] = {
            "survivorId": pid, "status": status, "headline": headline,
            "summary": f"{pp['age']}-year-old {pp['sex']}, {pp['cancer_type']} cancer. Program focus: {pp['program_focus']}. "
                       f"Calls in {pp['call_language']}. Coach {co['first_name']} ({co['role']}).",
            "profile": {"firstName": pp["first_name"], "age": int(pp["age"]), "sex": pp["sex"], "language": pp["call_language"],
                        "cancer": pp["cancer_type"], "focus": pp["program_focus"], "coach": co["first_name"]},
            "evidence": ([{"kind": "flag-" + f["kind"], "text": f"{f['t']} “{f['text']}”"} for f in flags]
                         + [{"kind": "score", "text": f"Coach score {score}/100 on call {c['call_number']} (week {c['program_week']})"}]
                         + [{"kind": "cue", "text": f"Line {q['line']}: {q['kind']}"} for q in cues[:3]]),
            "recommendations": ([{"audience": "coach", "text": {
                "medical": "Call the care team today and document the hand-off.",
                "social": "Connect with the social worker today about food support.",
                "distress": "Same-day check-in with the psycho-oncology team."}[f["kind"]]} for f in flags]
                + [{"audience": "coach", "text": "Review the cue moments with the coach in supervision."} if cues else
                   {"audience": "coach", "text": "No action needed."}]),
            "charts": {"latestCallId": c["call_id"], "score": score, "scoreParts": parts},
        }
    return lst, det, call_out


def main():
    c3l, c3d = build_c3()
    c4l, c4d = build_c4()
    c5l, c5d, calls = build_c5()
    mock = {
        "about": "MADE-UP DATA from the eMerge hackathon synthetic datasets (Crane Lab, Sylvester). No real people.",
        "asOf": AS_OF,
        "modules": {
            "c3": {"name": "Bad Week Radar", "list": c3l, "detail": c3d},
            "c4": {"name": "Dose and Timing", "list": c4l, "detail": c4d},
            "c5": {"name": "Coach's Copilot", "list": c5l, "detail": c5d},
        },
        "calls": calls,
    }
    # Composite demo survivor: one person per module, shown side by side and labelled as illustrative.
    a3 = next(x for x in c3l if x["status"] == "alert")["survivorId"]
    a4 = next(x for x in c4l if x["status"] != "ok")["survivorId"]
    a5 = next(x for x in c5l if x["status"] == "alert")["survivorId"]
    mock["composite"] = {"survivorId": "demo", "displayName": "Composite demo survivor",
                         "parts": {"c3": a3, "c4": a4, "c5": a5},
                         "note": "Illustrative only. The three challenge datasets are different made-up people; this page shows one record from each side by side to preview the product vision."}
    os.makedirs(os.path.join(ROOT, "prototype"), exist_ok=True)
    with open(os.path.join(ROOT, "prototype/mock-data.js"), "w") as f:
        f.write("// Generated by scripts/build_mocks.py. Do not edit by hand.\nwindow.MOCK = ")
        json.dump(mock, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    for m in ("c3", "c4", "c5"):
        d = os.path.join(ROOT, "mock/api", m, "survivors")
        os.makedirs(d, exist_ok=True)
        json.dump(mock["modules"][m]["list"], open(os.path.join(ROOT, "mock/api", m, "survivors.json"), "w"), ensure_ascii=False, indent=1)
        for sid, v in mock["modules"][m]["detail"].items():
            json.dump(v, open(os.path.join(d, sid + ".json"), "w"), ensure_ascii=False, indent=1)
    cd = os.path.join(ROOT, "mock/api/c5/calls")
    os.makedirs(cd, exist_ok=True)
    for cid, v in calls.items():
        json.dump(v, open(os.path.join(cd, cid + ".json"), "w"), ensure_ascii=False, indent=1)
    for m in ("c3", "c4", "c5"):
        print(m, [(x["survivorId"], x["status"], x["headline"]) for x in mock["modules"][m]["list"]], file=sys.stderr)
    print("composite", mock["composite"]["parts"], file=sys.stderr)


if __name__ == "__main__":
    main()
