# BE-E: editor data (changes, needs-you spots, chapters, script lines, waveform, progress)

Backend and agent work behind the review editor (4.3), the processing screen's "found so far" and ready banner (4.2), and the done screen's "What changed" (4.4). Contracts C7 and C8 in [contracts.md](contracts.md). Consumers: FE-2, FE-3, FE-4.

This is the largest backend lane. Its steps are independent of each other except E3 after E2, so one agent can do them in order, or two agents can split E1 to E3 and E4 to E6.

Read first: `contracts/pipeline.py`, `runs/schemas.py` (`ProposalView`), `runs/router.py` (`get_proposal`, `update_proposal`, `_view`), `runs/review.py`, `runs/checks.py`, `agent/agent.py`, `agent/nodes/*`, `agent/prompts.py`, `pipeline/stages.py` (agent stage), `pipeline/media_engines.py`, `pipeline/media.py` (`preprocess`, `_fit_entries`), `pipeline/timeline.py`, `shared/events.py`, and `01_schema.sql` (`proposals`, `review_edits`).

## Principles for this lane

- The agent decides; code checks only mechanical things (README section 4). Labels and grouping come from the agent's own output, not from heuristics.
- Every user-facing string the agent writes (reasons, questions, fix labels, chapter titles) is plain language with no ids or check names (D3, design principle 1). A code check enforces the "no ids" part mechanically.
- Derived fields (`changes`, `chapters`, `script_lines`) are computed from the stored proposal on each read in pure functions, so a user edit returns fresh values with no extra storage.

## Steps

### E1. Chapters

- `Step` gains `title: str = ""`: one to four words, a chapter name. `TRANSCRIPT_CONTEXT` prompt asks for it. The default keeps old rows valid.
- `runs/chapters.py` (new, pure): `chapters(proposal) -> list[Chapter]`: one per step in time order; `title` = `step.title` or, when empty, the first four words of `summary`; `start` = `span[0]`; `end` = the next step's start, or the last step's `span[1]`.
- `_view` fills `ProposalView.chapters`.
- Tests: ordering, the empty-title fallback, end of the last chapter.

### E2. Applied changes ("Done by AI")

- `runs/changes.py` (new, pure): `changes(agent_v1: Proposal, latest: Proposal) -> list[Change]`.
  - One `Change` per v1 EDL entry whose action is not `keep`, or whose `freeze_s > 0`. `change_id = seg_id`.
  - `kind`: `speed` for action `speed`; `hold` for `freeze_s > 0`; for `cut`: the kind of the transcript drop that overlaps the entry's `src` (`filler` -> `filler`, `false_start` or `retake` -> `retake`), else `pause` when the segment's `SegContext.by == "code"` (idle), else `cut`.
  - `reason`: the overlapping drop's `reason` if any, else the entry's `reasoning`.
  - `undone`: the same `seg_id` is `keep` with `freeze_s == 0` in `latest`.
  - Drops with no overlapping cut give no change (they change nothing on screen).
- `_view` loads version 1 and the latest, and fills `ProposalView.changes`. `lifecycle`/`review` already load proposals; add a loader for version 1 if none exists.
- **Plain reasons check** in `runs/checks.py`: `reasons_plain(state)` fails, targeting the node that wrote the text, when any `EDLEntry.reasoning`, `Drop.reason`, `Step.title` or spot text matches `\b(seg|block|step|frame)_\w+\b` or contains a check name. Message to the agent: "Write reasons for the viewer, without ids." Prompts for `video_editor` and `transcript_context` say reasons are shown to the user as one short plain sentence.
- Tests: one fixture proposal produces each kind once; a drop with no cut yields nothing; undo detection; the check fails on "Cut seg_02".

### E3. Needs-you spots and fixes

The agent already ends with failed checks when it hits the attempt cap (`accepted = false`). Today those become `flags` (strings). They become spots the user can settle.

