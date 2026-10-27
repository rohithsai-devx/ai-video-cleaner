---
name: project-learnings
description: "Repo-specific gotchas log for ai-video-cleaner — read before any code change here; append when you hit a non-obvious failure. The coding-powers loop counts edits here as captures."
---

# ai-video-cleaner — project learnings

The coding-powers self-improving loop's **local** memory. This is where *this* repo's gotchas live — the things you'd only know by breaking this codebase once. Global patterns belong elsewhere; ai-video-cleaner's surprises belong here.

## When to read
Before any code change in this repo — scan the entries below for the area you're touching. The coding-powers SessionStart hook reminds you this file exists; it does not read it for you.

## When to append
When you hit a non-obvious failure (bad data shape, 404-with-auth, migration collision, port conflict, a library that only works one way) and resolve it. One entry per gotcha. **Append only** — never rewrite history; corrections go in a new dated entry.

## Entry format
```
### <short title — the symptom>
- **Symptom:** what you observed
- **Root cause:** why it happened (the non-obvious bit)
- **Fix:** what resolved it
- **Takeaway:** the one-line rule to never repeat it
```

## Entries

<!-- append new gotchas below this line. First one is yours. -->
### A cancel during a pipeline stage waits; it never races the stage (2026-10-18)
- **Symptom:** a test that cancels a run from inside a stage's engine hangs.
- **Root cause:** `lifecycle.load` takes `FOR UPDATE`, so the cancel blocks on the row lock that the stage holds until it commits. The stage's own compare-and-set therefore cannot lose; `Lost` in `stages.handle` is defensive only.
- **Fix:** test cancellation before the stage runs (the stage then sees a non-matching status), not during it.
- **Takeaway:** don't try to provoke `Lost` from inside a locked stage; it deadlocks.

### `approved → failed` is not a legal transition (2026-10-18)
- **Symptom:** a render failure cannot mark the run failed straight away.
- **Root cause:** `run_transitions` allows `failed` from queued, preprocessing, agent_running and postprocessing, but not from approved, and the stage's rollback returns the run to `approved`.
- **Fix:** `stages._fail` goes `approved → postprocessing → failed`.
- **Takeaway:** a failure path must follow `run_transitions`, not just jump to `failed`.

### CI runs `ruff format --check` (2026-10-18)
- **Symptom:** `ruff check` passes locally but CI fails.
- **Root cause:** the CI workflow also checks formatting.
- **Fix:** run `uv run ruff format .` before you finish.
- **Takeaway:** local "done" means ruff check, ruff format --check, pyright, pytest and check_db.

### Playwright's default headless shell cannot run getDisplayMedia (2026-10-18)
- **Symptom:** the recorder e2e hangs on "Waiting for Chrome…"; `getDisplayMedia` never resolves, even with `--use-fake-ui-for-media-stream`.
- **Root cause:** Playwright's default headless Chromium is `chromium-headless-shell`, which has no screen-capture picker.
- **Fix:** in the spec, `test.use({ channel: "chromium", launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] } })` (full Chromium, new headless mode). See `frontend/e2e/record.spec.ts`.
- **Takeaway:** any capture test needs `channel: "chromium"`, not the default headless shell.

### The proxy refuses page.request writes without an Origin header (2026-10-18)
- **Symptom:** e2e setup calls such as `page.request.post("/api/videos")` get 403.
- **Root cause:** the same-origin proxy rejects state-changing requests whose `Origin` is missing or foreign (CSRF guard). Browsers add `Origin`; Playwright's `page.request` does not.
- **Fix:** send `headers: { origin: "http://localhost:3000" }` (see `frontend/e2e/helpers.ts`).
- **Takeaway:** API calls from tests that skip the browser must set `Origin` explicitly.

### Backend tests flake while the dev API runs (2026-10-18)
- **Symptom:** 1-2 tests fail intermittently at `tests/factories.py` (`rowcount == 1` in `_run_awaiting_review`), and pass when rerun.
- **Root cause:** pytest and a local `uvicorn` with `FAKE_WORKER=true` share the `avc` database. The dev server's in-process worker picks up runs the tests enqueue and advances them, racing the factory's compare-and-set.
- **Fix:** stop the dev API before `uv run pytest` (90/90 stable with it stopped). CI is unaffected because it runs no dev server.
- **Takeaway:** never run the backend suite next to a live `FAKE_WORKER` API on the same database.

### Fixture worker proposal exceeds its reported duration (2026-10-27)
- **Symptom:** the full API e2e flow reached review but approval returned 422 for proposal spans after 12 seconds.
- **Root cause:** `FixtureEngines.preprocess` reported a 12-second video while its canned proposal uses the 60-second demo timeline.
- **Fix:** keep the fixture preprocess duration at 60 seconds and align the pipeline test expectation.
- **Takeaway:** fixture media duration must cover the proposal's source timeline.

### Deleted backend packages can leave layout-breaking bytecode (2026-10-27)
- **Symptom:** `check_layout.py` reports a removed domain as an unallowed package after its source files are deleted.
- **Root cause:** Python leaves an `__pycache__` directory under the deleted package, and the layout check still sees the directory.
- **Fix:** remove stale package bytecode directories when deleting the package.
- **Takeaway:** rerun the layout check after package deletion and clean generated cache directories before diagnosing a source layout issue.

### Psycopg returns numeric durations as Decimal (2026-10-27)
- **Symptom:** multiplying a video duration by a floating-point median raises a Decimal/float `TypeError`.
- **Root cause:** psycopg decodes PostgreSQL `numeric` columns as `Decimal`, while elapsed-time ratios are floats.
- **Fix:** convert database durations to `float` before combining them with floating-point rates.
- **Takeaway:** normalize numeric database values before mixing them with computed floats.
