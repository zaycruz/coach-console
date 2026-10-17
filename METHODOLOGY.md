# Methodology — Patient 360 (coach-console)

Patient 360 is a clinician-facing console for a cancer-survivorship care team. It reads four challenge modules (C1 hospital risk, C3 rough weeks, C4 glucose, C5 coaching calls) through one Cloudflare Worker and shows them as one patient record. It trains no model of its own. It adds three generative calls (the AI assistant, AI Insight and the call recap), one speech-to-text call (Whisper) and fixed rules: the Today ranking and the assistant's red-flag answers. This file covers only those parts. Each module's own model is documented in that module's repo.

The hospital-risk (C1) patients are real MEPS 2017 survey respondents, with IDs reassigned by the organisers. Every other record is synthetic. Each program has its own cohort, so no patient is in more than one program. Source: `README.md`.

## Where the numbers live

- `runs/2026-10-17T20-41-26/manifest.json`: the latest E2E run on origin/main (every check, pass or fail, with detail).
- `runs/reproduce-20261017T172436Z.md` and `runs/reproduce-20261017T172436Z/manifest.json`: an E2E run from a fresh clone on Cloudflare Containers.
- `runs/feedback-2026-10-17T15-50/FEEDBACK.md`: a simulated-clinician feedback session.
- `INTEGRATION.md`, `DESIGN.md`: the cohort size and the fallback snapshot size.
- `runs/perf/` holds probe scripts only. It holds no results, so this file gives no latency numbers.

There is no trained model here, so there are no AUROC, calibration or CI figures for Patient 360. The module metrics shown in the UI come from each module's API. They are not computed here.

## Key facts

| Fact | Value | Source |
|---|---|---|
| Patients across C1/C3/C4/C5 | 335 | `DESIGN.md`; `total` in `runs/2026-10-17T20-41-26/manifest.json` |
| Saved fallback copy | 375 responses | `INTEGRATION.md` |
| Module fetch timeout before fallback | 10 s | `INTEGRATION.md` |
| E2E run cited by the monorepo | 114 passed, 0 failed | `runs/2026-10-17T20-21-00/manifest.json` |
| Latest E2E run | 110 passed, 4 failed (horizontal scroll at 390 px) | `runs/2026-10-17T20-41-26/manifest.json` |
| Fresh-clone reproduce run | 90 passed, 0 failed (commit `a7c85eb`) | `runs/reproduce-20261017T172436Z.md` |
| Simulated clinician scores | 6, 6, 6, 7; mean 6.25 (out of 10) | `runs/feedback-2026-10-17T15-50/FEEDBACK.md` |

---

## 1. Generative AI

### 1.1 Shared model call: `glm()`

All three text calls go through `src/index.ts` (`glm`).

