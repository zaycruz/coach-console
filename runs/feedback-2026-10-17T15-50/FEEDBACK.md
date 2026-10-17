# Patient 360: clinician feedback, run 2026-10-17T15-50

Four simulated clinicians used https://patient-360.raava.dev. Their issues are merged below and ranked by impact on a live hackathon demo. Blockers come first. Next come issues that more than one persona hit, then issues only one persona hit. Severity sets the order inside each group.

Before ranking, I opened the evidence screenshots for every blocker and major issue. I checked the AUROC claim against `c1-acute-risk/analysis/out/metrics_meps.json`, because the model-card screenshot does not show the metrics. Minor and polish items are listed as the personas reported them. I did not check every one against a screenshot.

Evidence paths are relative to this folder (`coach/`, `carelead/`, `navigator/`, `judge/`).

## Scores

| Persona | Role | Score | Verdict (short) |
|---|---|---|---|
| Marisol | Bilingual health coach, 12-15 calls a day | 6/10 | She would open the call screen tomorrow. She can't run her day on it, because hand-off goes nowhere and a saved call doesn't reach Today or the record. |
| Dr. Okafor | Oncology NP, care-team lead | 6/10 | She would use Hospital risk to build an outreach list. She would not trust Alerts unchecked: the AUROC is from the wrong model, the "driven by" text hides the top driver, and the fairness red flags have no warning. |
| Jen | Nurse navigator, works from the keyboard | 6/10 | Ellie is fast when she answers. But she often fails on rate limits, has no keyboard shortcut and forgets the conversation on reload. |
| Priya | Clinical informaticist, hackathon judge | 7/10 | She would demo Rough weeks and the live-call Copilot. She would not run a huddle off Today, because it hides the urgent wearable patients and buries the symptom. |
| **Mean** | | **6.25** | |

## Ranked issues

### 1. Hand off / Escalate to care team buttons do nothing (blocker)
- **Personas:** Marisol (blocker), Priya (praised the honest toast, but wishes the loop closed into a mock inbox)
- **Steps:** On a call with a concern banner, click "Hand off to care team". Or, on María's page, click "Escalate to care team".
- **Evidence (confirmed):** `coach/18-handoff-click.png` and `coach/20-escalate-click.png`. Both clicks only show a toast: "not connected to a scheduling or messaging system yet". `judge/07-phone-escalate.png` shows the same.
- **Fix:** Log the hand-off locally: who was told, when, and a note. Mark the alert "Handed off by <coach> HH:MM" and move it off Act today. Show it in a mock care-team inbox, so the demo shows the loop closing.

### 2. A saved call never reaches the patient record, the Calls list or Today (blocker)
- **Personas:** Marisol (blocker), Priya (major), Dr. Okafor (asked for a way to mark alerts handled)
- **Steps:** Start a call with María, add lines including a new medical concern (swollen ankles, dizziness), then click End and save call. Open her Coaching calls tab, the Calls list and Today.
- **Evidence (confirmed):** `coach/13-recap-fresh-reload.png`: the live-call page shows "Last call · Oct 17, 2026, Logged in Patient 360". `coach/14-patient-c5-after.png`: the patient tab still says 1 call, Score 81, Call 5 · Aug 18, 2025. `coach/15-calls-list.png`: the new call is not listed. `coach/19-today-after-call.png`: María's Today row still shows the August "06:18 in call 5" reason. `judge/18-desktop-live-call-mic.png`: the judge sees the new flagged line only on the call page.
- **Fix:** Write the saved call to the same store that the patient page, the Calls list and Today read. Make it the latest call everywhere. Let a new concern update the headline, status and Today reason. Let a logged hand-off shrink the Act-today list.

