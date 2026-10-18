# Phase 1 tickets

Scope and decisions: `docs/plan/phases.md` (Phase 1, "Decided at phase start"). Design: `docs/design/hld-lld.md`. This file only splits the work; it does not restate the design.

Layout: `backend/app/{models,db,auth,storage,events,worker,routers}/`, `backend/app/main.py`, `backend/scripts/`, `backend/tests/`. Local services: `compose.yaml` (Postgres 16 on 54329, Redis on 63799, fake-gcs on 4443). Env: `backend/.env` (from `.env.example`).

## A-db: migrations, auth table, RLS tests, CI

- `docs/design/sql/04_auth.sql`: `public.user_credentials(user_id uuid primary key references users on delete cascade, password_hash text not null, created_at timestamptz not null default now())`, owned by `app_owner`, ENABLE + FORCE RLS, no grants to `app_api`/`app_worker`/`app_relay`, policies only for `app_definer`. Two `SECURITY DEFINER` functions owned by `app_definer` with pinned `search_path`, execute granted to `app_api`:
  - `app.register_credentials(p_email citext, p_name text, p_hash text) returns uuid`: the `ensure_user` upsert, then insert credentials; raises `unique_violation` if credentials already exist.
  - `app.credentials_for(p_email citext) returns table (user_id uuid, password_hash text)`.
- Append auth cases to `03_rls_tests.sql` in its style: `app_api` cannot select `user_credentials`; `credentials_for` returns the hash; a duplicate register is rejected. T17 (every table forced) still passes.
- `backend/scripts/migrate.py` (psycopg, `DATABASE_URL_ADMIN`): apply `docs/design/sql/NN_*.sql` except `*_tests.sql`, in order; record each in `schema_migrations(filename, sha256, applied_at)`; skip applied; fail if an applied file's sha changed. `--fresh` recreates the target database. Afterwards, dev only: set `app_api`/`app_worker` passwords from `APP_API_PASSWORD`/`APP_WORKER_PASSWORD` when set.
- `backend/scripts/check_db.py`: fresh-migrate a throwaway database, run `03_rls_tests.sql`, exit nonzero on any FAIL or ERROR.
- `.github/workflows/ci.yml`: `postgres:16` service, uv, Python 3.12, ruff, pyright, `check_db.py`, pytest.

## A-models: shared Pydantic package

- `backend/app/models/`: the design doc's Pydantic section with the same names and meaning (`Word` … `Proposal`, `merge_by`, `AgentState`). Omit runtime-only `Ctx`/`Providers`, with a one-line comment.
- API models from the API table, SSE events table, "Auth (phase 1)" and the schema columns: `VideoCreate`, `VideoCreated{video_id, upload_url}`, `Video` (with a current-run summary and `playback_url`), `Page[T]{items, next_cursor}`, `RunCreate{mode, voice, voice_id?}` (voice_id required iff voice = ai), `RunCreated`, `Run`, `ProposalUpdate`, `ShareCreate`, `ShareCreated{slug, url}`, `SharePublic`, `GlossaryTerm`, `SignUp`, `SignIn`, `Token`, and the four SSE payloads.
- Literal values equal the SQL enum labels.
- `backend/tests/fixtures/proposal.json`: a realistic proposal for a ~60 s recording.
- Tests: the fixture validates and round-trips; `merge_by` replaces by id; Literals equal the enum labels parsed from `01_schema.sql`.

## B-core: db layer, auth, storage

- `app/config.py` (pydantic-settings from `.env`), `app/db/`: async psycopg pool connecting as `app_api`; `tenant_tx(user_id)` exactly as in the design ("How identity reaches Postgres"); a CAS helper that returns the row count; an outbox writer with `task_id = sha256(run_id:stage:attempt)`.
- `app/auth/`: argon2 hashing, PyJWT HS256 tokens (30 min, `sub` = user id), a FastAPI dependency that decodes the token and yields a `tenant_tx` connection; `POST /auth/signup` (creates the user, credentials and a first workspace via `app.create_workspace`) and `POST /auth/signin`.
- `app/storage/`: a GCS adapter that creates a resumable upload session, checks that an object exists, and signs playback URLs; it works against fake-gcs via `STORAGE_EMULATOR_HOST`.
- Tests against the compose Postgres, tdd: wrong password → 401; expired token → 401; a token for user A cannot read user B's rows; `tenant_tx` identity does not leak to the next transaction; a CAS loser gets 0 rows.

## C-api: routers, fake worker, SSE, contract

- `app/routers/`: every endpoint in the design's API table plus `/auth/*`, with request and response models from `app.models`. Real rows where cheap; AI output from `tests/fixtures/proposal.json`. Follow the "Transaction boundaries" table (outbox rows in the same transaction, `FOR UPDATE` on approve, 409 on a second live run, 422 only when an EDL check fails).
- `app/worker/fake.py`: an in-process stub that consumes the outbox for local dev, steps `queued → preprocessing → agent_running → awaiting_review` (or `approved → postprocessing → done` in auto mode) with CAS updates, writes the fixture proposal as v1, and publishes SSE events to Redis `run:{id}`. Approve continues it to `done`.
- `app/events/`: Redis pub/sub relayed to `GET /runs/{id}/events` (sse-starlette).
- `GET /runs/{id}/proposal` returns the proposal plus keyframe thumbnail URLs: add a response wrapper in `app/models/api.py` (the A review found none). Never put a raw `gs://` URI on the wire; where the design names `output_uri` (the `run.done` event), send the signed playback URL in that field.
- Storage calls are sync: use `await asyncio.to_thread(...)` and keep them outside `tenant_tx` (existence check before, upload URL after commit).
- `backend/scripts/export_openapi.py` writes `backend/openapi.json`.
- Tests: sign up, create video, upload to fake-gcs, confirm, start run, see SSE events up to `awaiting_review`, approve, reach `done`; a second user gets 404 on the first user's video and run.