- Primary model: `@cf/zai-org/glm-5.3-flash` on Workers AI (`GLM`). Settings: `reasoning_effort: "low"`, and a strict JSON schema in `response_format`.
- On a rate-limit error (code 3021 or "rate limit"), it waits 1.2 s and retries GLM once. On any other error it also retries once, with no wait.
- If GLM still fails, it calls `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (`FALLBACK_LLM`) with the same messages and the same JSON schema.
- If both fail, or the output does not parse as a JSON object, `glm()` returns `null`. The caller then uses its own fallback (see below).
- `glm()` does not report which model answered. The assistant, insight and recap responses always write `model: GLM`, even when Llama answered. The insight cache in KV stores that value too.

### 1.2 Guardrails that apply to every call

The model writes words only. It does not rank, tier or score patients.

| Guardrail | Enforced by |
|---|---|
| Output must match a strict JSON schema (`additionalProperties: false`) | Code: `response_format` in `glm()`; non-object output is dropped |
| Rankings and tiers come from rules, not the model | Code: `searchPatients`, `bySeverity`, `sev` (`src/index.ts`); `today()` (`src/today.ts`) |
| The model may open only known routes and known patient IDs | Code: `ROUTE_OK` and `resolve()` in `assistantTurn` |
| No invented facts; no diagnosis; no prescribing | Prompt only (wording differs per call, quoted below) |

The prompts contain no rule that names drug dosing. The closest rules are "never diagnose or prescribe for a specific patient" (assistant), "No diagnosis, no prescribing, no invented facts" (insight) and "No diagnosis" (recap). The UI copy for C4 says "The coach does not change medication." (`public/adapters.js`, `c4View`). That text is fixed. It is not model output.

### 1.3 AI assistant — `POST /api/assistant`

Code: `src/index.ts` (`assistant`, `assistantTurn`, `searchPatients`, `getPatient`); browser side `public/assistant.js` (`ask`, `quickRoute`, `resolveRef`).

**Order of handling for one question.** The first step that answers ends the turn.

1. **Browser commands, no model.** `resolveRef` and `quickRoute` in `assistant.js` handle plain commands ("open glucose for N0072", "open the first one", "start a call with them"). They open the page at once.
2. **Red-flag rules, no model.** The Worker checks the question against `RED_FLAGS` (see 2.1). On a match it returns a fixed answer with `model: "rules"`. This runs before any model call.
3. **Roster fast path, no model.** "Who is most at risk of the hospital" and "who needs a call today" are answered from the roster with the rule order (see 2.3). It returns `model: "roster"`.
4. **GLM tool loop.** At most 4 model calls. Each step returns one JSON object with `tool` set to one of: `answer`, `search_patients`, `get_patient`, `read_page`, `navigate`, `open_tab`, `start_call`. The Worker runs the three data tools and loops. The other tools end the turn. On the 4th call the prompt says "You must finish now".
5. **No-model fallback.** If `glm()` returns `null`, `noModel()` answers from the roster. If the question names a patient, it lists up to 3 rows from the record. If not, it says: "I can’t reach the language model right now, so here is what works instantly: …".

**Input.** The question (up to 1,000 characters), the last 8 turns, a page summary (`readPage`, up to about 3 KB), the patient on screen, the patients the question names, the roster counts and up to 2,000 roster rows (id, name, program, tier, headline, tags).

**Allowed output.** One `assistant_step` object (`ASSISTANT_SCHEMA`). `kind` is one of `navigation`, `patient`, `medical`, `other`. `status`, `program` and `sort` are fixed enums.

**Guardrails.**
- Code: a `navigate` route is kept only if it matches `ROUTE_OK` and uses an ID the Worker sent (`resolve()`). Anything else is dropped. Cited IDs that the Worker did not send are dropped. "[ids: …]" text is removed from the answer. The on-screen patient is cited only when the answer names them.
- Code: patient lists come from `searchPatients`, which sorts with `bySeverity` (tier first, then severity). The model does not sort.
- Prompt only: "Patient facts come ONLY from the context and tool results. Never invent a number, date, diagnosis, name or id." "Medical questions: concise mainstream clinical information (guideline level), say when it depends on the person, never diagnose or prescribe for a specific patient. Flag emergencies plainly." "Keep the order search_patients returned (most severe first); never re-sort by id." No code checks that the answer keeps that order.

**Label the user sees** (`public/assistant.js`, `ask`):
- Panel header: "AI assistant", "for the care team".
- Greeting: "Hi, I’m the AI assistant. I can find patients, explain their numbers, open any page or tab, start a call, and answer general medical questions." with the note "I read the same data you see. Check anything clinical before acting."
- "AI · check before acting" appears **only when `kind` is `medical`**. As a result:
  - The red-flag answers carry this AI label, but no model wrote them (`model: "rules"`).
  - Model answers with `kind` `patient`, `navigation` or `other` have no AI label.
  - Roster fast-path answers have no AI label.

**Fallback.** `glm()` falls back to Llama 3.3 70B. If that also fails, `noModel()` answers from the roster. Any thrown error returns HTTP 503 with "The AI assistant is busy". A code comment says "the client retries once". `ask()` in `assistant.js` does not retry. It shows "Sorry, I couldn’t answer that (…). Try again." On the saved-copy Artifact build (`SNAP`), the browser says "The AI assistant needs the live site to reach the model."

**What was measured** (`runs/2026-10-17T20-41-26/manifest.json`; all passed):
- "AI assistant opens a patient's glucose page" (a browser command, no model).
- "AI assistant answers from the patient on screen". The check passes if the answer matches `/range|70|180/` and does not contain "couldn". It does not compare the answer's numbers with the record. The answer recorded in the manifest ends with "AI · check before acting".
- "AI assistant: red-flag question gets the emergency answer" (the fever prompt only).
- "AI assistant names patients for a risk question", and the two follow-ups ("that first patient", "start a call with them") open the patient it named.

### 1.4 AI Insight — `POST /api/insight`

Code: `src/index.ts` (`insight`); browser side `public/assistant.js` (`getInsight`, `fillInsight`, `paintInsight`, `fallbackInsight`).

**Input.** One patient's compact chart (`compactPatient`: name, program, tier, headline, facts, tags, KPIs, advice titles, panel titles, footnote and, for C1, `forAssistant`), up to 6,000 characters.

**Allowed output.** `{ headline, bullets }` (strict schema). The prompt's current version asks for ONE sentence (at most 25 words) "about what changed or what is dangerous, in clinician voice … with NO numbers, percentages or scores and NO action", and an empty bullet list.

**Guardrails.**
- Code: the headline is cut to its first sentence and to 220 characters. Bullets are cut to 15 words, and at most 3 are kept.
- Code: if the patient has C1's `forAssistant` line, the Worker puts it first in `bullets`, word for word.
- Prompt only: "Use ONLY the patient data given", "No diagnosis, no prescribing, no invented facts", and the no-numbers rule. No code checks for numbers.
- Caching: KV key `insight2:<id>:<hash of the input>`, so the same data gets the same text.

**What the screen shows.** `paintInsight` renders only the headline. It never renders `bullets`. So the C1 `forAssistant` line and its caveat do not show in the Insight box. A code comment says the caveat "is never dropped". That is true of the API response, not of the screen.

**Label the user sees:** "Why now" with "AI summary of this page’s data". While loading: "summarising…". On fallback: "from the program’s own summary". The Insight box has no "check before acting" text.

**Fallback.** `glm()` (GLM, then Llama), then one more `glm()` call if the headline is empty, then HTTP 502 "insight unavailable". The browser then shows the program's own headline (`fallbackInsight`), labelled "from the program’s own summary".

**What was measured:** "Health chart shows the brief: one labelled headline, no bullets" passed. It checks the label text, that the box is under 60 words and that there are no list items. It does not check the no-numbers rule or faithfulness to the data. Source: `runs/2026-10-17T20-41-26/manifest.json`.

### 1.5 Call recap — `POST /api/recap`

Code: `src/index.ts` (`recap`); browser side `public/call.js` (`recapFacts`, `aiRecap`).

**Input.** The patient's name, headline and facts (up to 1,500 characters) and the last call's date, goal and lines (up to 9,000 characters). Lines from a labelled C5 call also carry the supervisor's "needs a person" mark.

**Allowed output.** `{ summary, pickUp[], openConcerns[] }` (strict schema).

**Guardrails.** Prompt only: "Use ONLY the transcript and facts given. No diagnosis. Plain words." The facts above the note (date, coach, goal, score, flagged lines) come from the record, not the model (`recapFacts`).

**Label the user sees:** "AI · check before acting" with "Hand-off note from the transcript". The sections are "Pick up here" and "Still open". While loading: "Writing a hand-off note…".

**Fallback.** `glm()` (GLM, then Llama), then one more `glm()` call, then HTTP 502 "recap unavailable". The browser then shows "Hand-off note unavailable (…). The facts above are from the record."

**What was measured:** "recap date = latest call on record" and "AI hand-off note arrives, labelled as AI" passed. The second check only counts the label. It does not read the note. Source: `runs/2026-10-17T20-41-26/manifest.json`.

### 1.6 Speech to text — `POST /api/stt`

Code: `src/stt.ts` (`stt`); browser side `public/call.js` (mic clips).

**Input.** One short clip from the browser's MediaRecorder, with a language hint `en`, `es`, `ht` or `fr`, or none. Clips under 200 bytes are skipped. Clips over 4 MB are rejected (HTTP 413).

**Model.** `@cf/openai/whisper-large-v3-turbo` on Workers AI, with `vad_filter: true`. It is off-the-shelf and was not tuned or validated here.

**Output.** `{ text }`. The line then goes to Clef (C5) like a typed line.

**Guardrails.** Code: a fixed `PHANTOM` pattern blanks known Whisper inventions on near-silent clips ("thank you for watching", "you", "subtitles by…", "amara.org"). The list is kept narrow on purpose, because a patient may really say "thank you".

**Label the user sees:** "Transcribing…" while it runs. The transcript line has no AI label.

**Fallback.** If a language hint was given and the call fails, it retries once with no hint. If that fails, or there was no hint, it returns HTTP 502 "transcription failed". The browser shows "A clip could not be transcribed (…). Type that line if it matters."

**What was measured:** "mic: a spoken line is recorded and transcribed" passed. The test feeds one fixed English clip (`e2e/fixtures/mic.wav`, "Hi, how have you been feeling since our last call?") through Chromium's fake mic. It passes if the transcript matches `/feel|call/`. The detail recorded in the manifest shows the sentence three times: "hi how have you been feeling since our last call hi how have you been feeling since our last call hi how have you been feeling since …". The check does not catch repeats. Source: `runs/2026-10-17T20-41-26/manifest.json`, `e2e/live.mjs`.

### 1.7 Model calls that Patient 360 consumes but does not own

These run in the C5 coach-copilot Worker. Patient 360 only forwards them.

- `POST /api/c5/turn` (Clef tags each line), `/api/c5/review` and `/api/c5/cue`.
- The browser sends a line to `/api/c5/review` when Clef's confidence is below 0.3 (`public/call.js`, as coded). The review result replaces the tag.
- On HTTP 429 the Worker waits and retries twice (`src/index.ts`, default `fetch`, the `C5_POST` branch).

Their methods and metrics are in the C5 repo, not here.

### 1.8 What is NOT evaluated (generative AI)

- **Faithfulness.** No check compares any assistant answer, Insight or recap with the source record. No numbers in model text are verified.
- **Medical answer quality.** No clinician or LLM judge has rated the assistant's medical answers. No test checks the "no diagnosis / no prescribing" prompt rules.
- **The Llama fallback.** No test forces it. The responses cannot show when it ran, because they always say `model: GLM`.
- **The Insight no-numbers rule.** It is not tested.
- **Recap content.** Only the presence of the label is tested.
- **Whisper.** There is no word error rate. Only one English clip is tested. Spanish, Haitian Creole and French are not tested. There is no test with noise or more than one speaker.
- **Red-flag recall.** Only the fever rule is tested, with one prompt. There is no test of missed red flags or false triggers, and none in Spanish or Kreyòl.
- **Latency.** There is no recorded measurement (`runs/perf/` has scripts and no output; `perf.mjs` still uses the old `#ellie-*` selectors).
- **Fairness and language** of the generated text are not evaluated.

