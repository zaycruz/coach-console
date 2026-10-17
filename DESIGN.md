# Patient 360: design

Live: https://patient-360.raava.dev. This is a care-team console for the eMerge Healthcare track (Sylvester). It puts every challenge module behind one patient record. The repository directory is still `coach-console`.

## 1. Who it is for

| User | What they come for | Where |
|---|---|---|
| Health coach | Who needs a person today, preparing for calls, running a call | Today, Patients, Patient 360, Call |
| Care-team lead | Who is likely to need the ER or hospital (C1) | Hospital risk |
| Patient | One clear thing to do, in plain words | Patient's app (phone preview) |
| Lab scientist | Drug discovery (C6/C7), kept separate | Research (stub) |

The word is **patient** everywhere in the UI. The module APIs still say `survivor`, and only the adapter sees that word.

## 2. Information design: low load, no lost data

This follows the glucose team's page. Each screen answers one question first, and every number can be opened down to its source.

1. **Headline.** One plain sentence. Tags follow it, and the tags are the module's own vocabulary.
2. **KPI cards with their targets.** The top rule is green when on target and red when off. A card on the health chart opens that program's view.
3. **What to do.** Numbered cards, with the advice on the left and the chart behind it on the right. On a phone the chart stacks below.
4. **More detail.** Panels that carry no advice, folded away.
5. **Evidence.** Every measure, with its CI and n.
6. **Everything this program sent.** The full response as key/value rows. The summary may shorten things, but this layer always holds the data.

A chart series with no readings is named under the chart ("No readings yet for weeks 11-12"). It never shows as a legend entry with no line.

## 3. Screens and routes

Hash routes are plain tokens, so links work inside the claude.ai Artifact as well.

| Route | Screen |
|---|---|
| `#today` | Who needs a person today: four counts, then at most 8 rows. Each row has one reason and one action: Start call (or Review risk for C1) and Open. |
| `#patients[-today\|alert\|watch\|ok]` | Every patient (335 across C1/C3/C4/C5) with search, program and status filters, and tags. Shows 60 at a time. |
| `#p-<id>` | Patient 360 health chart. The pills are tabs: Health chart, Hospital risk, Rough weeks, Glucose, Coaching calls. |
| `#p-<id>.<c1\|c3\|c4\|c5>` | One program's view of the patient. A program the patient isn't in shows "Not enrolled" and why. |
| `#live-<id>` | Start a call with this patient. See section 4. |
| `#calls`, `#call-<id>` | Supervisor-labelled calls. "Run live Copilot" re-tags every line and scores agreement. |
| `#care` | C1 list, highest risk first. Tier outcome rates, AUROC with CI, factors, fairness by group, caveats and the full model card. |
| `#app[-<id>]` | What the patient sees: no scores and no risk labels. |
| `#research` | Stub. |
| `~loading`, `~empty`, `~error` suffixes | Force a state, for review. |

**Triage.** A patient needs a person **today** when C5 flags a concern, or when C3 sets `urgent` or writes an "Urgent:" headline. Otherwise the order is alert, then watch, then ok, each set by the module's own status.

## 4. Calls: pick up where the last one stopped

**Recap, above the call.** It shows the most recent call on record. That is either a call saved in Patient 360 (KV) or, for a coaching-program patient, the last labelled call. The recap gives:

- The facts from the record: date, coach, goal, score, and the lines that needed a person.
- An AI hand-off note (GLM): a summary, where to pick up, and what is still open. It is labelled "AI · check before acting".

A patient with no call history gets "No previous call on record" and the program's own headline and actions to cover.

**The call.** It works the same way as the Copilot (coach.raava.dev):

- **Input.** Use the mic (browser speech recognition, Space switches speaker, English, Spanish or Haitian Creole via French), or type each line.
- **Tagging.** Each line goes to Clef (`/api/c5/turn`). A line below 0.3 confidence goes to a GLM review.
- **Alerts.** A concern raises a banner.
- **Cues.** Cues use the Copilot's trigger rules with a gap of 3 coach lines.
- **Score.** The live coach score uses MITI-style targets.

"End and save call" stores the call, and it becomes the next recap.

## 5. Ellie

Ellie is a chat panel that is available on every screen. She can:

- **Open pages.** Commands like "open glucose for N0072" or "start a call with Yolanda" are parsed in the browser and open at once.
- **Find and explain a patient.** The browser matches names and IDs against the roster. It sends only those patients, plus the patient on screen, to `/api/ellie`.
- **Answer general medical questions.** These answers are labelled AI.

The Worker accepts a page from the model only if it fits a known route and uses an ID it sent. It drops cited IDs it did not send. The model is the same GLM the Copilot uses (`@cf/zai-org/glm-5.3-flash`), and a warm answer takes 4–6 s.

## 6. Look

- **Feel.** A clinical institute: a deep navy rail, white work surfaces on cool grey, one clinical blue (`#0b5cad`) for actions and links, and IBM Plex Sans/Mono.
- **Corners.** Square corners everywhere.
- **Light only.** `color-scheme: light`, so a dark OS doesn't flip the page.
- **Program hues.** C1 teal `#00968f`, C3 blue `#1f6fd1`, C4 orange `#d4642a`, C5 violet `#7b5bd6`. They pass the dataviz palette check on white: CVD separation ≥ 16 ΔE, normal vision ≥ 23.
- **Status.** Status colours are reserved, and each status always carries a glyph and a word.

## 7. Architecture

```
browser ──> patient-360 Worker ──┬─ C1 c1-acute-risk      (service binding, GET)
  adapters.js (one mapping layer) ├─ C3 c3-rough-patch      (service binding, GET)
  fallback-data.js (saved copy)   ├─ C4 c4-glucose-guide    (service binding, GET)
                                  ├─ C5 coach-copilot-clef  (GET lists via adapter; POST turn/review/cue)
                                  ├─ Workers AI (GLM): /api/ellie, /api/recap
                                  └─ KV CALLS: /api/calls/:patientId
```

- **One mapping layer.** All module knowledge lives in `public/adapters.js`. `app.js`, `call.js` and `ellie.js` only render the UI shape.
- **Fallback.** A module that is down or missing a field falls back to the saved copy (`scripts/snapshot.mjs`) and is marked as such.
- **The Artifact.** It runs on the saved copy alone (`SNAPSHOT_ONLY`). Ellie and live calls there link out to the live site.

Remaining asks per module: see `INTEGRATION.md`.
