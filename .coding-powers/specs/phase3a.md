# Phase 3a — pre and post, code only

Source: `docs/plan/phases.md` § Phase 3a. No model calls. Do not commit.

## Seams

`Engines` in `backend/app/pipeline/engines.py` stays the port. `stages.py` owns transactions and status moves. Engines only compute. `FixtureEngines` stays for existing tests and `FAKE_WORKER`. New code lives in `backend/app/pipeline/`. Tests in `backend/tests/pipeline/`.

## Pure functions (no ffmpeg, no database)

`timeline.fit_timeline(entries, contexts, audio_s_by_block, *, narration: bool) -> list[EDLEntry]`

Per entry with a `block_id`, target is that block's audio seconds. Cuts are copied through. For a kept span: if longer than the target and `cuttable`, shorten `src` from the end down to `min_dur`. If still longer and not `narration`, set `speed` to `min(max_speed, span / target)` (max 2). If still shorter than the target, set `freeze_s` to the gap. Never speed narration. Never exceed `max_speed`. Leave an entry alone when limits cannot hit the target.

Worked results (src starts at 0, `max_speed` 2):

| span | min | cuttable | audio | narration | src end | speed | freeze |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 2 | yes | 4 | no | 4 | 1 | 0 |
| 4 | 2 | yes | 7 | no | 4 | 1 | 3 |
| 10 | 6 | yes | 4 | no | 6 | 1.5 | 0 |
| 4 | 4 | no | 1 | no | 4 | 2 | 0 |
| 10 | 6 | yes | 4 | yes | 6 | 1 | 0 |

`segment.segment(frames, *, end_s, epsilon=0.3, min_s=2, max_s=15) -> list[Segment]`

Cut at 0, at `end_s`, and at each frame with `diff > epsilon`. A frame at exactly a boundary belongs to the later segment. Merge a piece shorter than `min_s` into its predecessor (into its successor if it is first). Split a piece longer than `max_s`. `active` when the max `diff` of frames in `[start, end)` exceeds `epsilon`.

Worked: `end_s=5`, frames `(t, diff)` = (0, 0), (1, 0.1), (2, 0.9), (3, 0.1), (4, 0.1), (5, 0). Segments `[0, 2)` inactive and `[2, 5]` active.

`words.stub_words(duration) -> list[Word]`

One `Word(w="word", start=i, end=i+0.5)` for each integer `i` in `range(int(duration))`. If `duration < 1`, one word from 0 to `duration`.

`proposal_stub.stub_proposal(run, pre) -> AgentOutput`

One `SegContext` per real segment (`by="code"`, `cuttable=segment.active`, `min_dur=min(2, length)` but not below 0.3, `max_dur=length`, `max_speed=2`). One script block over every segment. Edit plan keeps each segment at speed 1 and freeze 0. `edl_valid` against `pre.duration` passes. Empty segments become one segment covering `[0, duration]`.

## Media (ffmpeg binary, no Python wrapper)

`media.py` is the only module that execs `ffprobe` and `ffmpeg`. `MediaEngines.preprocess` probes first and raises `RecordingTooLong` when duration exceeds `MAX_RECORDING_SECONDS` (900). Then transcode to mezzanine H.264 MP4 (source fps) and mono 16 kHz WAV, sample 1 fps plus frames whose scene score spikes, replace the poster with one chosen frame, `segment` on scene changes, `stub_words`, upload to the fixed keys, return `PreprocessResult`. The second stage transaction sets `videos.duration_s` to the probed duration.

`MediaEngines.propose` calls `stub_proposal`.

`MediaEngines.render` writes the object before returning. Original voice cuts the real WAV. AI voice writes a silent clip of the script's estimated duration (`voice_stub` inside `media.py`). `fit_timeline` then ffmpeg trim / `setpts` / freeze / concat / mux. Keys: `runs/{id}/pre/mezz.mp4`, `audio.wav`, `frames/{frame_id}.jpg`, `runs/{id}/post/v{version}/final.mp4` and `poster.jpg`.

Download the raw object to a temp file, run ffmpeg, upload the outputs with a file upload on `GcsStorage` (do not read a long MP4 into memory).

## Transactions

ffmpeg must not run while the run row is locked. For `pre-cpu` and `post-io` only:

1. Short transaction: advance `queued → preprocessing` or `approved → postprocessing`, commit.
2. Engine runs with no database connection.
3. Short transaction: write `runs.pre` or the output row, advance, commit.

A redelivery whose run is already `preprocessing` or `postprocessing` continues at step 2. `done`, `failed`, and `cancelled` are no-ops. The agent stage stays one transaction (`FixtureEngines` tests must keep passing).

The relay must not set `outbox.sent_at` until `handle` returns. Hold a session advisory lock for that row so a second relay skips it. A killed process drops the lock and leaves `sent_at` null, so the next poll redelivers. Fixed GCS paths make the rerun an overwrite.

## Process

`FAKE_WORKER` keeps `FixtureEngines` (Playwright and the current pytest suite). A compose service `worker` (`python:3.12-slim` plus the ffmpeg apt package) runs `python -m app.pipeline.worker`, which calls `run_in_process` with `MediaEngines`. CI installs ffmpeg before pytest. A media test skips when `ffmpeg` is not on `PATH`.

## Out of scope

Providers, LangGraph, real transcription, ElevenLabs, OpenCV, Cloud Tasks, commits, pushes.