### 3. Ellie fails with raw rate-limit errors (blocker)
- **Personas:** Jen (blocker), Dr. Okafor (minor)
- **Steps:** Ask 4-6 questions in a minute or two. Replies come back as "Sorry, I couldn't answer that (module unavailable: 3021: rate limiting: inference request per min rate reached). Try again." The generic error is doubled: "(Ellie could not answer just now. Try again.). Try again."
- **Evidence (confirmed):** `navigator/10-medical-q.png` and `navigator/18-glucose-tab.png`. Okafor reported the same text in `carelead/09-ellie-fairness-question.png`.
- **Fix:** Resolve navigation commands ("open X", "start a call with Y", "go to the glucose tab") locally, without the model. Pool or raise the quota, and queue and retry automatically. Show "Ellie is busy, retrying…" and never show the infrastructure text. Fix the doubled error string. Before the demo, warm up Ellie and pace the questions.

### 4. Today and Ellie leave out the urgent wearable (C3) patients, and Ellie's counts disagree with Today (major)
- **Personas:** Priya (major), Jen (major), Marisol (11 vs 8 mismatch)
- **Steps:** Today says "11 Need a person today", but Start here shows 8 coaching-call rows. Patients filtered to Act today shows 11, including P02185 (6%, about 5x usual) and P03000 (10%, about 9x usual), and neither is on Today. Ask Ellie "who needs a call today?". On one run she says "Eight patients…". On another she says "Eleven patients… all flagged in their coaching calls" but names only 8. Ask "who is most at risk" and she answers only with hospital-risk IDs, none of the Act-today people.
- **Evidence (confirmed):** `coach/01-landing.png` and `judge/02-phone-landing-full.png` (8 rows under the 11 tile). `carelead/13-patients-search-hospital.png` (P02185 and P03000 are Act today). `judge/15-desktop-c3-urgent.png` (P03000 at about 9x usual). `navigator/21-call-second.png` ("Eight patients"). `judge/13-phone-ellie-clinical-q.png` ("Eleven… all flagged in their coaching calls", 8 names). `navigator/04-most-at-risk.png` (C1 IDs only).
- **Fix:** Show every Act-today patient on Today, ranked across programs with urgent ER risk first. If the list must be capped, say "3 more Act today". Have Ellie answer from the same full list and the same order. When Ellie picks a lens, she should name it ("By hospital risk (C1): …").

### 5. The actual symptom is hidden behind "Medical concern at 06:18 in call 5" (major)
- **Personas:** Marisol (major), Priya (major)
- **Steps:** Today > María > Open. The headline and Ellie's insight only repeat "medical concern needs follow-up". The patient's words ("I get out of breath just walking to the kitchen") appear only after you expand "More detail · Lines that need a person", or after Start call.
- **Evidence (confirmed):** `coach/02-patient-maria.png`, `coach/05-more-detail.png`, `coach/07-start-call.png` / `coach/10-mic-transcribed.png` (the good recap appears only on the call page).
- **Fix:** Put the flagged quote, or a one-line symptom summary ("new shortness of breath on exertion"), on the Today row and in the patient headline. Put the first 2-3 lines of the hand-off note on the patient page. Make Ellie's insight name the symptom instead of repeating the alert.

### 6. The saved call shows "Coach Coach", and the app has no idea who the coach is (major)
- **Personas:** Marisol (major), Priya (major)
- **Steps:** End and save a call, then read the Last call strip.
- **Evidence (confirmed):** `coach/13-recap-fresh-reload.png` and `judge/18-desktop-live-call-mic.png` show "Coach **Coach**". The header names Coach Kendra, but the AI note says "Coach Marisol". That name comes from the transcript (the coach said "This is Marisol…" in `coach/10-mic-transcribed.png`), so the note is grounded. The real gap is that the app has no signed-in coach identity, so the record shows Kendra and the note shows Marisol.
- **Fix:** Add a current-coach identity, even a picker. Stamp it on saved calls. Use it in the recap header, and in the "handed off by" label from issue 1.