---

## 2. Rules

### 2.1 Assistant red-flag rules (run before any model call)

Code: `src/index.ts`, `RED_FLAGS`, `MEDICAL_Q`, and the check in `assistantTurn`.

**When it runs.** Only on `/api/assistant`. Two conditions must both be true:
- The question does NOT start with open, show, go, start, begin, take me, pull up, who, which or list.
- The question matches `MEDICAL_Q` (what, should, is it, is this, can, do i, does, how, when, chemo, treatment, symptom, "patient has/says/reports", or a "?").

The browser's command handling (`quickRoute`, `resolveRef`) runs before the Worker, so a question it treats as a command never reaches this check. The rules do not run on Insight or on the recap. The first rule that matches wins.

| # | Pattern (as coded, case-insensitive) | Fixed answer (opening) |
|---|---|---|
| 1 | fever, febrile, chills, or a temperature of 38–39.x, or 100–104.x °F | "A temperature of 38°C (100.4°F) or higher during or soon after chemotherapy is an emergency until proven otherwise (possible neutropenic fever)…" |
| 2 | chest pain, chest pressure, short(ness) of breath, can't breathe, trouble breathing | "New chest pain or shortness of breath is a same-day emergency: the patient should call 911 or go to the ER now…" |
| 3 | swollen/swelling … leg, calf or ankle; calf pain | "A new swollen, painful leg can be a blood clot (DVT)… The patient should be seen today…" |
| 4 | fell, a fall, fall(s), hit my/her/his/their head | "A fall needs a same-day check, sooner if the patient hit their head, takes blood thinners, or has new pain, confusion or can’t bear weight (ER)…" |
| 5 | hopeless, suicid…, kill my/her/him/them-sel…, end my / end it all, no point (in) living, self-harm | "Hopelessness or any thought of self-harm needs a person today… 988 (call or text, US) or the ER if they are in danger…" |

