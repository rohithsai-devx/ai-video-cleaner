# Phase 3 UAT — agent, before phase 4

Follow [local agent setup](../setup/local-agent.md) first. Record results in the sheet at the bottom. One sitting, about 45 minutes. Use Chrome. Keep each clip under two minutes.

This is a pass/fail for the live path. It is not a test of a faithful transcript. Preprocess stores the token `word` once per second. The agent writes from that, plus Gemma's description of the frames.

## Tell live from canned

The canned plan (`FAKE_WORKER=true`) always says "quarterly report" and "Reports tab". If you see that text, stop. The API is still on the fixture worker.

A live run's script is about the screen Gemma described, and the only spoken token it is allowed to keep is `word`. A normal sentence fails the clean-only check, the writer is sent back, and after three tries the run is flagged `max_attempts`.

## Clip

Record one window, not the whole desktop. Change the screen twice (open a page, then another) so there is more than one segment. Say a sentence out loud so you can later confirm the transcript ignored it. Stop. Wait until the upload says Uploaded. Open the video.

## S1 — Review, your voice

1. Voice: **My voice**. Mode: **Let me review first**. Click **Process with AI**.
2. Stay on the progress screen until it leaves "Cleaning up your video".
3. Open the review.

Pass:

- Status becomes `awaiting_review`, or `failed` with a provider error you can read.
- The script is not the quarterly-report fixture.
- The Mac agent terminal shows calls. The Docker worker terminal shows ffmpeg, then goes quiet during the agent step.
- Keyframes are frames from this recording.

Fail:

- The run stays `queued` for more than a minute. A queue has no consumer. Check the media worker and the Mac agent.
- Vision errors with an empty Gemma URL. Set `GEMMA_BASE_URL` and start a new run.
- Chat errors on the OpenAI key. Fix the key and start a new run.

Write down `flags` and whether the script is only the word `word`. Expect `max_attempts` if the model wrote a real sentence. That flag means the checks did their job against the stub transcript. It is not a pass for "the clean matches what I said."

## S2 — Approve and play

From the S1 review:

1. If the script is only `word` and the checks on screen are green, click **Approve and render**. Confirm.
2. If a check is red, edit the failing block so every word is `word`, the block still covers its segment, and **Save edits** first. Then approve. Saving is required; Approve stays disabled while edits are dirty.
3. Wait until the video is ready. Play it. Open the share link in a private window.

Pass:

- The player shows a cut of your recording, not a black file and not the untouched upload if the plan removed a span.
- Audio is your voice, cut with the picture.
- The share link plays without signing in.

Fail:

- Approve returns an error that names `edl_valid` or `edl_covers_script` after you saved a plan the review already showed as passing. That is a product bug. Copy the message.
- The file never leaves postprocessing. Read the Docker worker log.

## S3 — AI voice

New recording, same shape as the clip above. Voice: **AI voiceover**. Mode: **Let me review first**. Repeat S1 and S2.

Pass:

- The rendered audio is a spoken voice, not your mic and not silence.
- Voice is the default `coral` unless you set `OPENAI_SPEECH_VOICE`.

Known limit, not a fail of S3: the graph still checks the script as if the voice were yours, so clean-only still rejects any token other than `word`. The AI toggle changes the render, not that check.

## S4 — Auto

New short clip, under 30 seconds. Voice: **My voice**. Mode: **Render automatically**.

Pass, either outcome:

- The run reaches `done` without the review screen, and the video plays. This happens only when the agent accepted the plan.
- The run stops on review and shows `max_attempts` or another flag. Auto must not render a plan the agent refused.

Fail: auto renders a run whose review later shows a failed check or `max_attempts`.

## S5 — Kill the agent (expected gap)

Start S1 again. When the Mac agent is inside the script step, Ctrl-C that process. Wait 10 seconds. Start it again:

```bash
cd backend
uv run python -m app.pipeline.mac_agent
```

Expected today: the run does not continue from a saved graph checkpoint. It may re-run the agent from the start or sit until you cancel it. Postgres resume is not built. Record what you saw. Do not file it as a new bug, and do not treat a green S1–S4 as this scenario passing.

## Do not start phase 4 on this alone

Phase 4 is deploy, Cloud Tasks, and load. Start it only after S1–S4 pass on a live worker, with notes for the gaps below.

Still open after a green sheet:

- Real transcript, pause cuts, and a script that uses your words.
- Graph voice follows the AI toggle inside the checks.
- A killed agent resumes from Postgres.
- Gemma frames are real image bytes. `gs://` frame addresses are passed through as URLs.
- `accept_threshold` 0.7 is not calibrated. Laya may clamp extreme temperatures.

## Result sheet

| Id | Pass/Fail | Status you saw | Notes |
| --- | --- | --- | --- |
| Setup | | | `FAKE_WORKER`, both workers, Gemma URL |
| S1 | | | flags, first script line |
| S2 | | | play and share |
| S3 | | | heard a voice / silence / your mic |
| S4 | | | done, or stopped on review |
| S5 | | | expected gap |