### 7. Header numbers and the coaching record don't agree with each other (major)
- **Personas:** Marisol (minor), Dr. Okafor (major), Priya (vocabulary drift)
- **Steps:** Today says "59 Alerts to review", but its link says "62 more alerts". María is "call 5", but the record shows "Calls on file 1" and "1 call". Calls 1-4 are missing. Program focus says "movement", but the call goal is "sleep". An Aug 18, 2025 flag is still "Act today" 14 months later.
- **Evidence (confirmed):** `coach/01-landing.png` (59 vs 62), `carelead/11-maria-coaching-tab.png` (call 5, Calls on file 1, focus movement vs goal sleep, Aug 18, 2025).
- **Fix:** Load all calls, or say "only supervisor-labelled calls are loaded". Make the link count match the tile, or explain the difference. Show how old each alert is ("flagged 14 months ago, never closed"). Fix the focus and goal in the seed data.

### 8. ER/hospital risk is split across two pages with different horizons (major)
- **Personas:** Dr. Okafor (major), Priya (the same split leads to issue 4)
- **Steps:** Patients, search "hospital". The top two rows are C3 patients at 6% and 10% for the next 7 days, marked Act today. Neither appears on Hospital risk, which lists only C1 next-year risk (70% = Alert). The app never explains the two horizons.
- **Evidence (confirmed):** `carelead/13-patients-search-hospital.png`, `carelead/02-hospital-risk.png`.
- **Fix:** Add a "Next 7 days (wearables)" section to Hospital risk, or label the horizon on every row ("next 7 days" vs "next 12 months"). Explain why 6% in a week is Act today while 70% in a year is Alert.

