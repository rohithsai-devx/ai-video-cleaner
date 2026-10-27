# AI Video Cleaner

A Trupeer-style product: a user records their screen in the browser, an AI agent proposes a cleaned script and cut plan, the user reviews it (or auto-approves), and the app renders a cleaned video with an optional AI voiceover and a Loom-style share link.

## Read first

- `docs/plan/phases.md`: the build order and the current phase's exit criteria. **Work only on the current phase.**
- `docs/design/hld-lld.md`: architecture, agent graph, schema, API, queues, providers. This is the source of truth; update it when a decision changes.
- `docs/design/sql/`: the tested schema (`01_schema.sql`), RLS (`02_rls.sql`), and the isolation/integrity tests (`03_rls_tests.sql`).
- `docs/research/findings-2026-10-17.md`: verified external facts (LangGraph, Postgres, GCP limits, ElevenLabs, Gemma 4, decision-model APIs, Chrome capture).

## Current phase

Phase 3b (providers and the agent) is in progress. The Stepwise post-upload rework is planned in `docs/plan/post-upload/`. See `docs/plan/phases.md`. Phases 1 and 2 are done (CI green on `main`, repo `rohithsai-devx/ai-video-cleaner`). The user-facing product name is **Stepwise**; frontend layout and rules are in `.coding-powers/specs/phase2.md` and enforced by `frontend/scripts/check-layout.mjs`.

**Start here:** read the handoff at `/var/folders/qp/8b0qv4892bb4plm042zcxqvc0000gn/T/ai-video-cleaner-handoff-2026-10-18-phase3.md` (it sits in the OS temp folder; if it's gone, ask the user).

## Stack

Next.js + TypeScript (frontend), FastAPI + Pydantic (API), LangGraph (agent core only), Python + ffmpeg workers, Postgres 16 (Cloud SQL), Redis, GCS, Cloud Tasks, Cloud Run, SSE.

## Rules that are easy to break

- **Tenancy:** every request runs inside one transaction that calls `set_config('app.user_id', ..., true)` (workers set `app.workspace_id`). Never use session-level `SET`, never connect as the table owner or a superuser, and never add `BYPASSRLS` to an app role.
- **New tables:** they need `workspace_id` with a composite FK to their parent, `ENABLE` + `FORCE` row-level security, per-role policies and grants, and new cases in the RLS tests. The CI guard fails if RLS or FORCE is missing.
- **Run status:** changes go only through `backend/app/runs/lifecycle.py` (`advance`). Each is a compare-and-set update (`... where id = $id and status = $expected`) checked by the `run_transitions` trigger; 0 rows means another writer won.
- **Backend layout:** one package per domain with `router.py` and `schemas.py`, plus `shared/`, `contracts/` and `pipeline/`. `backend/scripts/check_layout.py` enforces it in CI.
- **Queue enqueues:** these are `outbox` rows written in the same transaction as the state change, never direct calls to the queue from request code. Task ids are `sha256(run_id:stage:attempt)`.
- **GCS:** write the object first, then commit the row that points to it.
- **LangGraph:** the graph holds only the agent part. Pre- and postprocessing are plain code, and review lives outside the graph (proposal saved to the DB, approval enqueues postprocessing).
- **Design preferences:** the user prefers agent-made decisions over hard-coded rule lists. Code enforces only mechanical, global limits.
