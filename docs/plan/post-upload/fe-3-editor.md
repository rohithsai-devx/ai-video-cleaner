# FE-3: review editor (4.3), with spikes S1 to S6

Screen: `ux-post-upload.md` 4.3, prototype artboard **3 · Review editor** (1440 x 980; play it to see follow-along). Route `/runs/[id]/review`. Contract C7 (and C5 `original_url`, C9 player and cut-map). Backend: BE-E for nearly every element, BE-C SH1 for Original.

Files you own: `features/review/**`, `ui/media-player.tsx`, `ui/timeline.tsx`, `lib/cut-map.ts` (+ tests), `e2e/review.spec.ts`, and the spike section in `docs/research/components-post-upload.md`.

This lane can split across two agents after the spikes: agent A on 3c (player) and 3d (timeline) in `ui/` and `lib/`; agent B on 3a, 3b, 3e, 3f in `features/review/`. They meet in 3g.

## Wireframe (1440 x 980; page uses the full width, gap 12, bg canvas)

```
+------------------------------------------------------------------------------------------------+
| Stepwise / Setting up a new project  [Narration: AI voice (Coral)] [Cleaned|Original]           |
|                                          6:12 → 4:05   [3 need you]          [ Render video ]  |
+------------------------------------------------------------------------------------------------+
| LEFT PANEL (flex 1 1 340px, max 420)   | PLAYER (flex 999 1 560px; surface, rounded-2xl, p-4)  |
| Needs you 3 | Done by AI 15 | Script   |  +--------------------------------------------------+ |
|----------------------------------------|  |                                                  | |
| NOW 0:44 · Create the project · Needs  |  |          <video> 16:9, bg player                 | |
|----------------------------------------|  |   [Cleaned · AI voice]           [2× speed]      | |
| +------------------------------------+ |  |   (Original: hatched overlay "Removed in the     | |
| | 0:42 · Create the project  Playing | |  |    cleaned version · retake removed")            | |
| | The new narration runs about 4     | |  +--------------------------------------------------+ |
| | seconds longer than what is on     | |  [<5] [ > ] [5>]   0:44  of the cleaned video ·      |
| | screen here.                       | |                          skips removed parts         |
| | [Shorten the narration] [Hold the  | |                                                       |
| |  last frame 4 s] [Slow the screen  | |                                                       |
| |  to 0.7×]                          | |                                                       |
| +------------------------------------+ |                                                       |
| | 1:05 · Billing page      Decided   | |                                                       |
| | You chose: Speed it up 2× [Change] | |                                                       |
| +------------------------------------+ |                                                       |
+------------------------------------------------------------------------------------------------+
| TIMELINE (surface, rounded-2xl, px-4 py-3, overflow-x auto; min track width 900)               |
|            0:00      1:00      2:00      3:00      4:00      5:00      6:00     (ruler)         |
| Chapters  [Sign in][Create the project][Billing page .......][Invite your team ..........]    |
| Screen    |thumb|thumb|////|thumb|2×2×2×|thumb|////|thumb ... (amber outline on spots)          |
|  cuts and speed-ups                                                                            |
| AI voice  [line 1   ][line 2      ][+4 s][line 3          ] ...        (AI-voice mode only)    |
|  new narration                                                                                 |
| Your voice ▁▃▅▂▇▅▃▁ (faded where removed)        "replaced by the AI voice" (dimmed, AI mode)  |
|                 | <- playhead (danger red line, clock above)                                   |
| Legend: [////] removed  [2×] sped up  [amber] needs you  [outline] selected                    |
| Cleaned: playback jumps over removed parts · Click anything on the timeline to jump there.    |
+------------------------------------------------------------------------------------------------+
Phone (390): header wraps; player first, then the panel, then the timeline (horizontal scroll inside its box).
```

