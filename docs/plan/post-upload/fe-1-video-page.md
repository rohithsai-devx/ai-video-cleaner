# FE-1: record screen fix and video page (4.0, 4.1)

Screens: `ux-post-upload.md` 4.0 and 4.1, prototype artboard **1 · After upload**. Route `/videos/[id]` while the video is not `ready`, and at `ready` with `?clean=1` (FE-4 decides which screen the route shows). Contracts C1 to C4, C9. Backend: BE-B. The raw share card inside the page is FE-4's.

Files you own: `features/videos/**`, `features/recorder/**`, `e2e/record.spec.ts`, `e2e/video-page.spec.ts` (new). You may also update selectors in other `e2e/*.spec.ts` files that use copy you rename ("Process with AI", "Let me review first", "My voice", "AI voiceover"); change only the selector strings.

## Wireframe (1440 wide; `main` max-width 1280, px-6 py-8, flex-wrap gap-8)

```
+------------------------------------------------------------------------------------------+
| Stepwise / Library / Setting up a new project                         (app header, as is) |
+------------------------------------------------------------------------------------------+
|  LEFT  (flex 999 1 560px)                              |  RIGHT aside (flex 1 1 380px)    |
|  +--------------------------------------------------+  |  bg surface, border line,        |
|  |                                                  |  |  rounded-3xl, p-7, gap-6         |
|  |            <video> 16:9, bg player,              |  |                                  |
|  |            rounded-[20px], poster                |  |  Clean this video        (h2 28) |
|  |                                                  |  |  Pick what the AI may change.    |
|  +--------------------------------------------------+  |  You'll see every change on a    |
|  Setting up a new project (h1 26)  [Original recording] |  timeline before anything is     |
|                                      6:12 · 1920 × 1080 |  final.                          |
|  Your recording is saved as it is. Cleaning makes a    |                                  |
|  new version and never changes this one.               |  THE AI WILL (legend 13 muted)   |
|                                                        |  [x] Remove long pauses          |
|  +--------------------------------------------------+  |      Silences over a second, ... |
|  | renderShare slot: FE-4's "Share it as is" card   |  |  [x] Remove filler words         |
|  +--------------------------------------------------+  |      um, uh, so, you know        |
|                                                        |  [x] Remove retakes              |
|  +--------------------------------------------------+  |      When you restart a ...      |
|  | Past attempts                         (h2 16)    |  |  [x] Speed up slow parts         |
|  |--------------------------------------------------|  |      Page loads and long waits...|
|  | [Waiting for you] Yesterday, 4:10 PM · My voice  |  |                                  |
|  |                   · 3 to check      Open editor  |  |  NARRATION                       |
|  |--------------------------------------------------|  |  [ Keep my voice |  AI voice  ]  |
|  | [Stopped] Yesterday, 3:52 PM · AI voice          |  |  Your own audio, with the cut    |
|  |           · you cancelled it      No video made  |  |  parts removed. Nothing is ...   |
|  +--------------------------------------------------+  |   (AI voice: intro + voice rows) |
|                                                        |  (o) Coral  Warm, calm [Play...] |
|                                                        |                                  |
|                                                        |  +----------------------------+  |
|                                                        |  | (o ) Show me before it     |  |
|                                                        |  |      renders  <hint>       |  |
|                                                        |  +----------------------------+  |
|                                                        |  [######  Clean this video  ###] |
|                                                        |   About 3 minutes for a 6-minute |
|                                                        |   recording.                     |
+------------------------------------------------------------------------------------------+
Phone (390): one column in this order: player, title line, note, share card, past attempts, Clean aside.
```

## Copy (exact)

