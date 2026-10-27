# FE-2: processing screen (4.2)

Screen: `ux-post-upload.md` 4.2, prototype artboard **2 · Processing** (its `phase` prop shows running, ready and failed). Route `/runs/[id]`. Contracts C4, C6, C7 (counts), C8. Backend: BE-D (retry, failure), BE-E (progress, banner counts), BE-B (estimate).

Files you own: `features/runs/**`, `src/api/events.ts` and its test (the `run.progress` event), `e2e/progress.spec.ts`.

## Wireframe (1440 wide; `main` max-width 1120, px-6 py-10, flex-wrap gap-8)

```
+---------------------------------------------------------------------------------------+
| Stepwise / Setting up a new project / Cleaning                                        |
+---------------------------------------------------------------------------------------+
|  CARD (flex 999 1 520px; surface, rounded-3xl, p-8, gap-7)  |  ASIDE (flex 1 1 320px)  |
|                                                              |                          |
|  Cleaning your video  (h1 32)       [My voice · I review first] |  Found so far (h2 15) |
|  Step 3 of 4 · about 1 minute left  (15 muted)               |  +--------+ +--------+   |
|                                                              |  | 6      | | 3      |   |
|  (✓) Listening to your narration                             |  | long   | | filler |   |
|   |   Found what you said and when you said it.              |  | pauses | | words  |   |
|  (✓) Watching your screen                                    |  +--------+ +--------+   |
|   |   Found 4 chapters: sign in, create the project, ...     |  | 3      | | 2      |   |
|  (●) Planning the cuts                                       |  | retakes| | slow   |   |
|   |   Working on it, about 1 minute left.                    |  |        | | loads  |   |
|  ( ) Getting it ready for you                                |  +--------+ +--------+   |
|       Next                                                   |  +--------------------+  |
|                                                              |  | Chapters it sees   |  |
|  [ Stop cleaning ]  You can close this tab. We'll keep going |  | 0:00 Sign in       |  |
|                     and the library shows progress.          |  | 0:31 Create the... |  |
|                                                              |  +--------------------+  |
+---------------------------------------------------------------------------------------+
READY: h1 "Ready for you", sub "Nothing renders until you approve.", all four steps done, then
  Banner info: "18 changes ready. 15 are applied already. 3 need your call."   [Open the editor]
FAILED: h1 "Cleaning stopped", sub "Step 3 of 4 didn't finish.", the failed step has the red dot and
  detail "This step stopped. Nothing you did caused it.", then
  Banner danger: "<error.message> Your recording is safe."                     [Try again]
Phone (390): card first, aside under it; count tiles stay 2 columns.
```

Count tiles: surface, border line, rounded-2xl, p-4; number in `font-display` 32 px bold; label 13 px muted. Chapter rows: `font-mono` time in a 40 px column, then the title.

## Status to step mapping (`buildSteps` returns four steps)

| `run.status` | 1 Listening | 2 Watching | 3 Planning | 4 Getting ready | Header (h1 / sub) |
|---|---|---|---|---|---|
| `queued`, `preprocessing` | current | current | next | next | "Cleaning your video" / "Step 1 of 4" |
| `agent_running` | done | done | current | next | "Cleaning your video" / "Step 3 of 4" |
| `awaiting_review` | done | done | done | done | "Ready for you" / "Nothing renders until you approve." + ready banner |
| `approved`, `postprocessing` | done | done | done | current | "Cleaning your video" / "Step 4 of 4" ("Rendering your video." as step 4 detail) |
| `done` | done | done | done | done | navigate to `/videos/{video_id}` (the done screen) |
| `failed` | step `Number(error.stage)` failed, earlier done, later next | | | | "Cleaning stopped" / "Step {n} of 4 didn't finish." + failure banner |
| `cancelled` | as at the last known status, no current | | | | "Cleaning stopped" / "You stopped this run. The recording is safe." + link "Clean again" to `/videos/{video_id}` |

Step 1 and 2 run in one backend stage, so both show current together. Done details: step 1 "Found what you said and when you said it."; step 2 "Found {n} chapters: {titles, lower case, comma separated}." when chapters are known, else "Found the parts of your screen recording."; step 3 "Chose what to remove, speed up or keep."; step 4 "Lined every change up on the timeline." Current details: step 3 "Choosing what to remove, speed up or keep."; others "Working on it." Next: "Next".

The pill shows the run's choices in plain words: "{My voice | AI voice} · {I review first | Renders straight away}".

## Steps (one PR each; merge when "needs" is on main)

| Step | What | Needs |
|---|---|---|
| 2a | **Four steps and copy.** New `buildSteps` with the table above (pure, tested per status), `Stepper` from FE-0, header and pill, "Stop cleaning" with the existing `ConfirmDialog` and cancel mutation (confirm copy: "Stop cleaning?" / "The recording stays as it is." / buttons "Stop cleaning", "Keep going"), footer note. Remove the activity log, the "Live" pill, `logLine`, "Retry is coming soon", and the old mode label; the `useRunEvents` `log` state goes too. The live region is the sub line (`aria-live="polite"`), and the h1 has none. Ready banner without counts: "Ready for you." and **Open the editor**. On `done`, `router.replace("/videos/{video_id}")`. | FE-0 |
| 2b | **Failure and retry.** Failure banner with `error.message`; **Try again** only when `error.retryable`; it calls `POST /runs/{id}/retry`, then invalidates the run query (SSE reopens since the run is live again). 409 responses show "This run can't be retried. Start a new one from the video page." with a link. | BE-D (D3, D4) |
| 2c | **Found so far.** `api/events.ts` parses `run.progress` (C8) into the typed event union; `useRunEvents` keeps the latest progress in state (not in the run cache). `features/runs/found-so-far.tsx`: four tiles, a tile shows "–" while its value is null; chapters list when non-empty. Hidden entirely until the first progress event, and after a reload until the next one. Once `awaiting_review`, the tiles are computed from `ProposalView.changes` instead (fetch the proposal), so they stay correct after a reload. Step 2's done detail uses the chapters. | BE-E (E1, E2, E6) |
| 2d | **Banner counts.** "{changes.length + spots.length} changes ready. {changes.length} are applied already. {open spots} need your call." When there are no spots: "{n} changes ready. All are applied already." | BE-E (E2, E3) |
| 2e | **Time left.** Fetch the video (`GET /videos/{video_id}`) for `estimated_run_seconds`. While running and `run.started_at` is set: remaining = max(0, estimate - (now - started_at)), shown in the sub line as "· about {n} minutes left" (round up; "about 1 minute left"; "almost done" under 30 s) and in the current step's detail. Tick every 15 s; the live region announces only when the step changes, not the countdown (keep the countdown text outside the live region). | BE-B B4 |

## Render and check

README section 5. Fixtures: runs in each status, a failed run with each `error.stage` and both `retryable` values, a progress event sequence matching the demo (6, 3, 3, 2; four chapters from `ux-post-upload.md` section 5).

- Unit: `run-progress.test.ts` (every status row; failed per stage; the pill text), `found-so-far.test.tsx`, `events.test.ts` for `run.progress`.
- `e2e/progress.spec.ts`: four steps, no log; ready banner links to the editor; failed run shows Try again only when retryable and calls retry; done navigates to the video page. Screenshots at 1440 and 390 for running, ready and failed.
- Manual: no internal word appears anywhere (`grep` the rendered text for `pre-cpu`, `agent`, `post-io`, check names).