The full answer text is in `RED_FLAGS`. The response is `{ kind: "medical", model: "rules", steps: ["red-flag check"] }`. It is the same every time, and it is never rate-limited. The patterns are English only.

### 2.2 Today ranking — `GET /api/today`

Code: `src/today.ts` (`today`). It is cached at the edge with stale-while-revalidate (`src/index.ts`, `swr`).

Each row gets a `horizon` ("today" = Call today, "week" = This week) and a numeric `rank`. Sort order (last line of `today()`): every "today" row before every "week" row, then higher `rank` first. The browser shows at most 8 Call today rows and the first 8 This week rows, each with a "show more" link (`public/app.js`). The rank values below are constants in the code. They are not measured.

**C5 coaching calls.** For each patient, the latest call with a flag is used.

| Case | Horizon | Rank (as coded) | Reason format |
|---|---|---|---|
| Clef demo call with a red banner (replayed today) | today | medical 960, distress 950, social 900 | "<label>, call N, replayed today: “<words>”" |
| Medical or distress flag, under 30 days old | today | medical 960, distress 950 | "<label>, call N, <age>: “<words>”" |
| Medical or distress flag, 30 days or older | today | rank − 60 (900 / 890) | "Close the loop · <label>, call N, <age>: “<words>”" |
| Social-need flag, any age | week | 450 | "Social need, call N, <age>: “<words>”" |

