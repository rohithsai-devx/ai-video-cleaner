# Product design: post-upload

Status: agreed 2026-10-20, prototype approved as the reference. Decisions are tracked in [../plan/pre-phase4-decisions.md](../plan/pre-phase4-decisions.md) (D4–D11). The implementation order and API contracts are in [../plan/post-upload/README.md](../plan/post-upload/README.md) and [../plan/post-upload/contracts.md](../plan/post-upload/contracts.md).

Clickable prototype (plays without sound, at 4×): https://claude.ai/artifact/Xobc3e53GfLJnLi6SJeEvu

## 1. Scope

From the moment a recording finishes uploading until the user shares a result. Out of scope: sign-in, the library, and the record screen itself, except for the one change below.

## 2. Users and jobs

- **Creator.** Records a screen walkthrough, a tutorial or a demo. Wants a clean version to share, without re-recording.
- **Plain sharer (Loom-style).** Wants to send the recording as it is, with their own voice, to colleagues or family. No AI, no waiting.

Both start on the same video page. Neither should have to understand the pipeline.

## 3. Principles

1. **No internal names.** The UI never shows ids, data-class names, check names or check math (`seg_02`, `block_01`, `max_attempts`, `10.777..10.777`).
2. **Every AI message has three parts:** the moment (timestamp plus what is on screen), what is wrong in plain words, and the fixes as buttons.
   Example: "0:42, creating the project: the new narration runs about 4 seconds longer than what is on screen. *Shorten the narration · Hold the last frame 4 s · Slow the screen to 0.7×*"
3. **The original is never changed.** Cleaning always makes a new version.
4. **The AI decides what it can.** The user is asked only about spots it cannot settle, and a skipped spot takes its first fix, so nothing blocks rendering.
5. **Every change is visible and reversible.** Each AI change can be undone, and the timeline and length update immediately.

## 4. Screens

### 4.0 Record screen (change only)

- Remove the static drawing of Chrome's share picker. Chrome shows its own.

### 4.1 Video page (after upload)

Left column:
- Player with the raw recording, title, length and resolution.
- **Share it as is (Loom mode).** Link to the raw recording, uncut, with the user's own voice. Available right away with no AI run. It keeps showing the original even if the video is cleaned later.

Right column, **Clean this video**:
- **What the AI may change.** Checkboxes, all on by default:
  - Remove long pauses
  - Remove filler words (um, uh, so, you know)
  - Remove retakes (when you restart a sentence, the last try is kept)
  - Speed up slow parts (page loads and long waits play faster)
- **Narration.** Segmented control: "Keep my voice" or "AI voice". AI voice reveals a voice list (prototype: Ava, Noah, Mira), each with "Play sample".
- **Show me before it renders.** On: the editor opens before anything renders. Off: it renders straight away, unless the AI is unsure about something, in which case it stops and asks. The helper text changes with the switch.
- **Estimate.** "About 3 minutes for a 6-minute recording."
- Primary button: **Clean this video**.

Under the player: **Past attempts**, one row per run: status (waiting for you, stopped, failed, done), when, voice, and a link to the editor or the result.

### 4.2 Processing

- Header: "Cleaning your video", with "Step 3 of 4 · about 1 minute left".
- Four steps, in the user's words:
  1. Listening to your narration. "Found what you said and when you said it."
  2. Watching your screen. "Found 4 chapters: sign in, create the project, billing, invite your team."
  3. Planning the cuts. "Choosing what to remove, speed up or keep."
  4. Getting it ready for you. "Lining every change up on the timeline."
  Each step shows done, current (with the time left) or next.
- **Found so far:** live counts of long pauses, filler words, retakes and slow page loads, plus the chapters with timestamps.
- Footer: "Stop cleaning" and "You can close this tab. We'll keep going and the library shows progress."
- **Ready:** "Ready for you. Nothing renders until you approve." Banner: "18 changes ready. 15 are applied already. 3 need your call." and **Open the editor**.
- **Failed:** "Cleaning stopped." "Step 3 of 4 didn't finish." The recording is safe. **Try again** restarts from the failed step.
- No technical log is shown anywhere on this screen.

### 4.3 Review editor

Layout: header across the top; left panel; player; multi-track timeline across the bottom.

**Header**
- Narration in use: "AI voice (Ava)" or "my voice".
- Cleaned / Original switch.
- Length before and after, live: `6:12 → 4:05`.
- Pill: "3 need you" (amber) or "All decided" (green).
- **Render video**, which goes to Share.

