# Build plan

Agreed 2026-10-17. Each phase ends with a working, demoable system, and each phase builds only on the contract the one before it fixed. The design is in [../design/hld-lld.md](../design/hld-lld.md).

| Phase | Goal | Real | Stubbed |
| --- | --- | --- | --- |
| 1 | Backend foundation and API contract | Python setup, shared types, Postgres schema + RLS, JWT auth, every router | Run processing (a fake worker walks the status lifecycle) |
| 2 | Front-end prototype, the product vision | Next.js app: every screen, recorder, upload, live status, review, share | Backend AI (still phase 1 stubs) |
| 3a | Pre and post, code only | Queues, ffmpeg ingest, frames, segments, `fit_timeline`, render, publish | Transcription, TTS, and the agent (the fixture proposal stays) |
| 3b | Providers and the agent | One adapter per stage, the LangGraph graph, real words and real voice | — |
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
- [x] RLS tests pass in CI against Postgres 16. (First CI run green, 2026-10-18.)
- [x] A user can sign up, sign in, and call protected endpoints; a second user cannot see the first user's data.
- [x] A fake run reaches `awaiting_review` with live SSE events, and `approve` moves it to `done`.
- [x] `openapi.json` is generated and committed (`backend/openapi.json`, commit 192f836).

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

- [x] Exit criteria: the full screen flow clicks through in the browser with stub AI output, in review mode and in auto mode. (Met locally 2026-10-18: 10 Playwright specs incl. a real recorder run with Chrome fake devices, two independent black-box verification passes, code review findings fixed. Committed in 192f836; first CI run green.)

Decided at phase start (2026-10-18):

- **Product name in the UI: Stepwise** (working name). The repo and API keep "AI Video Cleaner".
- **Auth in the browser: Next.js as a same-origin proxy.** Sign-in stores the JWT in an httpOnly, Secure, SameSite=Lax cookie; the browser calls `/api/*` and a route handler forwards to FastAPI with `Authorization: Bearer`. Page scripts never see the token, there is no CORS, and live progress uses the native `EventSource` through the same proxy.
- **Recording limit: 15 minutes.** The recorder stops itself at 15:00; `POST /videos/{id}/uploaded` rejects a duration over 900 s.
- **Upload after stop**, to the resumable session in 256 KiB-multiple chunks, resuming after a failed chunk.
- **Share visibility default: anyone with the link** (`link`, the backend default). Share URLs use a new `FRONTEND_BASE_URL` setting.
- **Stack** (versions in [../research/frontend-stack-2026-10-18.md](../research/frontend-stack-2026-10-18.md)): Next.js 16 App Router, React 19, TypeScript, Tailwind 4, `openapi-typescript` + `openapi-fetch` + `openapi-react-query` on TanStack Query 5, Vitest, Playwright. `output: 'standalone'` for Cloud Run.

## Phase 3a: pre and post, code only

Goal: a real recording is probed, transcoded, framed and segmented, and an approval renders a real MP4. No model is called. `Engines.propose` stays the fixture. The design of each step is in [../design/hld-lld.md](../design/hld-lld.md) (preprocessing, postprocessing, queues).

Model calls that the design lists inside pre and post move to phase 3b: `transcribe` and `voice` (TTS). Phase 3a stubs those two and builds everything around them.

1. **Workers.** Keep the outbox and `run_in_process` as the local Cloud Tasks stand-in. Hashed task ids stay. ffmpeg is not on the Mac, so the relay runs in a compose service that has ffmpeg. Phase 4 is what swaps the relay for Cloud Tasks. Renders over 30 minutes stay a phase 4 Cloud Run Job.
2. **Preprocess, code.** `ffprobe` first: fail the run when the real duration exceeds `MAX_RECORDING_SECONDS` (900). Transcode to the mezzanine MP4 and the WAV, sample keyframes, replace the browser poster with a chosen frame, segment on scene changes, write `runs.pre`. Speech-pause boundaries wait for real words, so `pause_ms` is not tuned here.
3. **Transcribe, stub.** `words` is a fixture timed to the real duration. Scene segments are real.
4. **Propose, unchanged.** The fixture proposal must be valid for that real duration, so approving a short recording no longer returns 422.
5. **Postprocess, code.** `fit_timeline` is a pure function, written test-first. Original-audio mode cuts the real WAV. AI-voice mode uses a stub clip of the estimated duration, not ElevenLabs. Then ffmpeg renders, writes the MP4 and poster to the fixed paths, and publish marks the video ready.

Exit criteria:

- [ ] A recording over 900 seconds fails in preprocess. A shorter one stores real duration, keyframes and segments on `runs.pre`.
- [ ] Approving it renders a playable MP4 in both voice modes (AI voice uses the stub clip).
- [ ] A review edit still creates a user proposal and re-renders.
- [ ] Killing the worker mid-stage and redelivering the task finishes the same output path.

## Phase 3b: providers and the agent

Goal: the fixture proposal is replaced by the agent, and the two stubs become real providers.

1. **Provider factory.** One adapter per stage. Interfaces stay the ones in the design (`Transcriber`, `VisionDescriber`, `LLM`, `Decider`, `TTS`).
2. **Transcribe.** Word timestamps. Segment also cuts on pauses. Tune `pause_ms` and `ε` on real recordings.
3. **Agent.** LangGraph: orchestrator plus `vlm_context`, `transcript_context`, `script_writer`, `video_editor`. `durability="sync"` and a PostgresSaver in schema `lg`. Code checks are written test-first and shared with the review API. `merge_by` on redo.
4. **Voice.** Real TTS. Character timings grouped into words. The frontend voice list comes from this provider instead of the placeholder `default` option.
5. **Resume.** A killed agent worker continues from its checkpoint.

Exit criteria: 5 real recordings processed in both modes; review edits create a user proposal and re-render; a killed worker resumes from its checkpoint.

Decide at the start of 3b, one at a time: the v1 provider for each stage, the default voice, and the `accept_threshold` and `max_attempts` defaults. Calibrate the decider on our own data before trusting `accept_threshold`.

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
