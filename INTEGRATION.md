# Integration: Patient 360 ↔ the challenge modules

Patient 360 (https://patient-360.raava.dev) reads every module through one Cloudflare Worker and maps every
response to the UI in one file, `public/adapters.js`. No module repo was edited.

| Module | Live path | State |
|---|---|---|
| C1 Hospital risk (`c1-acute-risk`) | `/api/c1/survivors[/:id]`, `/api/c1/metrics` | live, all 199 patients |
| C3 Rough weeks (`c3-rough-patch`) | `/api/c3/survivors[/:id]`, `/api/c3/metrics` | live (model-v2 fields `urgent`, `urgentRisk` wired) |
| C4 Glucose (`c4-glucose-guide`) | `/api/c4/survivors[/:id][/advice]`, `/api/c4/cohort` | live, uses its `tags[]` |
| C5 Coaching calls (`coach-copilot-clef`) | `/api/c5/turn|review|cue` live; `/api/c5/survivors|calls` | model live; lists via adapter until the Copilot serves them |

**Fallback.** Each fetch times out at 10 s. A failed module, or a missing required field, falls back to the
saved copy in `public/fallback-data.js` (`node scripts/snapshot.mjs`, 375 responses). The status chips at the top
right say live / saved copy / down per module, and a banner names the module that is down.

## Remaining asks, per module

**All modules**
- One shared patient ID. Today each module has its own synthetic cohort, so a patient fills one pill only.
- An `audience` field on every recommendation (`coach | care-team | patient`). C1 has it; the others need it.
- Spanish and Haitian Creole text for anything the patient sees.

**C1 Hospital risk**
- `tags[]` on roster rows (the console derives them from the headline today).
- Patient-facing text that never states the risk number (the console filters `audience: survivor` today).

**C3 Rough weeks**
- `tags[]` on roster and detail, like C4.
- `urgent` on roster rows (the console reads it from the "Urgent:" headline today).
- Patient-facing text and a `caveat` string.

**C4 Glucose**
- `language` in `profile`.
- The KPI strip as data (`kpis[]` with value, target, good/bad), so the console stops re-deriving it from evidence ids.
- When a series has no readings (for example `dailyProfile` weeks 11-12), send `values: []` or omit the series instead of 24 nulls.

**C5 Coaching calls**
- Serve `/api/c5/survivors[/:id]` and `/api/c5/calls[/:id]` from the Copilot. The Worker tries them first and switches over with no console change (`x-c5-source: native`).
- A call-history write endpoint, so calls started in Patient 360 (stored in Patient 360's KV today) live with the rest.