Visual rules: needs-you amber = `flag` / `flag-soft` (border 2 px `flag`), selected = 2 px ink outline + `aria-selected`, removed = `repeating-linear-gradient(45deg, line-strong 0 4px, transparent 4px 8px)` plus text in the tooltip and label, sped up = `accent-soft` tint with "{speed}×" text, overflow tail = `danger` with white "+{n} s". Clock text `font-mono tabular-nums`. Track label column 96 px, 12 px muted.

## Copy (exact, from the prototype)

- Header: "Narration: AI voice ({label})" or "Narration: my voice"; length "{before} → {after}" (`lib/clock.ts`); pill "{n} need you" / "1 needs you" (warning tone) or "All decided" (success tone); button "Render video".
- Tabs: "Needs you", "Done by AI", "Script" (counts as badges).
- Now bar: "Now", clock, chapter title, state "Kept" | "Removed" | "Sped up" | "Needs you".
- Needs-you card: "{time} · {chapter}", tag "Playing" when the playhead is inside, "Decided" when chosen; the question; fix buttons (first `primary`, others `secondary`); decided: "You chose: {fix label}" and **Change**.
- Done by AI row: type label ("Pause removed", "Filler word removed", "Retake removed", "Sped up {speed}×", "Cut", "Held last frame {s} s"), "{span}", reason, button "Undo" / "Redo".
- Player hint: Cleaned "of the cleaned video · skips removed parts"; Original "of your original recording". Overlay "Removed in the cleaned version · {type in lower case}".
- Track sublabels: Screen "cuts and speed-ups", AI voice "new narration", Your voice "removed parts shown faded" or, in AI-voice mode, "replaced by the AI voice".
- Legend hint: Cleaned "Cleaned: playback jumps over removed parts"; Original "Original: plays everything, removed parts are shaded"; then "Click anything on the timeline to jump there."
- Empty "Needs you": "Nothing needs you." Save error: "Could not save. Try again." Render confirm: "Render this version?" / "You can still share the original any time." / "Render video", "Keep editing".
- No ids anywhere (D3): never render `seg_id`, `block_id`, `spot_id` or check names.

## Steps

### Spikes first (wave 2, in parallel with FE-0; no merge to `main` except S4's files and the research notes)

| ID | Question | Done when |
|---|---|---|
| S1 | Waveform: backend peaks JSON (BE-E E5 default) vs browser decode of the 16 kHz WAV | Measured time, memory and first paint for a 15-minute WAV both ways; write the decision in `docs/research/components-post-upload.md` section 8 and tell BE-E (via the report) |
| S2 | DOM timeline at 15 minutes: about 300 segments and 120 thumbnails | Frame times while scrolling at 1x and 4x zoom; decide whether thumbnails are virtualised |
| S3 | Cleaned preview on one `<video>`: skip removed spans, play speed spans at their rate, hold-last-frame | A scratch demo (keep it in the scratchpad, not the repo) plays a cut list; record the skip latency and whether holds can be shown. Default if they cannot: the hold shows as a label "applied when rendered" |
| S4 | Cleaned / Original switch keeps position | `lib/cut-map.ts` (C9 signatures) with `cut-map.test.ts`: round trips, inside removed spans, speed spans. This merges |
| S5 | Undo / redo | A pure reducer `features/review/undo-model.ts` with tests (see 3b) |
| S6 | Timeline keyboard model in VoiceOver | Manual pass on macOS with a static prototype of 3d; notes in the research file; axe run in Playwright |

### Build (each step one PR; merge when "needs" is on main)