1. **Migration** `docs/design/sql/09_spots_fix_chosen.sql`:
   ```sql
   alter type edit_kind add value 'fix_chosen';
   alter table proposals add column spots jsonb not null default '[]';
   ```
   The new enum value cannot be used in the same transaction, so nothing else in the file uses it. Check the grants in `02_rls.sql`: the worker inserts proposals; confirm a column added to `proposals` is covered by the existing table-level insert grant, and add a column grant in this file if not. `EditKind` in `contracts/enums.py` gains `"fix_chosen"` last (P's parser reads 09).
2. **Models**: `Spot`, `Fix`, `FixPatch` (C7) in `contracts/pipeline.py`. `Proposal.spots: list[Spot] = []` (the stored shape has `chosen_fix_id = None`). `AgentState.spots: list[Spot] = []`.
3. **Agent node** `agent/nodes/spot_writer.py`: when the orchestrator would end with `accepted = false` (and only then), it routes to `spot_writer` once, then to `END`. `spot_writer` makes one structured call: input = the failed checks, the script, the edit plan and the segment labels; output = `list[Spot]`, each with a plain question, the moment it is about, and two or three fixes ordered best first, each a concrete patch (an EDL entry change, or replacement block text the agent writes). Fix ids and spot ids are generated in code, not by the model.
4. **Mechanical validation** in code after the call: each patch names an existing `seg_id` or `block_id`; `speed` within `MAX_SPEED`; `freeze_s` >= 0. Drop an invalid fix; drop a spot left with no fix and keep its check in `flags` as today. Do not re-run the full checks on each fix (the agent decides).
5. **Store**: the agent stage writes `spots` into the v1 insert. `update_proposal` copies `spots` from the previous version into the new one.
6. **Chosen fixes**: `ProposalUpdate.chosen_fixes` (C7). `update_proposal` writes one `review_edits` row per entry (`kind = 'fix_chosen'`, `target_id = spot_id`, `user_value = {"fix_id": ..., "by": "user"}`), against the new version. `_view` sets each spot's `chosen_fix_id` and `chosen_by` from the run's latest `fix_chosen` row per spot.
7. **Approve applies defaults** (D9): in `review.approve`, before advancing, when any spot is open, apply each open spot's `fixes[0].patch` to the latest proposal, save it as version n+1 (`source = 'user'`, the user approved it), record `fix_chosen` rows with `"by": "default"`, then approve that version. Same transaction.
8. **Auto mode**: in the agent stage (`pipeline/stages.py`), `approved = run.mode == "auto" and out.accepted and not out.spots`.
9. `RunListItem.needs_you` (C3): count of open spots on the latest proposal, in `lifecycle.list_for_video` (BE-B's function; add the count there).
10. Tests: graph test with a fake bundle that fails a check until the cap -> one spot with fixes; invalid patch dropped; save with `chosen_fixes` writes the row and `GET` shows `chosen_fix_id`; approve with an open spot renders the default fix; auto run with spots stops at review.

### E4. Script lines (AI-voice mode)

- `runs/script_lines.py` (new, pure): for AI-voice runs, one `ScriptLine` per block: `start` = where the block's first kept segment starts on the source timeline, `end` = `start + est_dur`, `overflow_s = max(0, est_dur - kept screen time of the block's segments)`. Reuse the rule in `pipeline/timeline.py` (`fit_timeline`) and `media._fit_entries` instead of writing a second one: if they need inputs only render has, extract the pure part into `timeline.py` and call it from both.
- Original-voice runs return `[]`.
- Test: a block longer than its screen time has the matching `overflow_s`; `_fit_entries` behaviour unchanged (existing tests pass).

### E5. Waveform peaks (check spike S1's result in `docs/research/components-post-upload.md` first)

- In `media.preprocess`, after the WAV exists: compute peaks at 50 per second (absolute max per window, normalised to 0..1) with ffmpeg or numpy from the 16 kHz WAV; write `{"rate": 50, "peaks": [...]}` to GCS next to the WAV, **then** return it on `PreprocessResult.peaks_uri: str | None = None` (the row comes after the object).
- `_view` signs it into `ProposalView.waveform_url` (null when `peaks_uri` is null, as for old runs).
- If S1 chose browser decoding, skip E5 and report it.
- Test: a generated 2-second sine WAV gives 100 peaks near 1.0.

### E6. Live progress events

- `RunProgressEvent` (C8) in `contracts/events.py`; add it to the `RunEvent` union so it appears in OpenAPI; event name `run.progress`.
- In `MediaEngines.propose`, run the graph with `stream(..., stream_mode="updates")` (or add a callback to `agent.invoke`) and, after each `vlm_context`, `transcript_context` or `video_editor` update, compute the totals from the state so far (pauses = idle cuts in the edit plan, filler and retakes from drops, slow parts = speed entries, chapters from steps) and `shared.events.publish(run_id, "run.progress", event)`. Publishing is best effort and outside any transaction. Keep the final return value the same.
- Test: with a fake bundle, the published events end with the same totals as the proposal's changes.

## Exit

README section 4 checks. Regenerate OpenAPI and TS types after each step that changes a model. Report which of E1 to E6 merged.
