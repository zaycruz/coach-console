# Coach Console: first-draft UI/UX

The eMerge hackathon has a Healthcare track (Sylvester Comprehensive Cancer Center). This is a first draft of a product for that track, written for the designer. It covers structure, flows and states. It is not pixel polish. The clickable prototype is in `prototype/`: open `prototype/index.html` in a browser. It has no build step and needs no server.

## 1. Product framing

**One sentence:** a morning console for lifestyle-medicine health coaches who work with cancer survivors. It shows who needs a person today and why, and it turns each module's signal into a next step.

| User | What they come for | Where |
|---|---|---|
| Health coach (primary) | Morning triage, prepare for calls, act on flags | Today, Survivor page, Calls |
| Survivor (secondary) | One clear thing to do this week, in their language | Survivor app (phone) |
| Care-team lead (secondary, later) | Who is heading to the ER or hospital (C1), escalations | Care team risk (stub) |
| Lab scientist (different product area) | Drug discovery (C6/C7) | Research (stub) |

The modules behind the console:

| Module | Challenge question | What the console shows |
|---|---|---|
| C3 Bad Week Radar | Can a wearable spot a rough patch before the person says anything? | The last 3 days compared with the person's own previous 28 days for steps, sleep, resting HR and check-in. Treatment days and events are marked. The panel names the signals that are off. |
| C4 Dose and Timing | Does a late dinner matter? Is an evening walk worth it? | One day's glucose curve with meals marked, then the average 2-hour rise for early dinners, late dinners and dinners followed by a walk. The panel turns this into advice the survivor can follow, with a "pattern, not proof" caveat. |
| C5 Coach's Copilot | Can AI follow a coaching call like an expert? | Every line tagged with an MI move or a talk type. A coach score with its four parts, cues, and a red flag banner for anything a person must act on today. |

**The 2-minute judge demo:** open Today and point to the 2 "Act today" rows (C5 flags). Open the composite survivor to show all three modules on one page. Click "Review call" to show the tagged transcript and the flag at 05:12. Then open the Survivor app and switch it to Spanish. Each panel answers its own challenge in its headline. For C3, the Hindsight box shows that the radar fired before an ER visit in the synthetic data.

## 2. The cohort decision (no shared patient key)

The three datasets are different made-up people:

| Module | ID format |
|---|---|
| C3 | `P00001` |
| C4 | `N0001` |
| C5 | `P0001` |

C3 and C5 IDs look alike but are unrelated people. Options:

| Option | Honest? | Demo clarity | Notes |
|---|---|---|---|
| A. Separate tab per module, each with its own roster | Yes | Weak: it feels like three apps | |
| **B. One unified roster with module chips (recommended)** | Yes | Strong | Each row is one person in one module's cohort, and the chip says which. When modules later share a key, one person gets one row with several chips. The UI doesn't change. |
| C. Stitch three people into one invented patient | No | Strong | Judges will ask. Rejected as a silent join. |

**Recommendation: B**, plus **one clearly labelled "Composite demo survivor (illustrative)"** row. It shows one record from each module side by side, so the judges see the product vision. It has a dashed "Illustrative" chip and a note banner on its page. It is never presented as one real person.

Rules that follow from this:

- IDs are namespaced in routes and in the API: `c3:P00809`, `c4:N0214`, `c5:P0975` (route form `#/s/c3/P00809`).
- A survivor page always shows all three module slots. A module the person is not in shows the state **"Not in this module's demo cohort"**, which is a first-class state and not an error.
- The persistent "Synthetic demo data" pill sits in the top bar.

## 3. Information architecture

```
Coach Console
├── Today                 #/today           morning triage roster (all modules)
├── Survivor              #/s/:module/:id   one person: C3 / C4 / C5 panels + actions
│                         #/s/demo          composite demo survivor (illustrative)
├── Calls                 #/calls           reviewed calls, flags first
│   └── Call review       #/call/:callId    tagged transcript, score, flags, cues
├── Survivor app          #/patient/:module/:id  or  #/patient/demo   phone preview, EN/ES/HT
└── Later
    ├── Care team risk    #/care-team       C1 stub (risk badge + rules)
    └── Research          #/research        C6/C7 stub (separate area, different user)
```