The flag kind (medical, distress, social) comes from the C5 data. In the Worker's own adapter over the labelled calls, it is guessed from fixed word lists (`FLAG_WORDS` in `src/index.ts`). Any line without a distress or social word is "medical".

Note: the header comment of `today.ts` still says C5 flags count "under 30 days old". The code below it puts every medical or distress flag on Call today, and the stale ones read "Close the loop".

**C3 rough weeks.** Rows with `urgent === true`, an "Urgent" headline, or status alert.

| Case | Horizon | Rank | Reason |
|---|---|---|---|
| Urgent (7-day ER/hospital risk over its line) | today | 940 + er/10 (er = `urgentRisk` × 100, rounded) | "ER/hospital risk <er>% in 7 days (<x>× usual), <context>" |
| Rough-patch alert | week | 400 + rough/10 | "Rough week ahead: <rough>% risk, <context>" |

**C4 glucose.** Rows with status alert or `careTeamToday === true`. The horizon is "today" only when `careTeamFlag.urgency` (or `urgency`) is "today", which means level 2 lows. Anything else is "week".
- When C4 sends `careTeamToday` and `todayReason`: rank 830 + (% of readings below 70) if `priority` is 0, 820 if not, or 300 + (100 − time in range)/10 if `careTeamToday` is false. The reason is C4's `todayReason`, word for word.
- Otherwise the Worker uses C4's evidence:
  - Lows (`tbr70` ≥ 4): rank 830 + tbr. Reason: "Glucose: <tbr>% of readings below 70 (target under 4%), risk of lows".
  - High (mean ≥ 250 mg/dL, or time in range < 10): rank 820 + mean/100. Reason: "Glucose: average <mg> mg/dL, <tir>% in range (target over 70%)".
  - Other: rank 300 + (100 − tir)/10.

The E2E asserts "Today API: Act today holds red flags only, no glucose rows", and it passed in the latest run. The code does allow a C4 row on Call today when C4 sends `urgency: "today"`. Source: `runs/2026-10-17T20-41-26/manifest.json`, `src/today.ts`.

**C1 hospital risk.** Rows with status alert or watch, sorted by the risk % parsed from the headline.

| Case | Horizon | Rank | Reason |
|---|---|---|---|
| `redFlags.careTeamToday === true` (a survey red flag), any tier | today | 910 + risk/100 | "Red flag (<age><sex> <cancer>): <survey answers>" |
| Alert tier, top 5 by risk | week | 500 + risk/10 | "ER/hospital risk <risk>% next year, <ER visits and hospital stays last year>" or "…, driven by <driver>" |

**Every row** also carries `data` ("Real survey data (MEPS)" for C1, "Synthetic" for the rest), `language` and `interpreter` (true when the language is not English). The UI shows "Real · MEPS" and "Interpreter · <language>" chips. If a module returns no rows, its name goes into `failed`.

