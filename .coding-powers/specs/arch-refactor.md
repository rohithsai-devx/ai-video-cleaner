# Backend architecture refactor (after Phase 1)

Source: the architecture review of 2026-10-18 (candidates 1–5). Behavior and the HTTP contract stay the same: the same 45 tests keep passing (moved or rewritten at the new interfaces), and `openapi.json` keeps the same paths and schemas, except where R2 says otherwise. Repo rules in CLAUDE.md apply: tenancy, CAS, outbox, and object-before-row.

Not created, by the deletion test: `videos/`, `shares/` and `glossary/` domain modules. Their handlers are single SQL statements with no rules, so a module would only pass calls through. Create one when a rule appears.

## R1: folders by concept (mechanical, no behavior change)

Moves (update every import in `app/`, `tests/` and `scripts/`; delete the old packages, including `__pycache__`):

| From | To |
|---|---|
| `app/db/` | `app/infra/db/` |
| `app/storage/` | `app/infra/storage/` |
| `app/events/pubsub.py` (+ `__init__` exports) | `app/infra/events.py` (`channel`, `get_redis`, `close_redis`, `publish`) |
| `app/events/router.py` | `app/api/events.py` |
| `app/auth/{passwords,tokens,deps}.py` (+ `__init__` exports) | `app/infra/auth/` (same exports: `CurrentUser`, `TenantConn`, `issue_token`, …) |
| `app/auth/router.py` | `app/api/auth.py` |
| `app/routers/{videos,runs,shares,glossary,deps}.py` | `app/api/` |
| `app/routers/__init__.py` (`routers` list) | `app/api/__init__.py`: a `routers` list that also includes auth and events, in the current mount order |
| `app/routers/checks.py` | `app/runs/checks.py` (new package `app/runs/`) |
| `app/worker/fake.py` | `app/pipeline/fake.py` (R3 splits it) |

`app/main.py` mounts `app.api.routers`. The `infra/` packages hold adapters only: no HTTP routers, no domain rules.

## R2: runs domain (candidates 1 and 3, plus the review trust fix)

### `app/runs/lifecycle.py`: the only code that changes `runs.status`

```python
Event = tuple[str, BaseModel]          # (SSE event name, payload); publish after commit

@dataclass(frozen=True)
class RunRef:
    id: UUID; workspace_id: UUID; video_id: UUID; status: RunStatus; stage: str | None
    attempt: int; mode: RunMode; duration_s: float | None   # video duration, else runs.pre.duration

class Lost(Exception): ...             # CAS changed 0 rows: another writer won
class LiveRunExists(Exception): ...    # runs_one_live_per_video

async def load(conn, run_id, *, for_update: bool = True) -> RunRef | None   # None = invisible (RLS) or missing
async def start(conn, *, video_id, mode, voice, voice_id) -> tuple[RunRef, list[Event]]
async def advance(conn, run: RunRef, to: RunStatus, *, stage: str | None = None,
                  error: RunFailedEvent | None = None, output_uri: str | None = None) -> list[Event]
```

`start` inserts the run (`queued`), sets `videos.current_run_id` and `status='processing'`, enqueues `pre-cpu`, and maps the unique violation to `LiveRunExists`. `advance` is one CAS `run.status → to` (raises `Lost` on 0 rows) plus everything that goes with entering `to`, from this one table:

| Entering | Also sets | Enqueues |
|---|---|---|
| `preprocessing` | `runs.started_at = coalesce(started_at, now())` | — |
| `agent_running` | — | `agent` |
| `awaiting_review` | video `awaiting_review` | — |
| `approved` | video `rendering` | `post-io` |
| `postprocessing` | — | — |
| `done` | `finished_at`; video `ready`, `output_uri` (required) | — |
| `failed` | `finished_at`; `runs.error`; video `failed` | — |
| `cancelled` | `finished_at`; video `ready` if it has `output_uri`, else `uploaded` | — |

Video updates always carry `where id = video_id and current_run_id = run.id`. Task ids stay `sha256(run_id:stage:attempt)` via `app.infra.db.enqueue`. It returns `[("run.status", RunStatusEvent(status=to, stage=stage))]`. Column grants: `app_api` may set only status, stage, attempt, error and finished_at on runs, so `started_at` and `output_uri` are set only on worker connections. Don't widen the grants.

### `app/runs/review.py`: proposal versions, user edits, approval