Navigation is a left rail on desktop and a bottom tab bar under 760px. "Later" items carry a `C1` or `C6·C7` tag and stay visible, so the suite reads as one product with room to grow.

## 4. Triage rule (Today ordering)

1. **Act today**: a C5 line flagged `needs_human` (medical, distress or social). A person must follow up today.
2. **Rough patch likely** (`alert`): C3 with 3 or more signals off the person's usual, or C4 with 25% or more of readings above 140 mg/dL or a late-dinner gap of 35 mg/dL or more.
3. **Keep an eye on** (`watch`): any single signal off, a C5 coach score under 60, or a moderate C4 pattern.
4. **On track** (`ok`).

Within a group, rows sort C5, then C3, then C4. When C1 lands, its risk badge sits on the row; it does not change the order until the care team agrees how it should. Status always shows as colour + glyph + word (▲ Alert, ! Watch, ✓ On track, ● Act today), never colour alone.

## 5. Primary flows

**A. Morning triage → deep dive → act**

1. Today: the summary tiles give counts per group. Tap a tile to jump to that group. Module filter chips sit above the list.
2. Tap a row. The survivor page opens with that module's panel first.
3. Read the panel: headline, then why (evidence with the person's own numbers), then next steps (tagged *For coach* or *For survivor*).
4. Act from the action bar under the header:
   - Escalate to care team (shown only when a C5 flag exists)
   - Schedule call
   - Send check-in text (drafted in the survivor's language)
   - Mark reviewed

**B. Review a coaching call**

1. Go to Calls (flags first), or use "Review call" on a survivor's C5 panel.
2. Flag banners at the top have three actions: Hand off to care team, Jump to line, Mark handled.
3. Transcript: each line shows its time and speaker, then a tag:

   | Line | Tag |
   |---|---|
   | Coach | one of the 12 MI moves |
   | Participant | change, sustain or neutral talk, plus any flag |

   A dashed tag means the line was double-checked by the second model (low Clef confidence). Cues appear inline under the line that triggered them.
4. Side column: the coach score (0 to 100) and its 4 parts with targets, move counts, participant talk counts, and supervisor actions (Save review, Share with coach).

**C. Survivor-facing advice**

1. The Survivor app is a phone frame. It shows:
   - one focus per card, with a "done this week" checkbox
   - "Why this?" with the survivor's own numbers
   - "Go easy on yourself" during a C3 rough patch
   - the next call with their coach
   - a safety line that is always visible
2. Language: EN, ES and HT. HT is a stub until a native speaker reviews it.
3. The survivor never sees scores, risk labels or the word "alert".

## 6. Screens and states

The "Preview state" select in the top bar forces each screen into a state. You can also add `?state=loading|empty|error` to the hash. The alert state comes from the data itself.

| Screen | Ready | Loading | Empty | Alert | Error |
|---|---|---|---|---|---|
| Today | Grouped roster, tiles, filters | Skeleton rows | "No survivors assigned yet…" | Act today group at the top, red stripe | Module didn't answer; other modules still load (designer: show a partial roster with a per-module error chip) |
| Survivor | 3 panels + action bar | Skeleton | "No module has data yet…" | C5 flag banner in the panel and an Escalate button | Error card with retry |
| Survivor, module not joined | Dashed "Not in this module's demo cohort" | n/a | n/a | n/a | n/a |
| Calls | List with score and status | Skeleton | "No calls reviewed yet…" | Flagged calls at the top | Error card |
| Call review | Transcript + side column | Skeleton | "No lines yet; live lines appear as people speak" | Red banner(s) and highlighted line(s) | Error card |
| Survivor app | Cards | Skeleton | "First tip appears after a week of data" | n/a (no alerts to survivors by design) | "Couldn't load your plan" |
| Care team risk / Research | Stub | n/a | n/a | n/a | n/a |

Not built in the prototype, needed for production:
- Live call mode, where lines stream in and the score updates.
- A stale-data badge, when the watch hasn't synced for more than 24 h.
- A per-module partial-failure chip on Today.

## 7. Component inventory

| Component | Notes |
|---|---|
| App shell | Left rail / bottom tab bar; top bar with the synthetic-data pill, data as-of time and the state preview control |
| Summary tile | Count + group label; clicking jumps to the group |
| Roster row | Status stripe, name + cohort, headline, module chip(s), status pill, updated time |
| Module chip | Dot in the module hue + `C3 · Wearables`. Dashed variant = illustrative |
| Status pill | ok / watch / alert / act-today; glyph + word |
| Banner | info (dashed) and alert (red, with actions) |
| Module panel | Top border in the module hue; eyebrow, headline, status, summary, chart(s), Why list, Next steps |
| Mini line chart | 28-day series, dashed "usual" line, shaded last 3 days, treatment and event markers, hover tooltip |
| Glucose day chart | 24 h from 4 am, 140 mg/dL threshold line, meal markers |
| Comparison bars | Single hue, value at the end |
| Score breakdown | 4 parts with value, target, points/max and a bar |
| Transcript line | Time, speaker, text, tag chips, inline cue, flagged highlight |
| Recommendation row | Audience tag (For coach / For survivor) + text |
| Action bar | Primary and secondary actions; Escalate only when needed |
| Phone frame and survivor cards | Focus card with checkbox, why card, rest card, next-call card, language toggle |
| Empty-module card | Dashed, explains the missing patient key |
| State boxes | Skeleton, empty, error with retry |
| Toast | Confirms mock actions |

## 8. Design tokens (draft)

Defined at the top of `prototype/styles.css`. Light and dark are both designed.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f6f5` | `#0f1614` | Page ground |
| `--surface` / `--surface-2` | `#ffffff` / `#eaefed` | `#161f1c` / `#1d2925` | Cards / quiet fills |
| `--ink` / `--ink-2` / `--ink-3` | `#13201d` / `#4a5753` / `#6f7b77` | `#e8efec` / `#b3c0bb` / `#8a9893` | Text levels |
| `--line` | `#d5ddda` | `#2b3834` | Borders, grid |
| `--accent` | `#0b6b5d` | `#4cc2ad` | Primary action, focus, active nav |
| `--m-c3` / `--m-c4` / `--m-c5` | `#2a78d6` / `#eb6834` / `#6250d6` | `#3987e5` / `#d95926` / `#9085e9` | Module identity (chart lines, panel top border, chip dot) |
| `--ok` / `--watch` / `--alert` | `#0ca30c` / `#fab219` / `#d03b3b` | same | Status only, never for series |

Other tokens:
- Type:
  - Bricolage Grotesque (display, used sparingly)
  - Public Sans (body)
  - IBM Plex Mono (numbers and times)
- Radius: 10px for cards, 6px for pills.
- Spacing: 4 / 8 / 12 / 16 / 24.
- Gutter: 16px on phone.

The module hues are slots 1, 2 and 7 of a CVD-validated categorical order. Status colours are a separate reserved set.

## 9. Integration contract

What the prototype is designed against (mock JSON in `mock/api/` and `prototype/mock-data.js`, generated from the real synthetic files by `scripts/build_mocks.py`):

- `GET /api/<c3|c4|c5>/survivors` → `[{survivorId, displayName, status: "ok"|"watch"|"alert", headline, updatedAt}]`
- `GET /api/<c3|c4|c5>/survivors/:id` → `{survivorId, status, headline, summary, evidence: [...], recommendations: [...], charts: {...}}`

### Contract asks

These are additions. Nothing existing changes, and no module repo was edited.

1. **C5 survivor endpoints.** `coach-copilot` exposes only per-line endpoints (`/api/turn`, `/api/review`, `/api/cue`). It needs `GET /api/c5/survivors` and `/survivors/:id`, built on the program's calls.
2. **`GET /api/c5/calls` and `GET /api/c5/calls/:callId`** for the Calls list and Call review. Proposed shape (see `mock/api/c5/calls/*.json`):
   - Call metadata: `{callId, survivorId, coach: {id, name, role}, date, start, language, goalTopic, callNumber, week, durationMin}`
   - Scoring: `score`, and `scoreParts: {reflectionsPerQuestion, complexReflectionPct, openQuestionPct, miConsistent}`, each `{value, target, points, max}`
   - Flags and cues: `flags: [{line, kind: medical|distress|social, text, t}]` and `cues: [{line, kind, text}]`
   - Counts: `moveCounts`, `talkCounts`
   - Lines: `lines: [{n, t, speaker, text, move?, confidence?, reviewed?, talk?, flag?}]`
   - Labels: use the module's own vocabulary (12 coach moves, change/sustain/neutral, none/medical/distress/social).
3. **Typed `evidence` and `recommendations`.**
   - `evidence: [{kind, text}]` and `recommendations: [{audience: "coach"|"survivor", text, es?, ht?}]`
   - `audience` decides what the survivor app may show.
   - The translation fields let modules ship reviewed copy.
4. **`profile` object on the detail response** (age, sex, language, cancer, plus module-specific fields). The page header needs it.
5. **Typed `charts` per module.** The prototype uses:

   | Module | Fields |
   |---|---|
   | C3 | `{baseline: {steps, sleep_minutes, resting_heart_rate, daily_feeling_1_to_5}, days: [{date, steps, sleep, rhr, feeling, treatment, event}]}` |
   | C4 | `{day: {date, curve: [{t, g}], meals: [{t, type, food, carbs, walk}]}, compare: [{label, value, n}]}` |
   | C5 | `{latestCallId, score, scoreParts}` |

6. **Optional `caveat` string** (C4 uses "pattern, not proof").
7. **Optional `hindsight` (C3, demo only):** the synthetic events in the following days. It shows that the warning came first. Never show it in production.
8. **Namespaced IDs** in any cross-module call (`c3:P00809`), because C3 and C5 IDs collide in form.
9. **`status` vocabulary stays `ok|watch|alert`.** The console derives "Act today" from C5 `alert` plus flags. An alternative: C5 adds `actToday: true`.

## 10. Open questions for the designer

1. Should the survivor page show the three panels side by side (current, good for the demo) or stack one module at a time with tabs (calmer for daily use)?
2. How loud should "Act today" be? A sticky top banner on every page until handled, or only the roster group?
3. Mini charts: are 28 days enough context, and should treatment cycles show as bands instead of tick marks?
4. Call review is long (about 50 lines). Should it collapse neutral lines by default and show only tagged moments, cues and flags?
5. The survivor app tone is warm, plain and with no numbers beyond one comparison. Does the program want a streak or progress visual, or does that risk guilt on bad weeks?
6. Haitian Creole: who reviews the copy, and do we show English as a fallback or hide untranslated cards?
7. How should the C1 risk badge sit on the roster without competing with today's status? (Suggestion: a quiet probability chip, never red.)
8. Iconography: the prototype uses text glyphs as placeholders. It needs a real icon set.
9. Brand: the prototype uses no Sylvester or UM marks on purpose. Confirm co-branding rules for the demo.

## 11. Verification

`npm run e2e` runs `e2e/clickthrough.mjs`, a short-lived headless Chromium over `file://` with no server. It does three things:

1. **Screens.** It visits every route at 1280px and 390px, in light and dark. On five key screens it also forces the loading, empty and error states.
2. **Checks.** On each one it checks for the expected text, no horizontal scroll and no console errors, and it confirms the forced state rendered.
3. **Demo flow.** It clicks through the demo flow: Today → Act today row → Escalate → Review call → Jump to the flagged line → filter → Spanish survivor app.

Screenshots and `manifest.json` go to `runs/<timestamp>/`. To regenerate the mocks, run `npm run mocks`. To build the publishable single page, run `npm run artifact`.