**Timeline** (all tracks share the original recording's time axis)
- **Chapters.**
- **Screen:** thumbnails. Removed parts are hatched. Sped-up parts are tinted and labelled 2×.
- **AI voice:** one clip per script line. A clip that runs longer than its screen time shows a red "+4 s" tail. Shown only in AI-voice mode.
- **Your voice:** waveform. Removed parts are faded. In AI-voice mode the track is dimmed and labelled "replaced by the AI voice".
- **Needs you:** amber outlines on the screen track.
- **Selection:** the selected item is outlined across all tracks.
- **Playhead:** a red line, with the clock above.
- Legend below the timeline. Hint: "Click anything on the timeline to jump there."

**Left panel**
- **Needs you (N).** Only the spots the AI could not settle. Each card shows the time, the chapter, a plain-language question and fix buttons. The first fix is the default. A decided card shows "You chose: …" and **Change**.
- **Done by AI (N).** Every applied change: type (Pause removed, Filler word removed, Retake removed, Sped up 2×, Cut), time, a one-line reason, and **Undo** or **Redo**. Undo updates the timeline and the length right away.
- **Script.** In AI-voice mode: the lines the AI voice will say, editable. In my-voice mode: what the user said, with removed words struck through.
- **Now bar** above the list: clock, chapter, and state (Kept, Removed, Sped up, Needs you).

**Playback**
- Play/pause, back and forward 5 seconds, and a clock.
- The picture, the caption and the playhead move together. The caption shows the line being spoken.
- The open tab highlights the current item and scrolls to keep it in view. A "Needs you" card opens its fixes when playback reaches it.
- **Cleaned:** jumps over removed parts, plays sped-up parts at 2× with a badge, and the clock counts cleaned time.
- **Original:** plays everything. Removed parts are hatched, with the reason ("Removed in the cleaned version · retake removed").
- **Click to jump:** any suggestion, change or timeline region moves the playhead there and highlights it.

### 4.4 Done and share

- **One player, two versions.** The Cleaned / Original switch loads either full version, with its own length, progress bar and chapter marks. Original is the uncut recording with the user's own voice.
- **What changed:** time saved (6:12 → 4:05, 2:07 shorter), pauses removed, retakes removed, waits sped up.
- Narration used, and how many spots were the user's call.
- **Share card per version** (cleaned video, original recording). Each has its own link, **Copy** (which turns to "Copied"), **Play this version**, and a download (MP4 for cleaned, original file for the original).
- Link: **Clean again with other settings**. Edit and re-render is out of scope until the backend supports reopening a completed run.

## 5. Demo content used in the prototype

The prototype is a fixed scenario, so the same numbers appear everywhere:

- Recording: "Setting up a new project", 6:12, 1920 × 1080.
- Chapters: Sign in (0:00), Create the project (0:31), Billing page (1:05), Invite your team (2:40).
- Applied by AI (15): 6 pauses, 3 filler words, 3 retakes, 2 sped-up waits, 1 cut at the end.
- Needs you (3):
  - 0:42, the narration is 4 s longer than the screen. Fixes: shorten the narration, hold the last frame 4 s, slow the screen to 0.7×.
  - 1:05, 15 s with nothing said on the billing page. Fixes: add a line, speed it up 2×, cut it.
  - 3:34, "Acme Cloud" vs "the app". Fixes: use "Acme Cloud", keep "the app".
- Final length: 4:05 cleaned.

The sample script and the voice names are placeholders. The screen is drawn, not footage.

## 6. States

| Screen | Empty / loading | Error | Done / ready |
|---|---|---|---|
| Video page | Player shows the poster and "Video is not available yet" | "Could not load this video." | Past attempts list shows the latest run |
| Processing | Step list with "Next" on every step | Plain message, recording is safe, **Try again** | "Ready for you" with the banner |
| Editor | "Needs you" tab empty: "Nothing needs you." | "Could not save. Try again." | "All decided" pill |
| Done | Share card shows the link once ready | Download unavailable: says so and offers Try again | Both cards live |

Empty and error copy above is a proposal; check it against the real failure cases when the backend is planned.

## 7. What this asks of the backend

The backend implementation and API shapes are defined in the post-upload workstream plan.

- One run-creation payload with every preference: which fixes are allowed, narration mode and voice, review first or not.
- A voice list with sample audio.
- A share link and download for the raw recording, with no run behind it.
- A run history per video.
- Retry from a failed run.
- Proposal data shaped as the editor needs it:
  - changes split into applied and needs-you, each with a time range, a plain-language reason and a list of fixes;
  - chapters;
  - script lines with timings;
  - undo and redo per change;
  - chosen fixes.
- Live processing counts (pauses, filler words, retakes, slow loads, chapters) in progress events.
- User-safe failure messages with a step name the UI can show.

## 8. Open questions

- Is a voice sample generated per voice, or pre-recorded?
- Does "Share it as is" need a passcode or expiry, or is it the same link model as cleaned videos?
- What is the maximum recording length for a Loom-style share, given the current 15-minute limit?
- Should Undo on an AI change survive a page reload, or is it per session?