```python
class NotReviewable(Exception): ...    # run not awaiting_review           -> 409
class NoProposal(Exception): ...       # no proposal yet                   -> 409 (404 on GET)
class EditNotAllowed(Exception): ...   # body changes a non-editable field -> 422, message names the fields
class InvalidEdl(Exception):           # EDL check failed                  -> 422
    check: CheckResult

async def latest(conn, run: RunRef) -> tuple[UUID, Proposal] | None
async def save_edit(conn, run: RunRef, update: ProposalUpdate) -> Proposal          # run must be locked
async def approve(conn, run: RunRef) -> list[Event]                                  # run must be locked
```

**Trust rule.** Compared with the latest version, a user may change only these fields:
- `script.blocks[].text`
- `edit_plan.entries[].action`, `.speed` and `.freeze_s`, matched by `seg_id`
- `seg_contexts[].must_keep`

The same block ids and seg ids must be present, and every other field must equal the stored value. Otherwise `save_edit` raises `EditNotAllowed`. The EDL check (`app.runs.checks`) always uses the stored `seg_contexts`. `save_edit` writes version n+1 (`source='user'`) and its `review_edits` rows (`block_text`, `cut_toggle`, `speed`, `must_keep`). `approve` runs the EDL check on the latest version (raising `InvalidEdl`), sets `approved_by` and `approved_at`, then calls `lifecycle.advance(run, "approved")`, which also enqueues `post-io`.

### Callers

`app/api/runs.py` and `start_run` in `app/api/videos.py` keep only parsing, `tenant_tx`, mapping exceptions to HTTP, and the best-effort publish after commit. They contain no run or proposal SQL. Tests: `tests/test_lifecycle.py` and `tests/test_review.py` at these interfaces against the compose Postgres. The trust rule needs a test for each rejected field kind.

## R3: pipeline split (candidate 2) and storage (candidate 4)

### `app/infra/storage/`: owns object naming and signing

`GcsStorage` (the emulator-vs-real switch stays internal) gains a layout and async, URI-based methods. Callers never see keys or threads:

```python
def raw_uri(self, video_id) -> str                                    # gs://<bucket>/videos/{id}/raw.webm
def output_uri(self, run_id, version: int) -> str                     # .../runs/{id}/post/v{n}/final.mp4
async def upload_session(self, uri: str, content_type: str) -> str
async def exists(self, uri: str) -> bool
async def sign(self, *uris: str | None) -> list[str | None]           # None for None/missing/foreign bucket
async def copy(self, src_uri: str, dst_uri: str) -> None              # same bucket; used by the fixture render
```

`app/infra/events.py` gains `async def publish_all(run_id, events: list[Event]) -> None`. It is best effort: it logs failures and never raises, and it replaces the `publish` wrapper in `app/api/deps.py`. The API handlers and the pipeline both call it after commit.

Each method runs the sync client in `asyncio.to_thread`. `get_storage()` (lru_cached from settings) moves to `app/infra/storage/__init__.py`. `app/api/deps.py` keeps only `StorageDep = Annotated[GcsStorage, Depends(get_storage)]`; the `Storage` Protocol, `raw_key`, `gs_uri`, `uri_key` and `sign` helpers are deleted. Tests override `app.infra.storage.get_storage`. Storage tests cover the layout, a foreign-bucket URI and a missing object.

### `app/pipeline/`: three seams, only one fake

- `engines.py`: the port for what the stages compute, which the provider factory backs in phase 3:

  ```python
  class AgentOutput(BaseModel): script; edit_plan; seg_contexts; transcript_ctx; checks; flags   # app.models types
  class Engines(Protocol):
      async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult
      async def propose(self, run: RunRef, pre: PreprocessResult) -> AgentOutput
      async def render(self, run: RunRef, proposal: Proposal, output_uri: str) -> None    # writes the object first
  ```

- `fixture_engines.py`: `FixtureEngines`, the only fake. It reads `app/pipeline/fixtures/proposal.json`, moved from `tests/fixtures/`; tests read it from the new path. `render` copies the raw object to `output_uri` (a GCS copy), so the object exists before the row points to it.
- `stages.py`: `async def handle(task: Task, engines: Engines, storage: GcsStorage) -> list[Event]`. It opens one `app_worker` transaction with `set_config('app.workspace_id', …, true)`, uses `lifecycle.load` and `lifecycle.advance` for every status change, and swallows `Lost` (returning `[]`). It writes `runs.pre` from `preprocess` and saves `propose` output as proposal v1 (`ON CONFLICT DO NOTHING`). After `done`, the caller also publishes `run.done` with the signed output URL.
  - Stage per queue: `pre-cpu` → queued→preprocessing→agent_running; `agent` → awaiting_review (review) or approved (auto); `post-io` → approved→postprocessing→done.