- Intro: "Pick what the AI may change. You'll see every change on a timeline before anything is final."
- Legend "The AI will"; checkboxes and hints as in the wireframe: "Remove long pauses" / "Silences over a second, while nothing changes on screen"; "Remove filler words" / "um, uh, so, you know"; "Remove retakes" / "When you restart a sentence, it keeps the last try"; "Speed up slow parts" / "Page loads and long waits play faster".
- Narration: "Keep my voice" with "Your own audio, with the cut parts removed. Nothing is re-recorded."; "AI voice" with "The AI writes a clean script from what you said and reads it out. You can edit every line first."
- Switch "Show me before it renders". Hint on: "You get the editor with every change marked. Nothing renders until you say so." Off: "Renders straight away. If the AI is unsure about something, it stops and asks you first."
- Button "Clean this video". Estimate "About {N} minutes for a {M}-minute recording." (N = `ceil(estimated_run_seconds / 60)`, M = `round(duration_s / 60)`, singular "minute" when 1).
- Note under the title: "Your recording is saved as it is. Cleaning makes a new version and never changes this one."
- Empty player: "Video is not available yet". Load error: "Could not load this video."

## Steps (one PR each; each merges when its "needs" is on main)

| Step | What | Needs |
|---|---|---|
| 1a | **Record screen (4.0):** delete the static "What Chrome shows next" `aside` in `record-screen.tsx`; keep the flex row intact. Update `e2e/record.spec.ts` if it looks for the panel. | nothing |
| 1b | **Layout and existing controls:** the wireframe layout; title line with the "Original recording" pill (`Badge` neutral) and "6:12 · 1920 × 1080" (`font-mono`, hidden when width/height are null); the note; Clean panel heading and intro; narration with `SegmentedControl` (replaces the inline radios); the `Switch` mapped to `mode` (on = `review`, off = `auto`; default on), replacing `MODES` and its fieldset; button text "Clean this video". Move the `renderShare` slot into the left column under the note and give it the C9 `ShareSlot` signature (pass `status`, `title`, `originalUrl` once BE-C adds it, null until then). `VideoWithShare` keeps rendering `SharePanel` for now; FE-4 replaces it. | FE-0 |
| 1c | **Fix checkboxes:** four `Checkbox`es, all on; `run-request.ts` sends `fix_options`. | BE-B B1 |
| 1d | **Voice list:** when "AI voice" is picked, `useQuery` `GET /voices`; `RadioGroup` rows with label, hint and a "Play sample" button that plays `sample_path` with one shared `Audio` element ("Stop" while playing; `aria-label` "Play a sample of {label}"). Initial pick = `default_voice_id`; the start button is disabled while voice is `ai` and the list has not loaded. Delete the `VOICES` placeholder and the `<select>`. | BE-B B2 and the sample files |
| 1e | **Past attempts** (`features/videos/past-attempts.tsx`): `GET /videos/{id}/runs`; hide the section when the list is empty. Row: status `Badge` + "{when} · {My voice | AI voice}" + action. Labels and tones: `awaiting_review` "Waiting for you" (warning) -> link "Open editor" (`/runs/{id}/review`); `queued`, `preprocessing`, `agent_running`, `approved`, `postprocessing` "In progress" (accent) -> "See progress" (`/runs/{id}`); `done` "Done" (success) -> "Watch" (this page) when it is `current_run`, else text "Replaced by a newer version"; `failed` "Failed" (danger) -> "See what happened" (`/runs/{id}`); `cancelled` "Stopped" (neutral) -> text "No video made". When: `Intl.DateTimeFormat` relative day ("Today", "Yesterday", or the date) plus time. | BE-B B3 |
| 1f | "· {n} to check" on waiting rows. | BE-E E3 (`needs_you`) |
| 1g | **Estimate line**, hidden while `estimated_run_seconds` is null. | BE-B B4 |

## Render and check

Follow README section 5. Fixtures: the demo video from `ux-post-upload.md` section 5 ("Setting up a new project", 372 s, 1920 x 1080); two past runs as in the wireframe; voices from contracts C2.

- `e2e/video-page.spec.ts`: switch hint text changes on toggle; unchecking a box sends `fix_options` with that field false (assert the request body with `page.waitForRequest`); AI voice shows the list and the start request carries the chosen `voice_id`; past attempts labels and links per status (`page.route` for `GET /videos/{id}/runs`); estimate hidden for null. Screenshots at 1440 and 390 for the default state and AI-voice state.
- Unit: `run-request.test.ts` (fix options and voice), `past-attempts.test.tsx` (label and link per status), `video-screen.test.tsx` updated.
- Manual: tab through the Clean panel in order, every control reachable and labelled.
