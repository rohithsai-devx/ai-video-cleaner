# Pre-phase-4 audit — findings and actions

Date: 2026-10-19 · Method: three parallel read-only audits (review/edit UX, navigation & history, backend gaps & docs drift), seeded by the live phase-3 UAT session (which surfaced: webm duration probe, empty-plan review dead-end, tool-call parse crash, 24.8-hour TTS render, >8 MiB upload failure, check jargon, duplicate-key timeline, one-live-run 409 UX).

Use this as the ordered backlog before phase 4. Sizes: S < half day, M 1–2 days, L more.

## Verdict

The core loop works end-to-end and the seams that exist are well built (version CAS, trust rule, recheck-on-edit, outbox/CAS discipline, RLS). What blocks phase 4 is: one live product bug (approve gating), three missing product features the UAT explicitly demands (history, retry, compare/original), one observability table nothing writes (`provider_calls`), one spec contradiction (`MemorySaver` vs `PostgresSaver`), and a 14-item docs drift inventory. Nothing is L-size.

---

## 0. Do first (this week, before any phase-4 branch)

1. **Run the gate on the uncommitted tree** (29 modified + large untracked set; all of 3b is uncommitted):
   `uv run ruff check . && uv run ruff format --check . && uv run pyright && uv run pytest` — pyright currently reports 7 errors (pre-3b-fixture `SecretStr` in `tests/providers/test_laya.py`, storage-stub override signatures in `tests/pipeline/test_media.py`); CI will fail on them.
2. **P0 product bug — approve blocks on any failed check; the design says only EDL checks block** (`review.py` `approve` gates on the first failing check of any name; `hld-lld.md:930-931` promises "approve with warnings, 422 only when an EDL check fails"). **Fix (S):** gate on `edl_valid` + `edl_covers_script` only; other failing checks stay visible warnings. Update tests + docs together.
3. **One-liners worth landing immediately (S each):**
   - `videos/router.py:58` `_RAW_PLAYBACK` += `"failed"` — a failed run currently hides the user's own recording.
   - Render the "Process with AI" panel for `status === "failed"` too (`video-screen.tsx:145`; the backend already allows starting from `failed`, `lifecycle.py:133`).
   - Map `LiveRunExists`/`VideoNotStartable` to `{code, message}` 409s and show code-specific copy ("A run is already processing this video") instead of the blanket "Could not start processing. Try again." (`runs/router.py:206`, `video-screen.tsx:233`).
   - `.gitignore`: add `backend/.langgraph_api/` (Studio pickles, must never be committed).

## 1. The review/editing screen (UX overhaul the UAT demands)

The theme: **the UI must never speak agent data classes.** `seg_02`, `block_01`, "11.0s outside 10.777..10.777" — all of it is internal vocabulary with hidden math (words ÷ 2.0 wps) the user cannot act on.

| # | Finding | Action | Size |
|---|---|---|---|
| R1 | Check messages are raw internals; "The agent flagged N things" gives no what/where/why; UI labels ("Script block 2") never match message ids (`block_01`) | Frontend map `c.name` + `ref_id` → "Script block 2 runs 11.0 s; target 10.8 s at 2 words/sec — remove about 1 word" (fix hint is mechanical: `ceil((duration − target_max) × wps)` words). Better: server-side `review` object in `ProposalView` (blocks/entries/checks with labels + fix hints; `SegContext.label` already exists and is unused) | S (FE) / M (API) |
| R2 | Un-approvable review is a dead end: only Save/Approve/Back; cancel lives on the run screen; the API trusts `action/speed/freeze_s` edits the UI never offers | (a) "Discard this plan" action reusing `POST /runs/{id}/cancel` (legal from `awaiting_review`). (b) Expose per-entry speed (1–2×) + freeze removal | S / M |
| R3 | Timeline is decorative: thin bar, tooltip-only, static legend not derived from entries, no click-to-seek despite a live player + keyframes on the same screen; multi-entry segments indistinguishable | Rebuild as interactive track: taller, keyboard-focusable, click-to-seek preview, hover card (label/action/reason), legend from entries present, two-way highlight with script blocks and "Cuts and why" | M |
| R4 | Voice choice invisible pre-render (wrong-voice renders discovered minutes later) | Render "Voice: My voice / AI voiceover" in review + run headers | S |
| R5 | Flags conflate failing checks vs run flags (`max_attempts`) with no explanation | Separate "N checks failing" from run flags; explanation map (`max_attempts` → "The agent tried 3 times and kept its best attempt") | S |
| R6 | Draft edits validate only via Save; each guess burns a proposal version | Dry-run `POST /runs/{id}/proposal/validate` (same `recheck`, no insert), debounced on draft change | S-M |
| R7 | Unsaved draft lost silently on Back | Guard navigation while `isDirty` | S |

## 2. History, retry, compare, preserve-original (the UAT feature list)

**History — API S, UI M.** No `GET /videos/{video_id}/runs` exists; the data and index (`runs(video_id, created_at desc)`) do, and `app_api` already has select on runs. Add the cursor-paginated endpoint (reuse `list_videos` pattern), then a "Processing history" section on the video page (badge, attempt, timestamps, failure stage, link to `/runs/{id}`). This also gives cancelled/stuck reviews a home.

**Retry — M.** The spec has it end-to-end (`runs.attempt` "bumped by the Retry button"; `run_transitions` already allows `failed → preprocessing/agent_running/postprocessing`; task ids `sha256(run_id:stage:attempt)` make re-enqueue idempotent). What `lifecycle.advance` doesn't cover, the endpoint must own: `finished_at = null` + `attempt = attempt + 1` + `error = null` on the way *out* of `failed`, and an explicit outbox enqueue for `pre-cpu`/`post-io` (no `_ENQUEUE` entry for those). `runs_one_live_per_video` then 409s a newer live run automatically. UI: replace "Retry is coming soon" with the button; render the process panel for `failed` videos (rides along).