- `relay.py`: the delivery seam. `claim(relay_conn, limit) -> list[Task]` (as `app_relay`, `FOR UPDATE SKIP LOCKED`, sets `sent_at`), and `async def run_in_process(stop, engines, storage)`, which claims, calls `handle` and publishes after commit. A phase 3 Cloud Tasks HTTP handler calls the same `handle`. `Task` is a small frozen dataclass (`task_id, queue, run_id, workspace_id`).
- Delete `cas_run_status` (`app/infra/db/runs.py` and its export): `lifecycle.advance` is the only status writer.
- Delete `app/pipeline/fake.py`; `tests/test_worker.py` becomes `tests/test_pipeline.py` at the `handle` and `run_in_process` interfaces, using `FixtureEngines`. `main.py` starts `run_in_process(stop, FixtureEngines(storage), get_storage())` when `settings.fake_worker`.

## R4: domain packages with community file names (the "10/10" layout)

Sources: zhanymkanov/fastapi-best-practices (one package per domain, with `router.py`, `schemas.py`, `service.py`, `dependencies.py`, `exceptions.py`), LangGraph's application structure, and screaming architecture. The oracle is `backend/scripts/check_layout.py` (also run by `tests/test_layout.py`). The move is done when it prints `layout ok` and every other check still passes.

Mechanical move: behavior, SQL and HTTP paths are unchanged, and `openapi.json` keeps the same paths and schemas, so `export_openapi.py --check` passes without regenerating. Only module paths, file names and imports change. Delete the old packages, including `__pycache__`.

| From | To |
|---|---|
| `app/config.py` | `app/shared/config.py` |
| `app/infra/db/` | `app/shared/db/` |
| `app/infra/storage/` | `app/shared/storage/` (also holds `StorageDep`, from `app/api/deps.py`) |
| `app/infra/events.py` | `app/shared/events.py` |
| `app/models/enums.py`, `app/models/pipeline.py` | `app/contracts/enums.py`, `app/contracts/pipeline.py` |
| `RunFailedEvent`, `RunStatusEvent`, `RunProposalReadyEvent`, `RunDoneEvent`, `RunEvent` (from `app/models/api.py`) | `app/contracts/events.py`: payloads that cross worker → API → browser |
| `app/infra/auth/passwords.py` + `tokens.py` | `app/auth/security.py` |
| `app/infra/auth/deps.py` | `app/auth/dependencies.py` (`CurrentUser`, `TenantConn`) |
| `app/api/auth.py` | `app/auth/router.py`; `SignUp`, `SignIn`, `Token` go to `app/auth/schemas.py` |
| `app/api/videos.py` (except `start_run`) | `app/videos/router.py`; `Page`, `VideoCreate`, `VideoCreated`, `VideoUploaded`, `Video` go to `app/videos/schemas.py` |
| `start_run` (in `app/api/videos.py`), `app/api/runs.py`, `app/api/events.py` (SSE) | `app/runs/router.py`; `RunSummary`, `RunCreate`, `RunCreated`, `Run`, `ProposalUpdate`, `KeyframeThumb`, `ProposalView` go to `app/runs/schemas.py` |
| exception classes now defined in `runs/lifecycle.py` and `runs/review.py` | `app/runs/exceptions.py` (re-exported where they were, so callers keep working) |
| `app/api/shares.py` | `app/shares/router.py`; `ShareCreate`, `ShareCreated`, `SharePublic` go to `app/shares/schemas.py` |
| `app/api/glossary.py` | `app/glossary/router.py`; `GlossaryTerm` goes to `app/glossary/schemas.py` |
| `app/pipeline/*` | unchanged |
| `app/main.py` | imports and mounts each `app.<domain>.router.router` (auth, videos, runs, shares, glossary) and starts the pipeline |

Tests mirror the app. `tests/<area>/test_*.py`, each area with an `__init__.py`:

| From | To |
|---|---|
| `test_core.py` | `auth/` |
| `test_api.py` | `videos/` (shared fixtures such as `FakeStorage`, `_user`, `api` and `worker_tx` move to `tests/conftest.py` or `tests/factories.py`) |
| `test_lifecycle.py`, `test_review.py` | `runs/` |
| `test_storage.py`, `test_events.py` | `shared/` |
| `test_models.py` | `contracts/` |
| `test_pipeline.py` | `pipeline/` |
| `test_e2e.py` | `e2e/` |

Every test that exists now must still exist and pass: same count plus `test_layout`.

Not created now (no empty scaffolding): `agent/`, `search/`, `providers/`, and `langgraph.json`. The checker already enforces their shape when they appear: `agent/` needs `agent.py`, `state.py`, `nodes`, `tools` and `backend/langgraph.json`.
