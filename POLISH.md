# Patient 360 polish: token sheet and punch list

The bar (coordinator, quoting zay): "polished like a HealthTech company: Apple-level craft, Whoop-level information."
Every surface a judge sees shares this sheet: Patient 360 and the four module pages (c1, c3, c4 workers.dev, coach.raava.dev).

## Token sheet

### Type
The font stack is `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif`.
- Numbers use `font-variant-numeric: tabular-nums`.
- Mono is used only for IDs and raw fields.

| Token | px / line | Weight | Use |
|---|---|---|---|
| `--t-hero` | 48 / 52 | 700 | The view's one hero number |
| `--t-h1` | 28 / 34 | 700 | Page title, patient name |
| `--t-h2` | 20 / 26 | 600 | Section title |
| `--t-h3` | 17 / 24 | 600 | Card title |
| `--t-body` | 15 / 22 | 400 | Body |
| `--t-small` | 13 / 18 | 400/500 | Meta, "what it means" |
| `--t-micro` | 12 / 16 | 600, caps +0.04em | Eyebrows, chips |

### Space (4/8 grid)
`--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 · `--s-8` 64.
- Page gutter: 40 px desktop, 16 px phone.
- Card padding: 24 px desktop, 16 px phone.
- Gap between sections: 48 px. Gap between cards: 16 px.

### Shape and depth
- Radius: `--r-sm` 8 (buttons, inputs, chips use 999), `--r-md` 12 (cards), `--r-lg` 16 (hero card).
- Shadow: `--sh-1: 0 1px 2px rgb(15 23 42 / .06), 0 0 0 1px rgb(15 23 42 / .06)`, and `--sh-2` on hover/raised.
- Borders: 1 px hairline `--line`. There are no dashed borders except the data-provenance chip.

### Colour
The palette is restrained. Neutrals carry the page; one accent is used for actions; status colours carry meaning.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F5F6F8 | #0B0D12 | Page field |
| `--surface` | #FFFFFF | #151821 | Cards |
| `--surface-2` | #F0F2F5 | #1C2030 | Wells, table heads |
| `--ink` | #0E1420 | #ECEEF3 | Primary text |
| `--ink-2` | #4A5568 | #A9B1C1 | Secondary |
| `--ink-3` | #6B7486 | #7D8698 | Tertiary (≥4.5:1 on surface) |
| `--line` | #E3E6EB | #262B38 | Hairlines |
| `--accent` | #0A5CC2 | #5B9BFF | The one accent: buttons, links, focus |

**Status** has one meaning everywhere and is always shown with a glyph and a word, never colour alone:

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--red` | #C62828 | #FF6B6B | Act today |
| `--red-soft` | #FDECEC | — | Act today, background |
| `--amber` | #B26A00 | #F0B44C | Watch this week |
| `--amber-soft` | #FFF4E0 | — | Watch, background |
| `--green` | #1E7F4A | #4CC38A | On track |
| `--green-soft` | #E7F5EC | — | On track, background |

- Glyphs: ● Act today · ▲ Watch · ✓ On track.
- Program identity is a small dot only, never a fill: C1 teal #00968F, C3 blue #1F6FD1, C4 orange #D4642A, C5 violet #7B5BD6.

### Motion
- `--ease: cubic-bezier(.2,.8,.2,1)`.
- Durations: `--d-1` 150 ms (hover, press), `--d-2` 200 ms (expand, tab), `--d-3` 250 ms (page fade/rise 4 px).
- `prefers-reduced-motion` turns all of it off.

### Focus and accessibility
- Every interactive element gets a 2 px `--accent` ring at 2 px offset, `:focus-visible` only.
- Text contrast is ≥4.5:1; large numbers ≥3:1.
- Hit targets are ≥40 px.
- Every chart has a text equivalent: its "what it means" line plus the table under "Evidence".

### Information pattern (Whoop-style), for every number
1. **Hero:** one number or state per view, with a status word and glyph.
2. **What it means:** one plain line, saying what the number is compared with.
3. **What to do:** one action line.
4. **Trend:** a sparkline where a series exists (the last 7–14 points against the personal baseline band).
5. **Depth:** only on tap or expand. This covers charts, evidence and CIs, and raw fields.
6. **Source:** every number says where it comes from: held-out, cross-validated, synthetic, or real (MEPS).