| Step | What | Needs |
|---|---|---|
| 3a | **Shell.** New layout in `review-screen.tsx`: header, left panel with `Tabs`, player area, timeline area. Keep the existing save (`PUT`), 409/422 handling, the dirty rule (Render disabled while dirty) and the live region for notices; move them, do not rewrite them. Script tab hosts the existing textareas for AI-voice blocks (`script-panel.tsx`). Render video = existing approve with the new confirm copy; after approve go to `/runs/{id}` (processing step 4). Switch `formatClock` imports to `lib/clock.ts`. Remove the old keyframe strip and colour bar once 3c/3d replace them (until then keep them). | FE-0 |
| 3b | **Done by AI** (`done-by-ai-panel.tsx`) from `ProposalView.changes`; Undo sets that EDL entry to `keep` with `freeze_s: 0` in the draft, Redo restores the v1 entry; header length recomputes from the draft (`review-model.ts`); saving is the existing explicit save. `undo-model.ts` reducer (S5). Session-only history. | BE-E E2 |
| 3c | **Player** `ui/media-player.tsx` (C9 props): custom transport (Play/Pause with Phosphor icons, "Back 5 seconds", "Forward 5 seconds" buttons with those `aria-label`s, clock), `<video>` without `controls`. `cleaned-preview` mode seeks over removed segments and sets `playbackRate` inside speed segments (S3); badge "{speed}×" while inside one; clock shows output time via `cut-map`. `file` mode plays as is and shows the hatched overlay inside removed segments. Keys when the player has focus: Space and K play/pause, Left/Right 5 s. Chapter marks on its progress bar. | S3, S4 |
| 3d | **Timeline** `ui/timeline.tsx` (props only): tracks as data (`{id, label, sublabel, items: {id, start, end, kind, text?, ariaLabel}[]}`), ruler, playhead `role="slider"` with `aria-valuetext` = clock (Left/Right 5 s, Shift for 1 s, Home/End), items are buttons that call `onSelect(id)` and seek, selection outline across tracks, positions as percent of duration, thumbnails `loading="lazy"` `alt=""`. Waveform as an SVG path from peaks; "Waveform not available" text when none. | S1, S2, S6 |
| 3e | **Wire the tracks** in `features/review`: chapters (`ProposalView.chapters`), screen (keyframes + changes as hatch/tint), AI voice (`script_lines`, overflow tail; only when `run.voice == "ai"`), your voice (`waveform_url` fetched once, faded where removed; dimmed with "replaced by the AI voice" in AI mode), amber outlines for `spots`. | BE-E E1, E2, E3, E4, E5 |
| 3f | **Needs you** (`needs-you-panel.tsx`) from `spots`: cards per the copy; choosing applies `fix.patch` to the draft (EDL entry or block text) and records `chosen_fixes[spot_id] = fix_id`, sent with the next save; **Change** reopens the buttons. Pill and tab count = open spots. Empty state when none. | BE-E E3 |
| 3g | **Follow-along** (`use-playback-follow.ts`): the playhead drives the now bar, the active row in the open tab (scroll with `block: "nearest"`, `behavior: "auto"` under reduced motion, checked in JS), and the "Playing" tag; reaching an open spot opens its card. Clicking any card, row or timeline item seeks there and selects it everywhere. Cleaned / Original header switch (`SegmentedControl size="sm"`): Original plays `video.original_url` in `file` mode and keeps position via `cut-map`. | 3b to 3f; Original needs BE-C SH1 |

## Render and check

README section 5. Fixture: build one `ProposalView` JSON from the demo in `ux-post-upload.md` section 5 and the prototype data (8 applied changes listed in its source, 3 spots: 0:42, 1:05, 3:34 with their fixes; 4 chapters; 372 s). Keep it at `frontend/e2e/fixtures/proposal-demo.json` and use it in unit tests and `page.route`.

- Unit: `cut-map.test.ts`, `undo-model.test.ts`, `media-player.test.tsx` (keys, labels, skip in cleaned mode with a mocked `currentTime`), `timeline.test.tsx` (slider keys, `aria-valuetext`, item buttons, selection), `review-model.test.ts` (length after undo and after a fix), `needs-you-panel.test.tsx` (default first, choose, change).
- `e2e/review.spec.ts`: tabs and counts; undo then redo changes the header length and back; choose a fix, save, reload shows "You chose"; click a timeline chapter moves the clock; Render disabled while dirty; render confirm leads to `/runs/{id}`. Screenshots at 1440 and 390, AI-voice and my-voice modes.
- Manual: VoiceOver pass on the timeline (S6 notes); play from 0:00 and watch the panel, now bar and timeline move together.