Section texts on the Today page (`public/app.js`):
- "Call today": "Safety lines from calls, urgent 7-day ER risk, survey red flags."
- "This week": "Glucose flags for the care team first, then rough weeks ahead and the highest next-year ER/hospital risk."

**What was measured** (all passed in `runs/2026-10-17T20-41-26/manifest.json`):
- One queue with rows from C1, C3, C4 and C5.
- Every row has a whole reason, never cut.
- C1 rows say MEPS and the rest say synthetic.
- Every coaching-call medical or distress flag is on Call today. The detail reads "8 flagged patients, missing: none".
- Stale flags read "Close the loop".
- The Patients "Act today" count equals the Today count ("13 vs 13").

These checks test that the rules run as coded. They do not test whether the order is clinically right.

### 2.3 Assistant ranking rules

Code: `src/index.ts` (`sev`, `bySeverity`, `hospRisk`, `searchPatients`, the fast path in `assistantTurn`).

- `bySeverity`: the tier first (today, alert, watch, ok), then `sev` from highest to lowest.
- `sev`:
  - C3: 1000 + (× usual) × 10 + ER %, when there is an ER/hospital risk. If not, the rough-patch %.
  - C5: 900 on today, 50 otherwise.
  - C1: the acute-care or ER/hospital risk %.
  - C4: the larger of (100 − time in range) and (% of readings below 70 × 10).
- Hospital fast path: there are two horizons, and the code never mixes them in one list.
  - First: "Urgent this week, by 7-day ER/hospital risk (Rough weeks)" (C3 rows on today).
  - Then: "By next-year ER/hospital risk (Hospital risk model, N scored)" (the top 5 C1 rows).
- Priority fast path: "By Today’s list (Act today, urgent ER risk first)", with the first 12 rows on today.

### 2.4 How Patient 360 consumes C1, C3, C4 and C5

Code: `public/adapters.js` is the only file that knows the module response shapes. `src/index.ts` forwards the module GETs through service bindings.

- **Transport and fallback.** Every GET is cached at the edge (`swr`, fresh for 60 s). The browser falls back to `public/fallback-data.js` when a module fails or a required field is missing (`fetchJSON`, `REQUIRED`). The status chips say live, saved copy or down. Source: `INTEGRATION.md`.
- **One tier everywhere.** The Today queue's "today" rows decide who is Act today on Patients, on the patient page and in the assistant (`actToday`, `oneTier`).
- **C1** (`c1View`): Patient 360 uses C1's `risk`, `status`, `riskWords`, `caveat`, `redFlags` (`careTeamToday`, `fromSurvey`, `banner`), `forAssistant` and drivers. It does not compute any risk itself. It flags a fairness group as unreliable when its AUROC is < 0.6 or its O/E CI excludes 1 (`fairFlag`, as coded).
- **C3** (`c3View`): Patient 360 uses `risk`, `urgent`, `urgentRisk`, `thresholds` and `scheduleRisk`. The "about N× usual" text is parsed from the headline. C3 sends no `tags[]` on roster rows, so Patient 360 derives them from the headline (`INTEGRATION.md`).
- **C4** (`c4View`): Patient 360 uses `evidence` (tir, mean_glucose, tbr70), `tags[]`, `careTeamFlag` (urgency, reasons, rule), `careTeamToday`, `todayReason` and `priority`. Lines that C4 writes to the patient are restated for the clinician (`careVoice`).
- **C5**: It prefers the Copilot's own `/api/c5/*` endpoints. While those do not answer, it uses the Worker's adapter over `demo-calls.json` (`c5`, `callView`, in `src/index.ts`). The adapter's coach score uses "the same arithmetic as the Copilot's live screen" (`scoreMoves`).

### 2.5 Limits of the rules

- The ranking reads numbers out of module headline text with regular expressions (`today.ts`; `hospRisk` and `sev` in `index.ts`). If a module changes its wording, the order can change with no error.
- The rank constants (960, 950, 940, 910, 830, …) are design choices. They were not fitted or validated against outcomes.
- The red-flag patterns are English only, and they run only on the assistant. They are not the C5 red-flag screen, which runs in the C5 Worker.
- The C5 flag-kind guess in the Worker's adapter (`FLAG_WORDS`) is a fixed word list. Anything else is "medical".
- `DESIGN.md` section 3 ("Triage") was written before the C1 survey red-flag rule. The code in 2.2 is the current rule.

---

