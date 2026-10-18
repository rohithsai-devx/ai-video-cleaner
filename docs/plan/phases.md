# Build plan: four phases

Agreed 2026-10-17. Each phase ends with a working, demoable system, and each phase builds only on the contract the one before it fixed. The design is in [../design/hld-lld.md](../design/hld-lld.md).

| Phase | Goal | Real | Stubbed |
| --- | --- | --- | --- |
| 1 | Backend foundation and API contract | Python setup, shared types, Postgres schema + RLS, JWT auth, every router | Run processing (a fake worker walks the status lifecycle) |
| 2 | Front-end prototype, the product vision | Next.js app: every screen, recorder, upload, live status, review, share | Backend AI (still phase 1 stubs) |
| 3 | Real pipeline | Preprocess → agents → postprocess, queues, outbox relay | Nothing in the core loop |
| 4 | End to end and hardening | E2E tests, load test at 200 concurrent runs, GCP deploy, observability | — |

## Phase 1: backend foundation and API contract

Goal: the full API exists, is typed, is secured by JWT and RLS, and returns realistic stub data, so phase 2 builds against the real contract.

1. **Repo and tooling:** `backend/` managed with `uv`, plus `ruff`, a type checker and `pytest`. `docker compose` runs Postgres 16 and Redis locally.
2. **Shared types:** the Pydantic models from the design doc (`Word` … `Proposal`) as one shared package (now `backend/app/contracts/`; types used by one domain only live in that domain's `schemas.py`).
3. **Database:** migrations apply [01_schema.sql](../design/sql/01_schema.sql) and [02_rls.sql](../design/sql/02_rls.sql). [03_rls_tests.sql](../design/sql/03_rls_tests.sql) and the "every table forced" guard run in CI.
4. **Auth (simple JWT):** sign-up/sign-in issue a short-lived access token. A FastAPI dependency decodes it and opens `tenant_tx(user_id)`, which sets `app.user_id` for RLS. The API connects as `app_api`, never as an owner or superuser.
5. **Routers:** every endpoint in the design's API table, with request and response models. Handlers read and write real rows (videos, runs, proposals, shares) where that is cheap. AI output comes from fixtures that validate against the models.
6. **Fake worker** (now `backend/app/pipeline/` with `FixtureEngines` as the only fake): `POST /videos/{id}/runs` enqueues to an in-process stub that steps a run through `queued → … → awaiting_review` (or `done` in auto mode), writes a fixture proposal, and publishes SSE events. The status trigger and compare-and-set rules apply as in production.
7. **Contract export:** a script dumps `openapi.json`, from which phase 2 generates its TypeScript client.

Exit criteria:

- [x] Every endpoint in the API table exists and returns model-valid data.
- [ ] RLS tests pass in CI against Postgres 16. (Pass locally on Postgres 16 via `scripts/check_db.py`; CI has not run yet.)
- [x] A user can sign up, sign in, and call protected endpoints; a second user cannot see the first user's data.
- [x] A fake run reaches `awaiting_review` with live SSE events, and `approve` moves it to `done`.
- [ ] `openapi.json` is generated and committed. (Generated at `backend/openapi.json`; not committed yet.)

Decided at phase start (2026-10-18):

- **Python 3.12**, managed by `uv` (`.python-version` = 3.12; Cloud Run base `python:3.12-slim`).
- **Migrations: plain ordered SQL files**, applied by a small runner that records applied files in `schema_migrations`. The files stay in `docs/design/sql/` (no copies): every `NN_*.sql` except `*_tests.sql`, in order. `03_rls_tests.sql` runs in CI after them.
- **JWT: email + password, access token only.** argon2 hashes in a separate `user_credentials` table (forced RLS, no `app_api` grants), reached only through `SECURITY DEFINER` functions, so co-members reading `users` never see hashes. HS256 via PyJWT, 30-minute lifetime, `sub` = user id, secret from `.env`. No refresh tokens or magic links in v1 phase 1; the user signs in again.
- **Local uploads: fake-gcs-server** in `docker compose`, so the resumable-upload and object-exists code paths match real GCS (`STORAGE_EMULATOR_HOST`). Since phase 2 it stores objects on disk in `./.data/gcs` (gitignored), so recordings survive restarts.

## Phase 2: front-end prototype

Goal: the product as a user sees it, clickable end to end against the phase 1 API.

- Screens, from the design canvas (`docs/design/screens/`, published at https://claude.ai/artifact/XBA2N7X99cgj8iHutxQzBW): sign in → dashboard/library → record (screen-share dialog) → recorded video with "Process with AI" → live progress → review screen → share link (Loom-style).
- The recorder uses real `getDisplayMedia` + `MediaRecorder`. It warns when the stream has no audio track, which Chrome allows even when audio is requested.
- Review screen: script blocks, cut list with reasoning, flagged blocks highlighted, approve or edit.
- Typed API client generated from `openapi.json`. No hand-written mocks that could drift from the backend.

- [x] Exit criteria: the full screen flow clicks through in the browser with stub AI output, in review mode and in auto mode. (Met locally 2026-10-18: 10 Playwright specs incl. a real recorder run with Chrome fake devices, two independent black-box verification passes, code review findings fixed. Committing and the first CI run are still pending.)

Decided at phase start (2026-10-18):

- **Product name in the UI: Stepwise** (working name). The repo and API keep "AI Video Cleaner".
- **Auth in the browser: Next.js as a same-origin proxy.** Sign-in stores the JWT in an httpOnly, Secure, SameSite=Lax cookie; the browser calls `/api/*` and a route handler forwards to FastAPI with `Authorization: Bearer`. Page scripts never see the token, there is no CORS, and live progress uses the native `EventSource` through the same proxy.
- **Recording limit: 15 minutes.** The recorder stops itself at 15:00; `POST /videos/{id}/uploaded` rejects a duration over 900 s.
- **Upload after stop**, to the resumable session in 256 KiB-multiple chunks, resuming after a failed chunk.
- **Share visibility default: anyone with the link** (`link`, the backend default). Share URLs use a new `FRONTEND_BASE_URL` setting.
- **Stack** (versions in [../research/frontend-stack-2026-10-18.md](../research/frontend-stack-2026-10-18.md)): Next.js 16 App Router, React 19, TypeScript, Tailwind 4, `openapi-typescript` + `openapi-fetch` + `openapi-react-query` on TanStack Query 5, Vitest, Playwright. `output: 'standalone'` for Cloud Run.

## Phase 3: real pipeline (preprocess → agents → postprocess)

Goal: a real recording goes in and a cleaned video comes out, replacing the fake worker stage by stage.

1. **Queues:** outbox relay, Cloud Tasks (or a local equivalent), workers per queue, hashed task ids.
2. **Preprocessing:** ingest (ffmpeg, starting with ffprobe: fail the run when the real duration exceeds `MAX_RECORDING_SECONDS`, since phase 2 trusts the browser's figure; replace the browser poster with a chosen keyframe), transcription with word timestamps, keyframes, segments into `runs.pre`. Tune `pause_ms` and `ε` on 5 real recordings.
3. **Agents:** provider factory with one adapter per stage; the LangGraph graph (orchestrator + `vlm_context`, `transcript_context`, `script_writer`, `video_editor`) with `durability="sync"` and a PostgresSaver in schema `lg`. Code checks are written test-first. Calibrate the decider on our own data before trusting `accept_threshold`.
4. **Postprocessing:** TTS (ElevenLabs character timings grouped into words), `fit_timeline` (pure, test-first), render, publish. Renders over 30 minutes run as Cloud Run Jobs.

Exit criteria: 5 real recordings processed in both modes; review edits create a user proposal and re-render; a killed worker resumes from its checkpoint.

Decide during phase 3: v1 provider per stage, default voice, `accept_threshold` and `max_attempts` defaults.

## Phase 4: end to end and hardening

- Playwright E2E across the full flow, both modes, with real recordings (phase 2 covers it with stub AI and Chrome's fake devices).
- **Auth hardening:** refresh tokens or sliding sessions (phase 2 signs users out after 30 minutes, even mid-review); rate limit and lockout on sign-in; password reset by email; rehash on sign-in when argon2 parameters change (`needs_rehash`).
- **GCS on real infra:** bucket CORS for the resumable upload from the app origin, with `Range` in `responseHeader` (the browser must read it to resume after a partial chunk; fake-gcs exposes only `Location`); signed URLs on Cloud Run; Download MP4 via a signed URL with `response-content-disposition` (the `download` attribute is ignored cross-origin).
- **Queue to Cloud Tasks:** the outbox relay sends to Cloud Tasks (phase 2 runs only the in-process fake worker).
- API rate limits per user and workspace.
- `FRONTEND_BASE_URL` required outside local dev (it defaults to `http://localhost:3000`, so a missing value would mint localhost share links).
- Private and workspace share visibility: `app.resolve_share` serves only `link` shares, so the UI offers only "Anyone with the link" until the share page can check the viewer.
- Library signing cost: `GET /videos` checks and signs each playback and poster URL one call at a time; sign a page in one batch and skip the existence check for URIs verified at write time.
- Load test: 200 concurrent runs within provider rate limits.
- GCP deploy: Cloud Run, Cloud SQL (HA, PITR), Memorystore, GCS, Cloud Tasks. Confirm on the instance that the app roles lack `BYPASSRLS`.
- Observability: provider cost and latency from `provider_calls`, run funnel, error rates.
- Spike the remaining open fact: whole-screen system audio per OS.

Decide in phase 4: pricing unit and quotas, auth provider for production (for example, Google Workspace SSO).