**Compare + original — S API, M UI.** Sign `raw_uri` always (variadic `sign` exists; add `original_url` to `Video`), plus:
- `Cleaned | Original` toggle (or side-by-side) on the player
- "Download original" next to the share panel's "Download MP4" (needs a `response-content-disposition` option in `GcsStorage` signing)
- Proposal version compare: add `?version=N` to `GET /runs/{id}/proposal` (or a version list); `review_edits` already stores per-edit `(kind, target_id, agent_value, user_value)` diffs for a later agent-vs-user diff view.

## 3. Backend product wiring

- **`provider_calls` recorder (M).** Nothing writes the table; `build()` defaults the recorder to a no-op; `CallLog` can't carry an error. Tenancy-correct shape (spec's "own autocommit" is the only option since calls happen on threads / connectionless beats): a **sync, exception-swallowing** recorder opening a short `app_worker` connection with `autocommit`, `set_config('app.workspace_id', ...)`, insert one row (`w_pc` policy and insert grant already match). Extend `CallLog` with `error`; defer `units`/`cost_usd`. Phase 4's observability has no data source until this lands.
- **Checkpointer contradiction (M or descope).** Code ships `MemorySaver`; phase-3b's exit criterion and four doc sites promise a `PostgresSaver` in schema `lg`. Either add `AsyncPostgresSaver` + `lg.setup()` migration + kill/resume test, or rewrite the criterion and docs. Do not enter phase 4 with the contradiction.
- **Test database separation (S-M).** Tests run against the dev `avc` DB via `.env` (phantom runs in the dev library, live worker steals test jobs, today's UAT confusion). Recommended: env-override to `avc_test` + migrate + conftest fail-fast guard (`database name must end in _test`); rollback-per-test is not viable with the multi-role transaction design.
- **Error surfaces (S).** `stages._fail` leaks Python exception text to users and hardcodes `retryable=True`. Map to short user-safe messages per stage (detail stays in worker logs and `provider_calls.error` once wired); make `retryable` follow `ProviderError.retryable`.
- **RLS test cases (S).** `03_rls_tests.sql` has no cases for `provider_calls` (member-vs-stranger read, write gates, worker scope) — required by the repo's own rule once those tables become live.
- **`check_layout.py` (S).** Add the `providers/` import-direction rule promised by phase3b ("nothing under providers imports agent or pipeline").

## 4. Docs drift (one pass, S each; CLAUDE.md makes hld-lld the source of truth)

| Site | Says | Truth (code) |
|---|---|---|
| hld-lld graph note + control flow 5 | cap → END with flags | capped **script** is forced onward to `video_editor`; END only legal from the edit stage |
| hld-lld `redo_or_end`; phase3b | route to `fails[0].target` | route to a failing check whose target still has attempts |
| hld-lld mermaid + node table; phase3b | `video_editor` uses the `compare_frames` tool | no tool offered; scores ship in the body (tool-loop client doesn't exist) |
| hld-lld ×4; phases.md:91; phase3b | `PostgresSaver` in schema `lg` | `MemorySaver` only |
| hld-lld post-voice row | parallel TTS with ffprobe duration | sequential, duration from wav **payload** (placeholder-size workaround) |
| hld-lld storage layout | `voice/{block_id}.mp3` | `.wav` |
| hld-lld + phase3b checks table | length fit without tolerance | tolerates word granularity `0.5/voice_wps` |
| hld-lld `Ctx` model | max_speed/min_dur in context | `Ctx` = bundle, workspace_id, accept_threshold, max_attempts |
| hld-lld retry line | Retry button re-enqueues from stage | not implemented — land it (§2) or mark phase 4 |
| hld-lld approve table | 422 only on EDL checks | see §0.2 — align both sides |
| phase3a-architecture:61 | stage never passes `voice` | `_postprocess` passes `runs.voice` to render |
| phase3b / hld-lld | vlm_context "in parallel, under the semaphore" | sequential loop, no semaphore |
| phases.md 3a/3b exit criteria | unticked | tick against committed UAT evidence so phase 4 starts truthful |

Also fold the three environment gotchas (compose netns for >8 MiB uploads, MediaRecorder webm duration, streamed-wav placeholder sizes) into the design docs — they currently live only in compose comments and project-learnings.

## 5. Parked (phase 4 or opportunistic)

Library search only filters loaded pages and reports false "no videos" (S: server-side `q` param) · no delete for ghost `uploading` videos (M: guarded `DELETE /videos/{id}`) · "Process again" on `ready` videos (S) · graph `_RETRY` has zero backoff (revisit with the Redis bucket) · batch URL signing in `GET /videos` (already booked phase 4) · `FRONTEND_BASE_URL` default · share visibility only `link`.

---

## Suggested slice order

1. §0 gate + approve-gating fix + the four one-liners — unblocks honest CI and the worst UX moments.
2. Review screen S-batch: R1 (frontend humanization), R2a discard, R4 voice label, R5 flags, R7 draft guard — ~2 days, transforms the review experience.
3. History endpoint + video-page history section; retry endpoint + button (they share the lifecycle work).
4. Compare/original: raw signing, download, toggle; `_RAW_PLAYBACK` already fixed in §0.
5. `provider_calls` recorder; R1's server-side review object; R3 interactive timeline.
6. Test-DB separation; docs pass; RLS cases; error surfacing.
7. Commit the phase-3b tree, tick phases.md, then open phase 4.