## 3. How tuning was done

No model was trained, so there is no validation or test set to protect. The prompts and rules were changed many times on the same live data, after the team saw the outputs. Examples:
- The commit log of `src/index.ts` and `src/today.ts` on origin/main (for example "Today: C5 call flags only when under 30 days old", then later "one fixed rule, every coaching-call medical or distress flag is Call today").
- The Insight cache key `insight2` ("v2: one sentence, no numbers").
- The simulated feedback session (`runs/feedback-2026-10-17T15-50/FEEDBACK.md`) found raw rate-limit errors (issue 3) and a list sorted by ID (issue 19). The current code has the GLM retry with the Llama fallback, the no-model roster answers and severity sorting.

There is no held-out check of any prompt.

## 4. Limits

These come from the sources. They are not softened.

- Each program has its own cohort. The linked demo records join patients only by matching sex, cancer type and age (`INTEGRATION.md`).
- Every record except C1 is synthetic (`README.md`).
- The feedback scores come from simulated clinicians (a Claude Code workflow, `scripts/persona-feedback.workflow.js`). Real clinicians gave none. That session was run on an earlier version, which still used the name "Ellie" (`runs/feedback-2026-10-17T15-50/FEEDBACK.md`).
- The 4 failed checks in the latest run are "horizontal scroll" at 390 px on 4 patient overviews. They are not AI checks (`runs/2026-10-17T20-41-26/manifest.json`).
- `INTEGRATION.md` calls `docs/how-it-works.md` "the current reference". That file is not in this repo. It lives in the monorepo: `survivorship-360/docs/how-it-works.md`.
- `docs/ai-ml-map.png` differs from the code in two places. It shows the Insight fallback as "Retry → Llama 3.3 70B". The code does do that, but the program's own headline is shown only after both models fail twice. It shows Whisper as "One retry". The code retries only when a language hint was given.

## 5. Reproduce

```bash
npm ci
npx playwright install chromium
npm run e2e                     # node e2e/live.mjs against https://patient-360.raava.dev
```

- Each run writes `runs/<timestamp>/manifest.json` and prints "N passed, M failed". It exits non-zero on any failure (`README.md`).
- To run from a fresh clone on Cloudflare Containers, use `scripts/reproduce-cf/`. The logged result is in `runs/reproduce-20261017T172436Z.md`.
- The E2E runs against live models, so the model text changes from run to run. No seed is set.
- The E2E marks its requests as test data (cookie `p360test=1`), so its saved calls and hand-offs stay apart from real records (`src/index.ts`, `isTestReq`).

## Code map

| Step | File (function) |
|---|---|
| Shared GLM call, retry, Llama fallback | `src/index.ts` (`glm`) |
| AI assistant tool loop | `src/index.ts` (`assistant`, `assistantTurn`, `ASSISTANT_SCHEMA`) |
| Assistant red-flag rules | `src/index.ts` (`RED_FLAGS`, `MEDICAL_Q`) |
| Assistant patient search and ordering | `src/index.ts` (`searchPatients`, `bySeverity`, `sev`, `hospRisk`) |
| Assistant route and ID guard | `src/index.ts` (`ROUTE_OK`, `resolve` in `assistantTurn`) |
| Assistant browser commands and labels | `public/assistant.js` (`ask`, `quickRoute`, `resolveRef`) |
| AI Insight | `src/index.ts` (`insight`); `public/assistant.js` (`getInsight`, `fillInsight`, `paintInsight`, `fallbackInsight`) |
| Call recap | `src/index.ts` (`recap`); `public/call.js` (`aiRecap`) |
| Speech to text | `src/stt.ts` (`stt`, `PHANTOM`) |
| C5 turn, review and cue forwarding | `src/index.ts` (default `fetch`, `C5_POST` branch); `public/call.js` |
| Today ranking | `src/today.ts` (`today`) |
| Edge cache | `src/index.ts` (`swr`) |
| C5 adapter, flag kind, coach score | `src/index.ts` (`c5`, `callView`, `FLAG_WORDS`, `scoreMoves`) |
| Module mapping and fallback | `public/adapters.js` (`fetchJSON`, `REQUIRED`, `rosterRow`, `c1View`, `c3View`, `c4View`, `c5View`, `actToday`, `oneTier`) |
| E2E checks | `e2e/live.mjs` |
