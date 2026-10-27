# BE-D: run recovery (retry, stale tasks, safe failure text)

Backend for the processing screen's failure state (4.2): "Step N of 4 didn't finish", a plain reason, and a working **Try again** (D7). Contract C6 in [contracts.md](contracts.md). Consumer: FE-2.

Read `runs/lifecycle.py` (`advance`, `start`, `_VIDEO_SET`, `_ENQUEUE`, `enqueue`), `pipeline/stages.py` (`Task`, `_gate`, `_still`, `_fail`, the stage handlers), `pipeline/relay.py` (`claim`), `pipeline/media_engines.py` (`propose`), and `01_schema.sql` (`run_transitions`, the `runs` checks) before starting.

## Steps (in order; test first for each)

### D1. Tasks carry their attempt; stale tasks are no-ops

A retry bumps `runs.attempt`. A redelivered task from the old attempt must then do nothing, but `_gate` only checks the status.

- `Task` (`pipeline/stages.py`) gains `attempt: int`.
- `relay.claim` selects `payload` too and builds `Task(attempt=payload["attempt"], ...)`. Every enqueue already puts `attempt` in the payload; check that every call site of `enqueue` does, and fix any that does not.
- `_gate`, `_still` and `_fail` treat `task.attempt != run.attempt` as a no-op (log and return None / nothing).
- Update every `Task(...)` construction in tests (`grep -rn "Task(" backend/tests`) with `attempt=1`.
- Test: after a retry (D3), a redelivered attempt-1 task changes nothing: status, proposals and outbox unchanged.

### D2. A fresh agent thread per attempt

`MediaEngines.propose` passes `thread_id=str(run.id)`. Today the checkpointer is in-memory, but with PostgresSaver an agent retry would resume the failed checkpoint. Use `thread_id=f"{run.id}:{run.attempt}"`. A redelivered task of the same attempt still resumes its own checkpoint (Phase 3b item 5). Check the run object passed to `propose` carries `attempt`; add it to its protocol if not. Test with the in-memory saver: two attempts get two threads.

### D3. Retry route

Migration `docs/design/sql/11_runs_started_at_grant.sql`: `grant update (started_at) on runs to app_api;`. `advance` sets `started_at` when entering `preprocessing`, and the API role has no grant for that column today (`02_rls.sql` grants status, stage, attempt, error, finished_at). Do not edit `02_rls.sql`.

New exceptions in `runs/exceptions.py`, re-exported by `lifecycle.py` as the existing ones are, mapped in `runs/router.py` `_domain_errors` with the existing `_conflict` helper: `RunNotFailed` (409 `run_not_failed`), `RunNotCurrent` (409 `run_not_current`), `RunNotRetryable` (409 `not_retryable`).

`lifecycle.retry(conn, run_id)`, one transaction:
1. Lock the run (`for update`). None -> the route returns 404 `not_found("run")`. `status != "failed"` -> `RunNotFailed` (the transitions trigger fires only on a status change, so this check is needed). `error.retryable` false -> `RunNotRetryable`.
2. Lock the video (`select current_run_id ... for update`). Not this run -> `RunNotCurrent`. Lock order run then video, as in `advance`.
3. Target from `run.stage` (never `error.stage`):

   | `run.stage` | Retry to | `stage=` | Video status |
   |---|---|---|---|
   | null or `preprocess` | `preprocessing` | `preprocess` | `processing` |
   | `agent` | `agent_running` | `agent` | `processing` |
   | `approved` or `render` | `postprocessing` | `render` | `rendering` |

   Check each row against `run_transitions` in `01_schema.sql`; the retry edges are `failed -> preprocessing | agent_running | postprocessing`. Any other stage value -> `RunNotRetryable`.
4. `advance(conn, bumped, target, stage=..., retry=True)` where `bumped` is the `RunRef` with `attempt + 1`. New parameter `retry: bool = False`: when true, the update also writes `attempt = %(attempt)s` (from the RunRef; do not add one in SQL), `finished_at = null`, `error = null`. The schema requires `finished_at` null for live statuses.
5. Video status: `_VIDEO_SET` has no entry for these three targets, so set it in `retry` (guarded by `current_run_id`, as `_VIDEO_SET` is).
6. Outbox: `agent_running` already enqueues through `_ENQUEUE`. For `preprocessing` write `pre-cpu`/`pre-cpu` and for `postprocessing` `post-io`/`post-io` in `retry` itself, with the same payload shape as `start` (including the new attempt). Do not add them to `_ENQUEUE`: the normal flow already enqueues them in `start` and approve, so they would run twice. Task ids are `sha256(run_id:stage:attempt)`, so the new attempt gets new ids.

Route `POST /runs/{run_id}/retry` -> 202 `RunSummary`, add to `REQUIRED`.

Tests in `backend/tests/runs/`:
- fail, retry, fail, retry: `attempt` reads 2 then 3; `finished_at` and `error` cleared each time.
- retry through the `api` fixture (the `app_api` pool) on a run failed in preprocess whose `started_at` is null: status `preprocessing`, `started_at` set, one `pre-cpu` outbox row for attempt 2. This test fails without migration 11.
- retry of a live run: 409 `run_not_failed`, outbox unchanged. Superseded run: 409 `run_not_current`. `retryable=false`: 409 `not_retryable`.
- one test per target row in the table.

### D4. Safe failure text

`_fail` in `pipeline/stages.py` today sends the queue name as `stage`, the exception text as `message`, and `retryable=True`. Change to (C6):
- `stage`: `{"pre-cpu": "1", "agent": "3", "post-io": "4"}[task.queue]`.
- `message`: from a table in `stages.py` keyed by exception type, default for unknown ones. Copy, plain and short:
  - `ProviderError` retryable: "The AI service didn't answer in time. Trying again usually works."
  - `ProviderError` not retryable: "This step needs a service that isn't set up yet."
  - media / ffmpeg errors (find their type in `pipeline/media.py`): "We couldn't read this recording's video or audio."
  - default: "Something went wrong on our side. Trying again usually works."
- `retryable`: `exc.retryable` when the exception has it, else `True`.
- Log the exception with `log.exception` so the text is not lost.
- Tests: a non-retryable `ProviderError` gives `retryable=False` and the second message; an unknown exception gives the default; no message contains the exception text.

## Exit

README section 4 checks, including `check_db.py` for migration 11.