### Copy voice
Short, warm and clinical.
- Write "Call today", not "Actionable alert".
- Give every term a one-line gloss on first use, for example "Time in range (70–180 mg/dL, the target band)".
- The UI never shows raw JSON, stack traces, `undefined`, `NaN` or `null`. A missing value is shown as "Not recorded".

## Punch list (every screen)

### Patient 360
| # | Screen | Now | To do |
|---|---|---|---|
| 1 | Shell: rail, topbar, phone tab bar | Square, Plex, dashed pill, mono source chips | Apply tokens. Make the topbar quiet: one "Real (MEPS) + synthetic" chip, and source status as one dot plus "All 4 programs live" (detail on hover/expand). Fix the phone tab bar covering content and the AI assistant button overlapping cards (bottom padding). |
| 2 | Today | Stat strip plus a long list of near-identical rows | Hero "8 to call today" with what it means. Rows: status glyph, name, a one-line reason with the number bolded, chips reduced to program dot plus language/interpreter, one primary action. "This week" collapsed after 5. |
| 3 | Today loading / empty / error | Present | Skeleton rows, a calm empty state ("No one needs a call today ✓"), and an error state with a retry. |
| 4 | Patients | Dense table | Status glyph column, name, program dot, reason, last data. Search and filters in one row. Phone: card rows. |
| 5 | Patient header | Facts wall of 7 key/values | Name, then a one-line identity (age, sex, cancer, language), status pill, and actions. The other facts go into an expandable "Profile". |
| 6 | Health chart (overview) | Headline, chips, AI Insight, KPI strip, Do next | **Hero card:** one number (the program's key risk), status word, what it means, what to do, and a sparkline. Then AI Insight (unchanged UI), then up to 3 KPI tiles each with a meaning line and sparkline, then Do next. |
| 7 | Linked demo record health chart | New | One hero per program, as a 4-up "rings" summary (C1 12-month risk, C3 7-day risk, C4 time in range, C5 last call score). Each has status, a meaning line and a link to its tab. Labelled "Linked demo record". |
| 8 | C1 Hospital risk tab | Red-flag panel, bars, fairness | Hero risk % vs average, with the tier word and the caveat under the number. The red-flag panel stays first. Depth collapsed. |
| 9 | C3 Rough weeks tab | KPI tiles, charts | Hero 7-day risk vs alert line. Sleep, steps and RHR sparklines against the personal baseline band. |
| 10 | C4 Glucose tab | Long cards with paragraphs | Hero time in range with a target band ring. Paragraphs cut to meaning + action. Program-wide stats go under "For scientists". |
| 11 | C5 Coaching calls tab | Call list | Hero last call score with flagged lines, then the call list. Add a link to supervisor agreement. |
| 12 | Calls list and call detail | Rows | Token pass. In call detail, flagged lines are red with a glyph. Add the supervisor-agreement section (C5 agreement endpoint). |
| 13 | Live call and recap | Works | Token pass only. Check that the language script is readable. |
| 14 | Hospital risk (care) | Rosters, trust details | Hero "n at high 12-month risk (held-out)" plus the roster. Trust stays collapsed. |
| 15 | Care-team inbox | List | Token pass and the empty state. |
| 16 | Research | Placeholder | A clean "Coming later" empty state. |
| 17 | AI assistant | Fine as is (zay) | **Do not change its layout.** It only inherits colour and type tokens. |
| 18 | Global states | Mixed | Skeleton component, error box with retry, the rate-limit message ("Busy for a moment, try again in a minute") and an unknown-patient page. No raw errors anywhere. |
| 19 | Dark mode | Light only | Tokens under `prefers-color-scheme: dark`. Charts read their colours from tokens. |

### Module pages (same company, same tokens)
| # | Page | To do |
|---|---|---|
| 20 | c1-acute-risk workers.dev | A clean API landing page in the shared design: what it does, the headline result with CI and source, the endpoints, and "Open in Patient 360 →". |
| 21 | c3-rough-patch workers.dev | Same. |
| 22 | c4-glucose-guide workers.dev | Same. |
| 23 | coach.raava.dev (C5 Clef) | Same, or a token pass if its live demo must stay. |

### Proof
- Screenshot every screen at 1440 and 390 px into `runs/polish-<stamp>/`.
- Self-review each against this sheet before reporting.
- Run the E2E after each deploy.
