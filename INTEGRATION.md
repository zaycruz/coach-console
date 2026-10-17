# Integration: Patient 360 ↔ the challenge modules

Patient 360 (https://patient-360.raava.dev) reads every module through one Cloudflare Worker and maps every
response to the UI in one file, `public/adapters.js`. No module repo was edited.

| Module | Live path | State |
|---|---|---|
| C1 Hospital risk (`c1-acute-risk`) | `/api/c1/survivors[/:id]`, `/api/c1/metrics` | live, all 199 patients |
| C3 Rough weeks (`c3-rough-patch`) | `/api/c3/survivors[/:id]`, `/api/c3/metrics` | live (model-v2 fields `urgent`, `urgentRisk` wired) |
| C4 Glucose (`c4-glucose-guide`) | `/api/c4/survivors[/:id][/advice]`, `/api/c4/cohort` | live, uses its `tags[]` |
| C5 Coaching calls (`coach-copilot-clef`) | `/api/c5/survivors|calls|demo|agreement`, `POST /api/c5/turn|review|cue` | live (native endpoints first, adapter fallback) |

**Fallback.** Each fetch times out at 10 s. A failed module, or a missing required field, falls back to the
saved copy in `public/fallback-data.js` (`node scripts/snapshot.mjs`, 375 responses). The status chips at the top
right say live / saved copy / down per module, and a banner names the module that is down.

How each number gets from a module to a screen, the tier rules, what is AI and what fails how: see
[`docs/how-it-works.md`](docs/how-it-works.md). That doc is the current reference; this file only keeps the module table.

## Open asks (checked against the live APIs on 2026-10-17)

- One shared patient ID. Each program still has its own cohort, so the linked demo records join them by matching sex, cancer type and age.
- C3: `tags[]` on roster rows. C1 and C4 send them; P360 derives C3's from the headline.
- C5's lists come through the Worker's adapter when the Copilot's native endpoints don't answer. Calls started in Patient 360 are stored in Patient 360's KV.

Done since the first version of this file: C1 `tags[]`, C3 `urgent` on roster rows, C4 `careTeamFlag.urgency`, and C5 `Retry-After: 20` on 429.
