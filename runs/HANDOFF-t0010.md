# Patient 360: handoff from t-0003 to t-0010 (UI/UX owner)

Written 2026-10-17 by t-0003. From now on t-0010 owns every visual and UX change. t-0003 stays on app logic, API glue
and the E2E; ask through the coordinator.

Repo: `~/projects/emerge-hackathon/coach-console` (origin github.com/zaycruz/coach-console). Worker: `patient-360`.
Live: https://patient-360.raava.dev.

## Rules that still hold

- Nothing visible is promoted without the coordinator's and zay's OK. The order is: preview, then the coordinator's screenshot QA, then the simulated-user re-run, then zay, then promote.
- No commits or deploys inside a judges-panel evidence window. t-0008 announces them.
- Do not push to or reset `main`. Local `main` (bfd9e31) is 1 ahead of `origin/main` (e0dbe8d) with the abandoned redesign, so leave it alone.
- Light mode only. Dark mode must never switch on by itself. The E2E checks this: "stays light when the OS is dark".
- Clinician side only, no patient-facing view.
- Keep "Patient 360", "AI Insight" and the copilot name "Clef".
- The AI assistant's UI and layout are zay's ("fine as is"). Do not change them. Never call it "Ellie": zay removed that name (Preview 1b).
- Worktrees go only under `/Volumes/RTL-Worktrees`. Leave nothing running on this Mac.

## Branches

| Branch | Head | What it is |
|---|---|---|
| Production | Worker version `7d349016` | zay's P0 revert to the pre-redesign look (17:21). This is the "classic" look: navy rail, IBM Plex, square corners. |
| `p360-classic` | 5ff88a2 | The classic look plus the logic since then. Act today is red flags only, glucose leads This week, one Act today list for Today, Patients and the AI assistant. Start call is the primary button, and each red-flag row has its own detail. Diverges from `origin/main` at a7c85eb. |
| `p360-v2p1` | pushed to origin | **PREVIEW 1** (content, logic, dedupe, bugs; the look is unchanged). Built on `p360-classic`. Start here. |
| `p360-org-wip` | 93f48e2 | One WIP commit holding Preview 2 organisation work, built on `p360-classic`: Today top-5 with "Mark called", the Patients toolbar, the status-word fold, and early versions of the test namespace and voice fixes (superseded by v2p1). Use it for ideas and rebase onto v2p1. Don't merge it as is. |
| `p360-redesign` / local `main` | bfd9e31 | The rejected redesign: Health chart synthesis rows. Kept for reference only. |
| `p360-polish-shell`, `p360-polish-patient`, `p360-c5-agreement` | already inside `origin/main` | Earlier polish passes. **polish-shell adds dark mode; that is now forbidden.** |

## What Preview 1 changed (p360-v2p1)

- **One tier function.**
  - `actToday()` (adapters.js) caches the /api/today "today" ids for 60 s.
  - `oneTier(row, ids)` sets `tri` in `roster()` and `patient()`.
  - The hero status is reconciled to the same tier, so Today, Patients, the header pill and the AI assistant agree.
- **Overview dedupe.**
  - A tile holds the number, the status, one comparison line, at most one short reason (`hero.reason`) and "Open →". The whole tile is the link.
  - Every action appears once, in Do next (`firstStep`/`doNext` in app.js).
  - AI Insight shows its headline only. The cache key is `insight2:`; the client key is `assistant-insight2:`.
  - "More numbers" and the linked footer are gone. The disclaimer appears once, in the header.
  - Tabs no longer repeat the hero value in their KPIs or "What to do".
- **C4 tile.** When the care-team flag fires, the tile leads with the metric that triggered it: value, evidence label, and target from the API reason. Time in range sits in the reason line, from the same weeks.
- **C1.** Labels say "Next-year ER or hospital risk (from 2017 survey)". The driver name is the API's own ("driven by …").
- **C3.** Fever and fluids are nurse scope: "Hand off to the nurse today: …" (`nurseScope`).
- **C5 flag age.**
  - Same day only while the flag is under 30 days old.
  - Older flags read "Close the loop: confirm it was handed off".
  - Today reasons carry the age ("call 3, 12 days ago" / "replayed today").
- **Voice.** `careVoice` turns patient second person into clinician voice for C1 recommendations and C4 advice.
- **Bugs.**
  - The chips refresh on the `p360:health` event, and every program’s health is fetched at boot.
  - the AI assistant button lane is reserved on desktop (`#view` right padding).
  - The nav is sticky at the top at 390.
  - Today reasons wrap instead of being cut with "…".

## Known bugs and loose ends