### 9. The floating "Ask Ellie" button and the open panel cover content (minor, 3 personas)
- **Personas:** Marisol, Jen, Priya
- **Steps:** Scroll Today to the last row, or read the cues during a call. The pill covers the last Open button and the cue text. With Ellie open, a panel about 420px wide covers the page Ellie just opened.
- **Evidence (confirmed):** `coach/01-landing.png` (it covers the last row's Open), `coach/17-play-live-40s.png` (it covers the cue), `navigator/21-call-second.png` and `navigator/23-glucose-open.png` (the panel covers the page), `judge/09-phone-patients.png`.
- **Fix:** Dock Ellie as a side column that pushes content over, or collapse her to a slim bar after a navigation command. Reserve bottom padding, and use an icon-only button on phones.

### 10. Developer text, jargon and drifting vocabulary in clinician views (minor, 4 personas)
- **Personas:** Marisol ("GLM-checked", "MITI-style targets", coach score mid-call), Priya ("Not in this program's response yet: tags[] on roster rows", "Copilot: other · GLM-checked", Watch vs Keep an eye on, Rough weeks vs Rough patch, Hospital vs Acute care risk, Ellie vs Copilot, C1-C5 chips with no legend), Jen (replies end with "Opened p-c1-S71188550" and "[ids: c5-P0002]"), Dr. Okafor (Watch vs Keep an eye on, inconsistent AI provenance labels)
- **Evidence:** `coach/11-typed-lines.png` (GLM-checked, MITI), `carelead/04-patient-S71188550.png` and `judge/15-desktop-c3-urgent.png` (tags[] footer), `navigator/21-call-second.png` ("Opened live-c5-P0117"), `carelead/07-model-card.png` and `carelead/13-patients-search-hospital.png` (Watch vs Keep an eye on).
- **Fix:** Remove schema, debug and model-name strings, or move them behind "technical details". Choose one term per concept. Give the C-chips readable labels. Turn "Opened …" into a link with the patient's name.

### 11. The Hospital risk tier tiles are hard to read and mix populations (minor, 2 personas)
- **Personas:** Dr. Okafor, Priya
- **Steps:** The tile reads "57% Alert: 92 people in the test set had an ER visit or stay this often". The patient page shows "Alert line 43%" (the threshold). The roster has 40 Alerts, not 92. "2018" and "2017" read as stale dates.
- **Evidence:** `carelead/02-hospital-risk.png`, `judge/10-phone-hospital-risk.png`.
- **Fix:** Use "Alert: risk ≥43% · 57% of these had an event (92 people, CV set)". Name the population behind each number. Label the years as the dataset years.

### 12. Hospital-risk and glucose patients appear only as IDs (polish, 2 personas)
- **Personas:** Jen, Priya
- **Evidence:** `navigator/04-most-at-risk.png`, `carelead/02-hospital-risk.png`.
- **Fix:** Lead with a display name, or age/sex/cancer, and show the ID second.

### 13. The "What raises or lowers risk across everyone" panel shows raw JSON (major)
- **Personas:** Dr. Okafor
- **Evidence (confirmed):** `carelead/03b-model-panels-crop.png`. Every bullet is a raw object, such as `{"factor":"ER visit or hospital stay in 2017","withFactor":{"n":140,"rate":0.457…},…,"rateRatio":2.128…}`.
- **Fix:** Render it as a table (factor | n with | rate with | rate without | rate ratio), as percentages to one decimal, sorted by ratio. A forest plot would be better still. This is cheap to fix and very visible to judges.

### 14. The headline AUROC (0.67) belongs to the logistic model, not the deployed forest (major)
- **Personas:** Dr. Okafor
- **Evidence (confirmed):** `carelead/02-hospital-risk.png` shows "0.67 (95% CI 0.61–0.72)". `c1-acute-risk/analysis/out/metrics_meps.json` says `finalModel = forest`, with `forest.auroc = 0.713 (0.662–0.764)` and `logistic.auroc = 0.666 (0.610–0.725)`. The tile matches the logistic model. The caveats quote a third figure, "nested CV +0.04".
- **Fix:** Show the deployed model's validated AUROC, with the baseline next to it and the validation named. Keep the other numbers in the model card.

### 15. The "driven by X" headline hides the model's top driver, health spending (major)
- **Personas:** Dr. Okafor
- **Evidence (confirmed):** `carelead/04-patient-S71188550.png`: the headline says "nights in hospital", but the top bar is Total health spending +0.47 (nights +0.39). `carelead/06-patient-S9C1421D3.png`: the headline says "ER visits", but spending is +0.36 vs ER +0.26.
- **Fix:** Name the actual top contributor, or state plainly that spending is excluded from the headline as a cost proxy. Then reconsider whether cost belongs in the model, since cost as a proxy for need is a known source of bias.

### 16. Fairness red flags are shown but not called out (major)
- **Personas:** Dr. Okafor
- **Evidence (confirmed):** `carelead/03b-model-panels-crop.png`: NH Black has n=47, AUROC 0.48, observed 23% vs predicted 32%, and no warning. NH other/multiple has AUROC 0.21. `carelead/06b-S9C1421D3-header.png`: this patient is in the 0.21 group and is still a plain Alert. `carelead/14-ellie-on-S9C1421D3.png`: Ellie says 0.21 "barely separates", but anything below 0.5 means the ranking is inverted.
- **Fix:** Highlight any group with AUROC <0.6, or calibration outside its CI, whatever its n. Add an O/E column. Put a caution chip next to the Alert badge when the patient's group is unreliable. Have Ellie say that AUROC <0.5 means the ranking is inverted.

### 17. Severe glucose findings show only as "Alert", on data up to two years old (major)
- **Personas:** Priya
- **Evidence (confirmed):** `judge/16-desktop-glucose-patient.png`. N0872: 0% in range, average 306 mg/dL, Alert, last data Nov 10, 2024. N1530: lows 10.3% below 70, Alert, last data Jul 7, 2024. Many rows date from 2024.
- **Fix:** Escalate extreme highs and frequent lows to Act today, or add a hyper/hypo flag. Grey out stale data, or label it ("no data for 16 months").

### 18. Copilot cues read like AI instructions, and the Spanish mixes tú and usted (major)
- **Personas:** Marisol
- **Evidence (confirmed):** `coach/17-play-live-40s.png`. The cue paragraphs are meta-instructions, and one contains the leaked text "Example: 'say' thing.". The coach speaks to 65-year-old Osvaldo with usted, but the cues use "¿Cómo te imaginas tú…?" and "quieres". `coach/11-typed-lines.png` shows another long cue paragraph.
- **Fix:** Give one line the coach can say, with the rationale in small print. Match the patient's register (usted). Strip the template text that leaks into cues.

### 19. Ellie's out-of-range glucose list is sorted by ID, so "the first one" is the mildest (major)
- **Personas:** Jen
- **Evidence (confirmed):** `navigator/23-glucose-open.png`. The list order is N0072 (63%), N0085, N0632, N0767, N0872 (0%, avg 306)… "open the first one's glucose tab" opened N0072.
- **Fix:** Sort by severity (lowest time in range, or most lows) whenever a list feeds "the first one".

### 20. No keyboard shortcut opens Ellie (major)
- **Personas:** Jen
- **Evidence (confirmed):** `navigator/02-after-shortcuts.png`: after pressing /, Ctrl+K, Cmd+K and ?, the panel is still closed.
- **Fix:** Bind Cmd/Ctrl+K (and /) to open Ellie with the input focused. Show the hint on the button.

### 21. Single-persona minor and polish items
- **End and save gives no confirmation** (Marisol, minor). `coach/12-after-save.png`: the lines disappear and "Writing a hand-off note…" appears, with no "Call saved" message. Fix: show a "Call saved · hand-off note ready" toast.
- **Ellie forgets the conversation on reload** (Jen, minor). `navigator/16-after-reload.png`. Fix: keep the thread in sessionStorage for the shift.
- **"Open Rosa" picks one of two Rosas without asking** (Jen, minor). No screenshot. Fix: show both as chips, or say which one was chosen.
- **Opening a patient from Hospital risk loses your place** (Dr. Okafor, minor). `carelead/04-patient-S71188550.png`: the back link says "← Patients", and you need about 13 clicks of "Show 15 more" to see all 199. Fix: go back to the page you came from, add next/previous patient buttons, and offer "show all" or a tier filter.
- **Phone tables clip the WHY column** (Priya, minor). `judge/09-phone-patients.png`, `judge/10-phone-hospital-risk.png`. Fix: use Today's card layout below 600px.
- **Suggestion chips go stale** (Jen, polish). `navigator/21-call-second.png` still offers "Start a call with them" after a call has started. Fix: build the chips from the last answer.
- **Synthetic data error: male patient with endometrial cancer** (Marisol, polish). `coach/17-play-live-40s.png` (Osvaldo · 65M · endometrial). Fix: correct the seed data. Judges will spot it.
- **Small gaps in the patient cards** (Dr. Okafor, polish). The Hospital stays card renders "· details ›" with no reference value, AI provenance labels are inconsistent, insight bullets are cut off, and the 75+ group's under-prediction is not called out. `carelead/04-patient-S71188550.png`, `carelead/05-S71188550-health-chart.png`.

## Dropped (not confirmed)

- **A mic line arrived late, out of order and duplicated after Stop mic** (Marisol, major). The cited screenshot, `coach/11-typed-lines.png`, shows the transcript scrolled to 00:14 onward, so no 00:07 line after 00:12 is visible. `coach/10-mic-transcribed.png` shows the greeting once. To confirm it, the bug needs a scripted repro (Start mic → speak → Stop → type at once → read all line timestamps).
- **Ellie's "most at risk" list grows from 4 to 8 patients between asks** (Jen, part of issue 4). Only the 4-patient answer is in the screenshots (`navigator/04-most-at-risk.png`). I kept the rest of issue 4, which is confirmed.
- **"The AI hand-off note names the wrong coach"** (Priya, as worded). The note's "Marisol" comes from the transcript, where the coach introduced herself as Marisol. I merged this into issue 6 as a missing coach identity, not a hallucination.
- **Ellie's insight is slow ("reading the chart…" after 1 s)** (Dr. Okafor). `judge/15-desktop-c3-urgent.png` shows the loading state but not how long it lasted. I left it out of the ranking.

## What worked

- **Today answers "who do I call and why" at a glance:** a red Act today tag, a one-line reason and Start call on each row. It works on the phone too (Marisol, Priya).
- **The live-call screen:** the last-call strip, the flagged quote, an AI hand-off note that reads like a real SBAR-lite recap, and a "Still open" list. After a call, the note was rewritten correctly with the new symptoms (Marisol, Priya).
- **The mic transcribes well:** speech was transcribed in about 8-10 s and tagged by the Copilot (Marisol, Priya).
- **Typed lines are fast:** pick a speaker and a language per line, then press Enter. Spanish lines are tagged sensibly (Marisol).
- **The concern banner is a real safety net:** "Medical concern: tell the care team today" appeared within seconds, with Jump to line (Marisol).
- **"Play as live" replays feel real:** a line every 1.5 s, concern banners, Spanish cues (Marisol, and Priya would demo it).
- **The C3 Rough weeks patient page is the best page in the app:** "10% in the next 7 days, about 9x usual", the threshold, the drivers, watch wear time, and a Do-next written in nursing language (Priya).
- **Per-patient Hospital risk drivers are transparent:** signed log-odds bars, plain reasons with a reference point, and fitting actions (Dr. Okafor).
- **Candid model transparency:** AUROC with a CI, a fairness table that labels small groups, caveats, and "associations, not causes" (Dr. Okafor, Priya).
- **Honest empty states and failures:** empty program tabs explain why they are empty, a stale-copy banner shows when a program times out, and Escalate admits it is not connected (Dr. Okafor, Priya).
- **Ellie as a navigator:** follow-ups such as "open the first one", "start a call with them", "open that one" and "open the first one's glucose tab" each work in about 2.5 s. She gave an honest "María isn't in the glucose program" (Jen).
- **Ellie's clinical guardrails:** she declined a patient-specific chest X-ray recommendation, gave a careful general answer on ibuprofen, and every answer carries "AI · CHECK BEFORE ACTING" (Jen, Priya).
- **Clean runs:** no console errors and no horizontal scroll at 390px (Priya).

## Wishes

**Close the loop (the most-requested theme)**
- Log hand-offs with who, when and a note, show them in a mock care-team inbox, and take the patient off Act today with "handed off by Marisol 11:52" (Marisol, Priya).
- Add an outreach status per patient (called / scheduled / declined) so the Alert list becomes a worklist (Dr. Okafor).
- Add one-tap call outcomes: no answer, left voicemail, reschedule (Marisol).
- When a logged call raises a new concern, update the record and Today at once (Priya).

**One triage queue**
- Build one cross-program queue that ranks a 9x ER risk alongside the call flags (Priya, Jen, Dr. Okafor).
- Give one "who needs me today" answer from Ellie that matches Today, with a count you can trust (Jen).
- Combine C1 annual risk, C3 7-day signals and call concerns into one ER/admission view, once the programs share a patient ID (Dr. Okafor).

**Put the substance up front**
- Show the patient's words, or the first two sentences of the hand-off note, on every Act-today row (Marisol, Priya).
- Make Ellie's insight add something new (the symptom, the trend) instead of repeating the alert (Priya).
- Add a "data as of" or staleness flag on every program pill (Priya).

**Model trust (Dr. Okafor)**
- Add a calibration plot (predicted vs observed by decile).
- Add a toggle to exclude health spending and see how the Alert list changes.
- Show subgroup confidence next to each Alert badge.
- Export the Alert list (ID, risk, top drivers, action) for the huddle.

**Ellie ergonomics (Jen)**
- Cmd+K opens Ellie with the cursor in the box. Up-arrow repeats the last question.
- Run navigation commands locally so they work when the model is rate-limited.
- Ask which patient is meant when a name matches more than one.
- Keep the thread across reloads for the whole shift.
- Add voice input to Ellie.
- Collapse Ellie to a slim bar after she opens a page.

**Coach workflow (Marisol)**
- A "My patients" filter on Calls.
- A Spanish UI toggle, and hand-off notes in the patient's language.
- Automatic speaker detection (coach vs patient) while the mic is on.
