# BE-B: run setup (fix options, voices, run history, estimate)

Backend for the video page (`ux-post-upload.md` 4.1). Contracts C1 to C4 in [contracts.md](contracts.md). Consumer: FE-1.

## Goal

One run request carries every choice (D6), and the agent actually obeys it. The video page can list voices, past attempts and an estimate.

## Steps

### B1. Fix options, end to end (one PR; a column nobody reads is not allowed)

1. **Migration** `docs/design/sql/10_run_fix_options.sql`: `alter table runs add column fix_options jsonb not null default '{}';`. No new table, so no RLS change. Check whether `app_api` needs a column grant: `runs` inserts are granted at table level, so an insert works; no update is needed.
2. **Model** `FixOptions` in `contracts/pipeline.py` (C1). `RunCreate.fix_options: FixOptions = FixOptions()`.
3. **Store**: `lifecycle.start` takes `fix_options: FixOptions | None = None` (None = all true) and inserts it; `start_run` in `runs/router.py` passes `body.fix_options`. Existing callers need no change.
4. **Into the agent**: `AgentState` gains `fix_options: FixOptions = FixOptions()`. The agent stage in `pipeline/stages.py` reads the run's `fix_options` (next to the existing `_voice` reader) and `agent.initial_state` takes it. While there, `initial_state` also takes the run's `voice` instead of the hard-coded `"original"` (the "ponytail" comment), so AI-voice runs reach the agent as AI-voice runs. Check `MediaEngines.propose` and `FixtureEngines.propose` pass both.
5. **Agent obeys** (the agent decides inside the allowed set; code enforces the set):
   - `transcript_context`: the user message includes the allowed drop kinds (`filler` if `filler`; `false_start` and `retake` if `retakes`). Prompt line in `agent/prompts.py`: "Only propose drops of these kinds: ...".
   - `video_editor`: the body includes `allowed`: cut idle segments only if `pauses`; `speed` entries only if `slow_parts`.
   - New code check in `runs/checks.py`, `fix_options_respected(state)`: fails (target `video_editor` or `transcript_context`'s downstream writer, matching how other checks target) when a drop kind or EDL action is not allowed. Message in plain words for the agent, e.g. "Speed-ups are turned off for this run; use keep or cut." Re-run on review edits like the others: a user edit is the user's call, so the check passes for `source = "user"` proposals.
6. **Tests** (test first): `RunCreate` without `fix_options` validates to all true; the column round-trips through `GET /runs/{id}` (add `fix_options` to `Run`); the check fails on a speed entry with `slow_parts=False` and passes with it on; a graph test with fake bundle: `filler=False` and a fake transcript that returns a filler drop is routed back and does not end with that drop.
7. `npm run gen:api`.

### B2. Voices

- `shared/config.py`: a static list beside `openai_speech_voice`:
  ```python
  VOICES: tuple[VoiceOption, ...] = (
      VoiceOption(id="coral", label="Coral", hint="Warm, calm", sample_path="/voice-samples/coral.mp3"),
      VoiceOption(id="ash", label="Ash", hint="Clear, steady", sample_path="/voice-samples/ash.mp3"),
      VoiceOption(id="sage", label="Sage", hint="Neutral, crisp", sample_path="/voice-samples/sage.mp3"),
  )
  ```
  Check each id is a voice the configured OpenAI speech model accepts (`providers/openai.py`, and `docs/research/` for the voice list). Drop any that is not, and say so in the report. Keep `VoiceOption` in `runs/schemas.py`; config imports only the data it needs, so define the tuple as plain dicts in config if importing `runs` from `shared` breaks the layout check.
- `GET /voices` in `runs/router.py` -> `VoiceList` (C2), `default_voice_id = settings.openai_speech_voice`. Add it to `REQUIRED` in `scripts/export_openapi.py`.
- Sample files: `backend/scripts/make_voice_samples.py` writes `frontend/public/voice-samples/<id>.mp3` with the provider bundle's `synthesize`, one fixed sentence ("Here's how to set up a new project in under a minute."). A human runs it once with an OpenAI key and commits the files. If no key is available to you, write the script, skip running it, and report it; FE-1's voice list stays on its branch until the files exist.
- Test: route returns the list and the default.
- **Confirm R11** (show OpenAI voices now) before merging.

### B3. Run history

- `lifecycle.list_for_video(conn, video_id)`: runs newest first, limit 20, using the existing `runs(video_id, created_at)` index. Do not add `needs_you`; BE-E adds that field when spots exist.
- `GET /videos/{video_id}/runs` -> `list[RunListItem]` (C3) in `runs/router.py`; 404 via `not_found("video")` when the video is not visible. Add to `REQUIRED`.
- Tests: two runs come back newest first; another workspace's video is 404.

### B4. Estimate

- `videos/router.py` `get_video` fills `estimated_run_seconds` (C4) with one query over the workspace's last 20 `done` runs joined to their videos. Null when there are none or `duration_s` is null.
- Tests: null with no done run; with two done runs of known durations, the median rule gives the expected value.

## Exit

README section 4 checks. Report the voice ids kept and whether sample files were generated.