- AI Insight is still purple; Preview 2 makes it slate. The chips are still four boxes; Preview 2 collapses them to "● 4 programs live".
- The C4 step tagged "This week" now says "Send these readings to the care team this week and ask about symptoms on the next call." If zay wants glucose lows same-day, the tier rule in `src/today.ts` changes, not just the copy.
- In full-page screenshots at 390, the fixed "AI assistant" button is painted mid-page. In a real phone viewport it sits at the bottom, over the 88 px bottom padding. Judge it on a viewport shot, not a full-page one.
- `scripts/before-after.mjs` waits 2.5 s per route, so AI Insight often shows its loading skeleton in shots.
- Production `/api/today` (7d349016) still puts C4 glucose rows in Call today (22 rows). Preview 1 fixes this: Call today 12, This week 19.
- Node `fetch` on this Mac times out intermittently (IPv6/happy-eyeballs). Run Node with `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000"`.

## E2E

- `e2e/live.mjs`: one file, 102 checks, against a deployed URL with real module data. `ok(name, pass, detail)` records a check.
- Each run writes `runs/<ts>/manifest.json` (committed) plus PNGs (gitignored).
- It exits 1 if any check fails.
- Run it:
  ```bash
  NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000" \
    node e2e/live.mjs https://<version>-patient-360.zay-259.workers.dev
  ```
- Order of the run:
  1. List endpoints.
  2. `ROUTES` shots at 1280 and 390, including the error, empty and loading states.
  3. Light mode, corners, counts and chips.
  4. Today and Patients.
  5. A live call saved and recapped.
  6. The AI assistant.
  7. Per-patient overview asserts:
     - each tile number appears once;
     - no "your " in our copy (quotes, hand-outs and transcripts are excluded).
  8. Play as live and Clef.
  9. A clean context, without the test cookie, checks #calls has no test rows.
  10. The mic, through Whisper.
- Before/after shots: `ROUTES=today,patients,p-x-L1 node scripts/before-after.mjs <outDir> before=<url> after=<url>` (1440 and 390).
- The review routes are Today, Patients, p-x-L1, p-c3-P03000, p-c4-N0072, p-c1-S71188550, p-c5-P0002 and Calls.
- Selectors the E2E depends on (keep them, or tell t-0003 to change the test):
  - `.l-tile` / `.hero-num` / `.hv`;
  - `.assistant-insight[data-state]`;
  - `a.fpill[href="#patients-today"]`;
  - `.t-row .why`;
  - `#assistant-q`, `#assistant-msgs`, `#assistant-close`;
  - `.c-row`.

## Preview and deploy

```bash
npx wrangler versions upload --message "<what>"   # preview: https://<first 8 of id>-patient-360.zay-259.workers.dev, no traffic
npx wrangler versions list --json                 # find the id; retry on "fetch failed"
npx wrangler versions deploy <id>@100% -y         # PROMOTE: only with the coordinator's and zay's OK, outside evidence windows
```

Previews share the production KV (`CALLS`, id 70bb5c8877564ce6b5c5a53e1e693c2f), so anything a test writes must use the
test namespace.

## Test namespace

- **Marking a request as a test.** Send the cookie `p360test=1` or the header `x-p360-test: 1`. The Worker (`isTestReq`/`ns` in `src/index.ts`) then:
  - reads and writes `test:`-prefixed KV keys (`test:calls:<pid>`, `test:calls:index`, `test:handoffs`);
  - stamps `test: true` on every record it writes.
- **Normal requests.** `realOnly` drops anything with `test`, plus legacy E2E calls matched by their fixed lines: 3 lines, "How have the last few days been for you?" / "Honestly tired, but I want to get back to walking.".
- **The client.** `adapters.js` and `call.js` also hide `x.test` records unless the cookie is set, so a test session sees its own writes.
- **Purge.** On 2026-10-17 zay approved deleting the test-marked rows only. 24 E2E calls across 4 keys were deleted (manifest: `runs/purge-20261017T175832Z.md`). The one ambiguous call, on `calls:c5-P0002` ("Marisol…"), was kept.
- **Other keys.** `insight:*` / `insight2:*` are the AI Insight cache.

## Preview 1 state at handoff

- Preview: https://26e33648-patient-360.zay-259.workers.dev (Worker version 26e33648-44bb-4bd4-9906-f3d2d24ddc80). Not deployed.
- E2E: 102 passed, 0 failed (`runs/2026-10-17T18-19-55/manifest.json`).
- Shots (prod before vs preview after, 1440 and 390): `runs/v2p1-20261017T182247Z/`.
- Awaiting the coordinator's review. Nothing is promoted.
