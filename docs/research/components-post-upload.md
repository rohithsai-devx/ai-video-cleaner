# Components for the post-upload screens

Status: research, 2026-10-20. Read-only on code. Source of truth for screens: [../design/ux-post-upload.md](../design/ux-post-upload.md) (sections 4.1 to 4.4). Decisions D4 to D11: [../plan/pre-phase4-decisions.md](../plan/pre-phase4-decisions.md).

## Summary

- **Reuse as-is:** `Button`, `Badge`, `Skeleton`, `ConfirmDialog`, `cx`, the run cancel flow, the proposal save/approve flow. Roughly a third of the rows.
- **Extract from existing code:** the segmented control (currently inline in `video-screen.tsx`), the share card (`share-panel.tsx`), the stepper (`run-screen.tsx`), the script textareas and "Keep instead" toggles (`review-screen.tsx`).
- **New, custom, no dependency:** checkbox, radio group with sample play, switch, banner, empty state, media player shell, timeline, needs-you and done-by-AI cards, undo/redo model, now bar.
- **One new dependency recommended:** `@radix-ui/react-tabs` 1.2.1 for the tabbed side panel (roving focus and ARIA wiring). Alternative: custom tabs (about 60 lines). Everything else is native HTML or custom.
- **Timeline: custom.** No library fits a read-only, click-to-seek, multi-track overlay timeline driven by our own clock. Details in section 4.
- **Waveform: real, not decorative.** The backend has the audio (`audio_uri`, 16 kHz mono WAV) but the API does not serve any peaks. This is a backend ask (spike S1).
- **Four backend gaps block the editor and processing screens:** chapters, script line timings, live "found so far" counts, and waveform peaks. Plus three endpoints not in the generated client: retry, past attempts per video, voice samples. See section 5.
- **Structural constraint:** `frontend/scripts/check-layout.mjs` allows only six feature folders (`auth, videos, recorder, runs, review, shares`) and forbids cross-feature imports and `ui/` importing `api/`. The player and timeline must be generic `ui/` components (props only), and time-mapping logic goes in `lib/` or is passed in.

## 1. Repo facts used (verified by reading)

| Fact | Source |
|---|---|
| React 19.3.1, Next 16.4.2, TanStack Query 5.104.4, Tailwind 4.3.3, Phosphor 2.1.10, Vitest 5.0.5, Playwright 1.64.1, jsdom 30.1.3 | `frontend/package.json` |
| No headless UI or media library is installed. Only Phosphor, TanStack Query, openapi-fetch and openapi-react-query are runtime deps | `frontend/package.json` |
| Tokens (`canvas, surface, sunken, line, line-strong, ink, muted, faint, accent, success, warning, danger, flag, player`), radii `xl/2xl/3xl`, reduced-motion global rule | `frontend/src/app/globals.css` lines 3-71 |
| `:focus-visible` outline is global | `frontend/src/app/globals.css` lines 56-59 |
| Primitives: `Button` (5 variants, min-h 44px), `Badge` (5 tones), `Field`, `Panel`, `Skeleton` (pulse, `aria-hidden`), `ConfirmDialog` (native `<dialog>`, Escape cancels, focus returns to opener), `cx` | `frontend/src/ui/*.tsx`, `frontend/src/ui/cx.ts` |
| `ui/` may import only `ui/` and `lib/`; `lib/` only `lib/` and `api/`; features cannot import each other or `app/`; no `index.ts` barrels; feature names fixed | `frontend/scripts/check-layout.mjs` lines 9-10, 55-66 |
| Vitest uses jsdom with jest-dom matchers | `frontend/vitest.config.mts`, `frontend/vitest.setup.ts` |
| E2E specs exist for auth, library, progress, record, review, share | `frontend/e2e/*.spec.ts` |
| Native radio groups with sr-only inputs already used for "Let me review first" and "My voice / AI voiceover" | `frontend/src/features/videos/video-screen.tsx` lines 156-209; `frontend/src/features/shares/share-panel.tsx` lines 58-80 |
| Voice picker is a `<select>` over a single stub voice (`default`) | `frontend/src/features/videos/video-screen.tsx` lines 16, 215-226 |
| Run stepper: `<ol>` with `aria-current="step"`, states done/active/failed/todo, 5 steps | `frontend/src/features/runs/run-screen.tsx` lines 117-168; `frontend/src/features/runs/run-progress.ts` lines 28-87 |
| Run screen shows an activity log (`role="log"`) and "Retry is coming soon" | `frontend/src/features/runs/run-screen.tsx` lines 259-271, 199-201 |
| Review screen: native `<video controls>`, keyframe strip (`<img>` per frame), colour bar timeline with legend, per-cut "Keep instead" toggle with `aria-pressed`, script `<textarea>` per block | `frontend/src/features/review/review-screen.tsx` lines 242-393 |
| Review model: draft = edited texts + `kept` flags; `effectiveEntries`, `outputLength`, `formatClock`, `spanLabel`, `actionLabel` are pure functions | `frontend/src/features/review/review-model.ts` |
| Share panel: visibility radio (only "link" offered), expiry select, create, read-only link input, Copy with `copied / failed` state in `aria-live`, download `<a download>` | `frontend/src/features/shares/share-panel.tsx`; `share-options.ts` lines 4-8 |
| Video status to badge mapping is at video level only (`statusBadge`, `videoHref`); no run-level mapping exists | `frontend/src/features/videos/video-status.ts` |
| SSE run events: `run.status`, `run.proposal_ready`, `run.done`, `run.failed` only; no progress counts | `frontend/src/features/runs/run-progress.ts` lines 15-26, `use-run-events.ts` |
| Generated API paths: `/runs/{run_id}`, `/approve`, `/cancel`, `/events`, `/proposal`, `/videos`, `/videos/{video_id}`, `/videos/{video_id}/runs`, `/videos/{video_id}/shares`, `/videos/{video_id}/uploaded`, `/s/{slug}`, `/me`, auth | `frontend/src/api/generated/schema.d.ts` lines 7-247 |
| Proposal view has `keyframes` (`KeyframeThumb`); no chapters, word timings, peaks or voice list | `frontend/src/api/generated/schema.d.ts` (ProposalView, KeyframeThumb) |
| Backend internals that exist but are not served: `Word {w,start,end}`, `Keyframe {frame_id,t,uri,diff}`, `audio_uri` (16 kHz mono WAV), `transcript_ctx` | `docs/design/hld-lld.md` lines 198, 221, 810-819 |
| Keyframes are sampled at a 1 fps baseline plus diff spikes | `docs/design/hld-lld.md` line 200 |
| Phosphor names used in the design exist in the installed `dist/index.d.ts` (checked by text match, not by compiling) | `frontend/node_modules/@phosphor-icons/react/dist/index.d.ts` |

## 2. Library versions checked (npm registry, 2026-10-20)

| Package | Version | Peer React | Last published | License | Note |
|---|---|---|---|---|---|
| `@radix-ui/react-tabs` | 1.2.1 | ^16.8 to ^19 | 2026-10-14 | MIT | Unstyled, ARIA tabs |
| `@radix-ui/react-radio-group` | 1.5.1 | ^16.8 to ^19 | not checked | MIT | Not recommended (native radios suffice) |
| `@radix-ui/react-switch` | 1.4.1 | ^16.8 to ^19 | not checked | MIT | Optional for the switch |
| `react-aria-components` | 1.22.1 | ^16.8 to ^19 rc | 2026-10-09 | Apache-2.0 | Single package covering tabs, switch, radio, checkbox, slider, toolbar, tooltip. Only worth it if we add many headless widgets |
| `@base-ui/react` | 1.9.0 | ^17 to ^19 (also needs `date-fns` peer) | 2026-10-09 | MIT | Extra peer, not recommended |
| `@vidstack/react` | 1.15.7 | ^18 to ^19 | 2026-10-06 | MIT | Full player UI, rejected (section 3) |
| `media-chrome` | 4.19.3 | web components | 2026-10-19 | MIT | Rejected (section 3) |
| `wavesurfer.js` | 8.0.3 | n/a | 2026-10-19 | BSD-3 | Waveform engine; optional (section 4) |
| `@wavesurfer/react` | 1.0.12 | ^18.2 or ^19 | 2025-12-04 | BSD-3 | Needs `wavesurfer.js >= 7.7.14`; stale (last publish Dec 2025) |
| `@xzdarcy/react-timeline-editor` | 1.0.0 | >=18 | 2026-01-25 | MIT | Depends on `interactjs` and `react-virtualized`. Edit-oriented. Rejected (section 4) |
| `konva` / `react-konva` | 10.9.0 / 19.3.2 | react-konva peers `^19.3.0` | 2026-10-15 | MIT | Canvas. Rejected (section 4) |

Not verified: whether any of these render correctly under Tailwind 4 in this app (no spike was run). Peer ranges were read from the registry, not from a test install. Maintenance judgement is from publish dates only, not from issue trackers.

## 3. Inventory

Key: **Reuse** = existing component as-is. **Extract** = existing code to lift into `ui/` or the feature. **Change** = existing component needs changes. **New** = no component. Build column names the choice. Section column is the design section.

### 3.1 Video page (4.1), `features/videos`

| Element | Sec | Existing component | Build | Reason | Risk / a11y |
|---|---|---|---|---|---|
| Player with raw recording, title, length, resolution | 4.1 | `features/videos/video-screen.tsx` lines 98-124 (native `<video controls>`, title, Badge, duration/size/fps line) | Reuse; keep native controls here | Native controls are enough for the raw recording. The custom player is only needed in the editor (row 3.3) | Native controls are keyboard-accessible already. Poster fallback text exists |
| Share it as is (Loom mode) card | 4.1 | `features/shares/share-panel.tsx` (create, copy, download) | Change: generalise into `ShareCard` (row 3.4). Backend: share with no run | Share panel only renders for `status === "ready"` (video-screen line 146). Raw recording must be shareable at status `uploaded` | Needs backend endpoint (not in generated schema) |
| "What the AI may change" checkboxes (4 items, all on) | 4.1 | none | New: `ui/checkbox.tsx` (native `input type=checkbox`, label, optional description via `aria-describedby`) | Native input gives keyboard and state for free. Four labelled options with helper text | Helper text must be linked with `aria-describedby`. Do not nest in a `<label>` with a button |
| Narration segmented control: "Keep my voice" / "AI voice" | 4.1 | `video-screen.tsx` lines 181-209 (inline sr-only radios, class-based active state) | Extract to `ui/segmented-control.tsx` (native radio group, arrow keys native) | Same pattern already used twice (lines 156-179 and 181-209) | Use `fieldset` + `legend`. Radios stay in DOM (sr-only), so arrow keys and screen readers work natively |
| Voice list with "Play sample" per voice | 4.1 | `video-screen.tsx` lines 215-226 (`<select>`, one stub voice) | New: `ui/radio-group.tsx` items plus a sibling "Play sample" `Button` (not inside the label). Audio via one shared `<audio>` element | Design asks for a radio list with a play action per item. The `<select>` cannot hold a per-item button | Keep "Play sample" outside the `<label>`. `aria-label="Play sample of Ava"`. Only one sample plays at a time. Stop on unmount. Sample URLs are a backend ask (design section 8) |
| "Show me before it renders" switch and changing helper text | 4.1 | none | New: `ui/switch.tsx` (`button role="switch" aria-checked`, label, helper text in `aria-describedby`). Alternative: `@radix-ui/react-switch` 1.4.1 | Native checkbox styled as switch is awkward. A `role=switch` button is ~30 lines and needs no dependency | Space and Enter toggle. Helper text changes with state; do not put it in a live region (it would announce on every toggle). Knob transition is covered by the global reduced-motion rule (`globals.css` lines 62-70) |
| Estimate line "About 3 minutes for a 6-minute recording" | 4.1 | none | New: text in `video-screen.tsx`. The estimate formula comes from the backend or a constant | The number is a product claim, not derivable in the UI. Mark as open | Plain text, no a11y issue. Source of the number is unverified |
| "Clean this video" primary button | 4.1 | `ui/button.tsx` `variant="primary"`, used in `video-screen.tsx` line 236 | Reuse | Matches existing primary CTA with `Sparkle` icon | Disabled state already set. Keep `min-h-11` |
| Past attempts list (one row per run: status, when, voice, link) | 4.1 | none (only `statusBadge` for videos) | New: rows in `features/videos`, status Badge from a new run-status mapping function (`waiting for you / stopped / failed / done`) | No run-level status label exists. `video-status.ts` maps video status only | Needs backend endpoint for runs per video (not in generated schema; `/videos/{video_id}/runs` is listed, method unverified). Use a `<ul>` with a link per row |
| Video status Badge | 4.1 | `ui/badge.tsx`, `features/videos/video-status.ts` `statusBadge` | Reuse | Already maps all seven video statuses to tones | Badge is a `span`; text carries the meaning, not colour alone |
| Empty and error copy on video page | 4.1, 6 | `video-screen.tsx` line 92-94 (`role="alert"`), line 109-119 ("Video is not available yet") | Reuse text; see row 3.5 for empty state component | Matches design section 6 | Good already |

### 3.2 Processing (4.2), `features/runs`

| Element | Sec | Existing component | Build | Reason | Risk / a11y |
|---|---|---|---|---|---|
| Header "Cleaning your video" with "Step 3 of 4 · about 1 minute left" | 4.2 | `features/runs/run-screen.tsx` lines 55-76 (headline and sub), line 107 `h1 aria-live="polite"` | Change: copy and step model. Replace "Step N of 5" with "Step N of 4" and add time-left from backend | Step count and copy differ from current code. No ETA field exists in the Run schema | `aria-live` on the h1 announces every change. Consider a separate, less chatty region for the step line |
| Four steps in user words, each done / current / next / failed | 4.2 | `run-screen.tsx` lines 117-168 (`ol`, `aria-current="step"`, colour states, sr-only suffix) | Change, then extract to `ui/stepper.tsx` (generic: label, detail, state) | The list and states are right. The step definitions in `run-progress.ts` (lines 28-87) are 5 internal stages with internal wording | Keep `aria-current`. Add visible text for "next" and "current" so state is not colour alone |
| Step detail lines ("Found 4 chapters: ...") | 4.2 | `run-screen.tsx` line 164 (`detail` text) | Reuse the slot; detail text needs live data | Detail carries the plain-language findings | Depends on backend progress payload (section 5) |
| "Found so far" live counters (pauses, filler, retakes, slow loads) and chapters with timestamps | 4.2 | none | New: `features/runs/found-so-far.tsx`, tabular numbers, fed by SSE progress events | Not in the event types (`run-progress.ts` lines 15-26 handle four events only) | Backend ask. Do not announce every counter tick: no live region on the counts, or a throttled one |
| Footer "Stop cleaning" with confirm | 4.2 | `run-screen.tsx` lines 205-214 (Cancel run button), 224-239 (`ConfirmDialog`) | Reuse with copy change ("Stop cleaning", description: "Nothing is rendered"). Existing mutation and refetch stay | Behaviour matches. Only copy differs | `ui/confirm-dialog.tsx` has tests (`confirm-dialog.test.tsx`) and Escape handling |
| Footer "You can close this tab. We'll keep going..." | 4.2 | `run-screen.tsx` lines 272-274 | Reuse text (copy tweak) | Already present with the same meaning | None |
| Ready state: "Ready for you. Nothing renders until you approve." and banner "18 changes ready..." + "Open the editor" | 4.2 | `run-screen.tsx` lines 170-185 (accent block with `Link`) | Change: copy, counts, and use the Banner primitive (row 3.5) | The block exists, but its copy uses the flag count, not the change count the design asks for | Counts come from the proposal (applied vs needs-you). Needs a backend shape (section 5) |
| Failed state: "Cleaning stopped." + "Step 3 of 4 didn't finish." + **Try again** | 4.2 | `run-screen.tsx` lines 187-203 (`role="alert"`, "Retry is coming soon") | Change: replace the text with a `Button` that calls retry. Copy: "Recording is safe" | Retry is not implemented. Current text is a placeholder | Needs a retry endpoint (not in generated schema). Keep `role="alert"` |
| Activity log (`role="log"`, monospace) | 4.2 (removed) | `run-screen.tsx` lines 259-271 | Remove. Design D7 and section 4.2 say no technical log | Principle 1 forbids internal names; the log shows `run.status preprocessing / ...` | Removing the log also removes the "Live" indicator dependency. Keep the `useRunEvents` hook |
| Live pill ("Live") | 4.2 | `run-screen.tsx` lines 252-257 | Keep or drop; not in design | Not listed in design | None |
| Review-mode and auto-mode label | 4.2 | `run-screen.tsx` lines 111-114 | Drop from this screen | Not in the design. "Auto mode" is internal wording | None |
| Skeleton while loading | 4.2, 6 | `run-screen.tsx` lines 98-102; `ui/skeleton.tsx` | Reuse | Matches "Step list with Next on every step" loading state | Skeleton is `aria-hidden`; the page h1 says "Loading..." |

### 3.3 Review editor (4.3), `features/review`

| Element | Sec | Existing component | Build | Reason | Risk / a11y |
|---|---|---|---|---|---|
| Header: narration in use ("AI voice (Ava)" or "my voice") | 4.3 | `review-screen.tsx` lines 144-154 (title and version) | Change: add narration label (from video/run) | Narration is set on the video page, not shown here yet | None |
| Cleaned / Original switch | 4.3, 4.4 | none in editor | Reuse `ui/segmented-control.tsx` (row 3.1) | Same control as narration | Keyboard and radio semantics as in row 3.1 |
| Length before and after live: `6:12 → 4:05` | 4.3 | `review-screen.tsx` lines 156-160 (`formatClock(total)` to `formatClock(outputLength)`) | Change: arrow glyph and `aria-live` only on the number, not every second | Logic exists in `review-model.ts` (`outputLength`, `entryLength`) | Use `tabular-nums`. Announce only on approve or undo |
| Pill "3 need you" (amber) / "All decided" (green) | 4.3 | `ui/badge.tsx` tones `warning` and `success` | Reuse `Badge` | Tones exist and map to the two states | Text states the meaning, not colour alone |
| "Render video" primary, leads to Share | 4.3 | `review-screen.tsx` lines 161-168 ("Approve and render" with `ConfirmDialog`) | Change label and copy. Keep `ConfirmDialog` and `approve` mutation | Behaviour exists. Label and destination differ (design: Share, not run page) | Approve is blocked while dirty (`disabled={dirty}`). Keep that rule |
| Player: picture, caption overlay, removed-part overlay, speed badge, clock, chapter marks on progress bar | 4.3, 4.4 | `review-screen.tsx` lines 258-270 (native `<video controls>`) | New: `ui/media-player.tsx`, props only (src, duration, `segments` as `{start,end,kind,label}`, chapters, caption text). Custom controls over a `<video>` without the `controls` attribute | Cleaned skipping, speed badge and removed overlay need our own clock. No library knows our EDL | Keyboard: Space and K toggle, Left and Right seek 5 s, focus must be on the player region. Captions: visible overlay only, script panel carries the full text. Speed badge text, not colour alone |
| Transport: play/pause, back and forward 5 s, clock | 4.3 | none (native controls only) | New, inside `ui/media-player.tsx`. Phosphor `Play`, `Pause`; text labels "5" for back and forward (not `Rewind` or `FastForward`, which imply 10 s) | Custom buttons needed for the 5 s step and the clock | Each button needs `aria-label` ("Back 5 seconds"). Clock is plain text, not a live region |
| Multi-track timeline (chapters, screen, AI voice, your voice, needs-you, selection, playhead, legend) | 4.3 | `review-screen.tsx` lines 272-299 (one colour bar with legend, `role="img"`) | New: custom in `ui/timeline.tsx` (generic) with tracks as props. Details in section 4 | No library fits (section 4) | Playhead as `role="slider"` with `aria-valuetext` (clock). Click and keys to seek. Each item is a `button` |
| Time ruler | 4.3 | none | New, part of timeline | Positions as percent of duration | Decorative, `aria-hidden` |
| Chapter track | 4.3 | none | New, part of timeline; data from backend (section 5) | Chapters are not in the API | Labels are buttons that seek |
| Screen track with thumbnails, hatched removed parts, tinted "2×" sped-up parts | 4.3 | `review-screen.tsx` lines 242-254 (keyframe `<img>` strip, `alt="Frame at ..."`) | New, part of timeline. Reuse `KeyframeThumb` data | Keyframes exist (1 fps baseline plus spikes, `hld-lld.md` line 200). Current strip is a flat row | Thumbnails `loading="lazy"`, `alt=""` (decorative) inside tracks. Hatch pattern via CSS `repeating-linear-gradient` |
| AI voice track: one clip per script line, red "+4 s" tail, dimmed in my-voice mode | 4.3 | none | New, part of timeline. Needs script line timings (section 5) | Not in API | Red tail needs text label, not colour alone |
| Your voice track: waveform, removed parts faded | 4.3 | none | New SVG waveform inside timeline (see row 3.5 and spike S1) | Real peaks needed | Decorative fallback is not acceptable per product intent; show "Waveform not available" text if peaks are missing |
| Needs-you amber outlines, selection outline across tracks | 4.3 | `review-screen.tsx` line 316 (amber border on flagged rows) | New CSS overlay in timeline | Pattern exists for flagged rows only | Selection must not rely on colour alone: use a 2 px outline plus `aria-selected` on items |
| Legend below timeline + hint "Click anything on the timeline to jump there" | 4.3 | `review-screen.tsx` lines 288-298 (legend `ul`) | Reuse pattern (LEGEND array) | Same idea, new entries | Legend icons `aria-hidden` |
| Tooltip per timeline item | 4.3 | `review-screen.tsx` line 282 (`title` attribute) | Reuse `title` for v1; custom popover later if needed | Native title is enough for v1 and keeps dependencies at zero | `title` is not keyboard-triggered; expose the same text as `aria-label` on the item |
| Left panel tabs: Needs you (N), Done by AI (N), Script | 4.3 | none (review screen is one column of stacked sections, `review-screen.tsx` lines 186-397) | New: `@radix-ui/react-tabs` 1.2.1 (recommended) or custom | Tabs need roving focus, `aria-controls`, Home and End. Radix provides these unstyled | Keep inactive panels mounted if they hold local state (`forceMount`). Radix adds one dependency; alternative is ~60 lines of custom code |
| Scroll-into-view of active item and open-on-playback | 4.3 | none | New hook `useScrollIntoView` in `features/review` | Needed for "tab highlights and scrolls" | Use `block: "nearest"`. Use `behavior: "auto"` when `matchMedia("(prefers-reduced-motion: reduce)")` matches. The CSS `scroll-behavior` override (`globals.css` line 69) does not apply to a JS `behavior: "smooth"` call, so check the media query in JS |
| "Needs you" card: time, chapter, plain question, fix buttons, first fix default | 4.3 | `review-screen.tsx` lines 219-240 (flagged `role="status"` section, `FlaggedTag` lines 402-408) | New card in `features/review`. Fix buttons use `Button` variants (primary for default, secondary others) | Flags exist as failed checks only (`review-model.ts` `failedProposalChecks`). Card with fix choices is new data shape | Fix buttons as a `group` with `aria-label` naming the spot. Decided card "You chose: ..." as text. Change button `aria-label` includes the spot |
| "Done by AI" card: type, time, reason, Undo / Redo | 4.3 | `review-screen.tsx` lines 325-340 ("Keep instead" with `aria-pressed`) is the only undo-like toggle | New card plus undo model (section 4, spike S5). Model in `features/review/` as a pure reducer with tests | Design asks undo and redo per change with immediate timeline update | Button label changes ("Undo" to "Redo"); announce result in the existing `aria-live` notice region (`review-screen.tsx` line 187) |
| Script panel: editable AI lines, my-voice lines with struck-through removed words | 4.3 | `review-screen.tsx` lines 350-393 (textarea per block, `readOnly` when not editable, `htmlFor` label) | Change: add struck-through view for my-voice mode (new `<s>` spans from word data) | Edit path exists. Struck-through view needs word timings (section 5) | Textarea labels present. Keep `readOnly` (not `disabled`) so text remains readable |
| Now bar above the list: clock, chapter, state | 4.3 | none | New, derived from playhead | Pure derived view | Clock text not in a live region; state text is enough |
| Error and save notices ("Could not save. Try again.") | 4.3, 6 | `review-screen.tsx` lines 186-209 (`aria-live` container, notice, failure list) | Reuse pattern; move to `ui/banner.tsx` (row 3.5) | Logic is complete (409 and 422 handling, lines 97-137) | Keep `aria-live="polite"` |
| Keyframes strip in editor | 4.3 | `review-screen.tsx` lines 242-254 | Replace with screen track (above) | Duplicates the timeline | Remove strip once screen track exists |

### 3.4 Done and share (4.4), `features/shares`

| Element | Sec | Existing component | Build | Reason | Risk / a11y |
|---|---|---|---|---|---|
| One player, two versions (Cleaned / Original switch, own progress bar and chapter marks) | 4.4 | `video-screen.tsx` native player; new `ui/media-player.tsx` (row 3.3) | Build on the same player. Switch via `ui/segmented-control.tsx` | One component serves editor and done screen | On switch, keep the playhead position mapped through the cut list (spike S3). Two MP4s, so the swap reloads the source |
| "What changed": time saved, pauses removed, retakes removed, waits sped up, narration used, user's-call count | 4.4 | none | New: `features/shares/what-changed.tsx`, a `dl` list of stats | Stats derived from proposal. `review-model.ts` has lengths | Use `dl`/`dt`/`dd` for label-value pairs |
| Share card per version: own link, Copy (then "Copied"), Play this version, download | 4.4 | `features/shares/share-panel.tsx` lines 51-145 (link input, Copy with `copied / failed` state in `aria-live`, download `<a download>`) | Change: extract `ShareCard` and render two (cleaned, original). Drop expiry and visibility controls from the card | Visibility is already limited to "link" (`share-options.ts` lines 4-8). Expiry is not in the design (section 8 open question) | Copy state text already announced politely (`aria-live="polite"`, line 124). Keep the fallback that selects the input on copy failure |
| Download: MP4 for cleaned, original file for the original | 4.4 | `share-panel.tsx` lines 134-142 (`<a download>`) | Reuse pattern | Link works with signed URLs | Fallback when unavailable: text and "Try again" (design section 6). Needs backend URL for original |
| Links: "Edit and re-render", "Clean again with other settings" | 4.4 | none | Reuse `Link` styled as secondary (same class as `run-screen.tsx` lines 216-221) | Simple text links | Keep visible focus ring (global `:focus-visible`) |

### 3.5 Shared and system pieces

| Element | Sec | Existing component | Build | Reason | Risk / a11y |
|---|---|---|---|---|---|
| Status badge | all | `ui/badge.tsx` | Reuse | Five tones cover all uses | Not interactive |
| Pill ("3 need you") | 4.3 | `ui/badge.tsx` | Reuse (Badge is a pill already, `rounded-full`) | Same look | None |
| Banner / alert (info and error, with optional action) | 4.2, 4.3, 6 | none. Inline patterns in `review-screen.tsx` lines 187-209 and `run-screen.tsx` lines 170-203 | New: `ui/banner.tsx` (tones info, warning, danger, success; `role` prop; optional action slot) | Same pattern appears in three places | `role="alert"` for errors (already used), `role="status"` for info. Action is a real button |
| Empty state ("Nothing needs you.") | 4.3, 6 | none. Text only: `video-screen.tsx` line 92-94 | New: `ui/empty-state.tsx` (text, optional action) | Used in several places | Plain text inside a `p`, no icon-only meaning |
| Skeleton | 4.2, 4.3 | `ui/skeleton.tsx` | Reuse | Pulses and respects reduced motion (`motion-reduce:animate-none`) | `aria-hidden` by design |
| Confirm dialog (Approve and render, Stop cleaning, Cancel run) | 4.2, 4.3 | `ui/confirm-dialog.tsx` | Reuse | Native `<dialog>`, Escape cancels, focus returns to opener, has tests | Danger variant exists |
| Icons | all | `@phosphor-icons/react` 2.1.10 (installed) | Reuse. Names needed: Play, Pause, Copy, DownloadSimple, Sparkle, SpeakerHigh, Waveform, Scissors, ArrowUUpLeft, ArrowArcLeft, ArrowCounterClockwise, Timer, FilmStrip, ArrowsOut, Gauge, ListChecks, CaretDown, ClockCounterClockwise | Names confirmed present in `dist/index.d.ts` (text match) | Icons `aria-hidden` (existing pattern). Icon-only buttons need `aria-label` |
| Segmented control | 4.1, 4.3, 4.4 | inline in `video-screen.tsx` and `share-panel.tsx` (radios) | New shared `ui/segmented-control.tsx`, extracted | Three uses | Native radio group keeps arrow keys. Visible focus via `has-[:focus-visible]` pattern already used |
| Checkbox list with helper text | 4.1 | none | New `ui/checkbox.tsx` | Four uses in one screen | As row 3.1 |
| Radio group with per-item action | 4.1 | none | New `ui/radio-group.tsx` (native radios, sibling action button) | Voice list | As row 3.1 |
| Switch | 4.1 | none | New `ui/switch.tsx` | One use, reusable | As row 3.1 |
| Stepper | 4.2 | `run-screen.tsx` inline `ol` | Extract to `ui/stepper.tsx` | Only one use today; extraction is for testability | `aria-current` on active step |
| Timeline | 4.3 | none | New `ui/timeline.tsx` | Editor only | Section 4 |
| Media player | 4.3, 4.4 | native `<video>` in two places | New `ui/media-player.tsx` | Two screens | Section 3.3 |

## 4. Multi-track timeline, waveform and tabs: custom vs library

### 4.1 Timeline: build custom

Recommendation: custom, in `ui/timeline.tsx`, built from absolutely positioned `div`s with positions as percentages of duration. Tracks are rows with a fixed label column. The playhead and item clicks write to the same clock as the player.

Why not a library:

- `@xzdarcy/react-timeline-editor` 1.0.0 (MIT, last publish 2026-01-25) is built for editing clips: drag, resize and action rows via `interactjs`, with `react-virtualized` underneath. We need a read-only overlay timeline with click-to-seek, hatched removed spans, and a second time axis we do not own (the recording). Its data model (actions with `start`/`end` on rows) would fit clips but not overlays or the playhead contract. Its last publish is about nine months old at the time of checking. Not recommended. Not verified: its React 19 behaviour.
- `konva` 10.9.0 / `react-konva` 19.3.2 draw on canvas. Keyboard and screen reader support would have to be rebuilt with an overlay of DOM elements. More code than the DOM approach for the same result. Not recommended.
- `wavesurfer.js` 8.0.3 has a timeline plugin and waveform, but it owns the media element and its own playback. Our player is driven by a skip-aware clock. Use it only as an optional waveform renderer (spike S1), not as the timeline.

Accessibility spec for the custom timeline:

- Playhead: `role="slider"`, `aria-valuemin=0`, `aria-valuemax=duration`, `aria-valuenow=currentTime`, `aria-valuetext` = clock. Keys: Left and Right 5 s, Shift for 1 s, Home and End.
- Items (chapters, cuts, speed spans, needs-you spans): `button` elements with `aria-label` describing the span and action. Click seeks and selects. Enter and Space do the same.
- Tracks: `role="group"` with `aria-label` ("Screen", "AI voice", "Your voice", "Chapters").
- Decorative elements (ruler ticks, thumbnail images, waveform path): `aria-hidden`.
- Colour is never the only signal: removed = hatch, sped-up = "2×" label, needs-you = outline plus text.
- Reduced motion: no animated playhead transitions; the global rule already sets transition durations to 0.01 ms.

### 4.2 Waveform: real, from backend peaks

The design calls for a waveform on the "Your voice" track, faded where removed. A decorative bar pattern would misrepresent the audio and would not show where the speech is. The app already produces a 16 kHz mono WAV (`audio_uri`, `hld-lld.md` line 198 and 221). Options:

1. **Preferred:** the backend computes peaks (for example min/max per 100 ms) during `pre-cpu` and serves them with the proposal or video payload. About 6,000 pairs for a 10-minute recording, small JSON. The frontend draws an SVG path.
2. **Fallback to test:** decode the WAV in the browser with the Web Audio API (`AudioContext.decodeAudioData`) and compute peaks. Works without backend change, but downloads the full WAV and decodes on the main thread. Spike S1 measures this.
3. **Library:** `wavesurfer.js` 8.0.3 can draw from precomputed `peaks`. It would add a dependency for a path we can draw in about 40 lines. Not recommended unless interactivity is needed.

Until real peaks exist, show "Waveform not available" text, not decorative bars.

### 4.3 Tabs: one dependency

`@radix-ui/react-tabs` 1.2.1 (peer React ^19) gives `role=tablist`, `aria-controls`, roving tabindex and Home and End. Unstyled, so it uses our tokens. Alternative: custom, about 60 lines with the same ARIA. Choose Radix if we want the behaviour tested by someone else; choose custom if the dependency count is the priority. If we add more headless widgets later, `react-aria-components` 1.22.1 covers tabs, switch, radio, checkbox, slider and tooltip in one package.

### 4.4 Media player: custom over native video

Custom over `<video>` without `controls`. Reasons: cleaned mode must skip spans and play others at 2×, which needs our clock and our span list; the removed overlay, caption and chapter marks are ours; a library player would draw its own control bar on top of ours.

- `media-chrome` 4.19.3 (web components, MIT): styled by CSS parts and variables that would fight our tokens; no span-skipping model.
- `@vidstack/react` 1.15.7 (MIT, React 19 peer): full player UI and larger bundle; same span-skipping gap.

Recommendation: no player library. Spike S3 covers skip and freeze behaviour (see below).

## 5. Backend gaps that block screens (the UI cannot build these without data)

These are not frontend work. Listed so the UI is built against the right shapes. The design already lists most of them in section 7.

| Need | Screen | Current state |
|---|---|---|
| Chapters with timestamps and titles | 4.2, 4.3 chapter track | Not in generated schema (`schema.d.ts`) or HLD API |
| Script line timings (start, end, per block) | 4.3 AI voice track, caption overlay | `est_dur` and `target_min/max` per block only; no absolute start |
| Word timings for captions and struck-through words | 4.3 script view, caption overlay | `Word {w,start,end}` exists in backend model (`hld-lld.md` line 810) but is not served |
| Waveform peaks | 4.3 your-voice track | Not served; `audio_uri` exists internally |
| Live "found so far" counts and chapters | 4.2 | SSE events are `run.status`, `run.proposal_ready`, `run.done`, `run.failed` only |
| Applied vs needs-you split with fixes and per-change undo data | 4.3, 4.2 banner | `flags` is a string list; `checks` are failed checks, not fix options |
| Retry from failed step | 4.2 | No endpoint in generated schema; run screen says "Retry is coming soon" |
| Past attempts per video | 4.1 | Path `/videos/{video_id}/runs` listed; GET not verified |
| Voice list and sample audio | 4.1 | `voice_id` is a string; no list endpoint |
| Share link for the raw recording with no run | 4.1, 4.4 | `/videos/{video_id}/shares` exists; not verified for status `uploaded` |
| Original-file download URL | 4.4 | Not verified |

Note: the frontend generated client (`src/api/generated/schema.d.ts`) is the only source checked here. `backend/openapi.json` was not read.

## 6. Components that already exist and are reusable as-is

- `frontend/src/ui/button.tsx`: primary, secondary, ghost, accent, danger. Min height 44 px. Use for every button in the design.
- `frontend/src/ui/badge.tsx`: five tones. Use for status and the "need you" / "All decided" pill.
- `frontend/src/ui/skeleton.tsx`: pulse, `aria-hidden`, reduced-motion safe.
- `frontend/src/ui/confirm-dialog.tsx`: Stop cleaning, Approve and render, Cancel run. Has tests.
- `frontend/src/ui/cx.ts`.
- `frontend/src/features/review/review-model.ts`: `formatClock`, `outputLength`, `entryLength`, `spanLabel`, `actionLabel`, `effectiveEntries`, `toUpdate`, `conflictCode`, `failingChecks`. Pure, tested (`review-model.test.ts`).
- `frontend/src/features/runs/use-run-events.ts`: SSE hook with reconnect. Keep for live state; only the log rendering goes.
- `frontend/src/features/videos/video-status.ts`: `statusBadge`, `videoHref`, `formatDuration`.
- Run cancel flow, approve flow with 409 and 422 handling (`run-screen.tsx` lines 26-46, 224-244; `review-screen.tsx` lines 65-137).

## 7. Components that exist but need changes

| File | Change |
|---|---|
| `frontend/src/features/videos/video-screen.tsx` | Replace voice `<select>` with a radio list and sample play; add checkboxes, switch, estimate and "Clean" options; move segmented control to `ui/`; add past attempts list; share card for raw recording at `uploaded` status |
| `frontend/src/features/runs/run-screen.tsx` | Four steps and "Step N of 4" copy; remove activity log and "Live" pill; add found-so-far block; real retry button; stop-cleaning copy; ready banner with counts |
| `frontend/src/features/runs/run-progress.ts` | `buildSteps` returns four user-language steps, not five internal ones; add progress-count reducer for new SSE events |
| `frontend/src/features/review/review-screen.tsx` | Becomes the editor: custom player and timeline, left tabs (needs you / done by AI / script), undo/redo, Render video label, remove keyframe strip and flat colour bar |
| `frontend/src/features/review/review-model.ts` | Add undo/redo history reducer and needs-you / done-by-AI grouping (pure, testable). Keep existing exports |
| `frontend/src/features/shares/share-panel.tsx` | Extract `ShareCard`; render one per version; remove expiry select from the card (or keep behind open question 2); keep copy state and download |
| `frontend/src/features/shares/share-options.ts` | Expiry and visibility options: only needed if the card keeps them. Visibility is already restricted to "link" |
| `frontend/src/app/(app)/videos/[id]/video-with-share.tsx` | Compose with the new share card; keep feature isolation (composition in `app/`) |
| `frontend/src/features/runs/run-screen.tsx` error copy | Remove `run.status.replace("_", " ")`-style raw status text if present in review (see `review-screen.tsx` line 201: "This run is awaiting review, so the proposal is read-only" shows internal status words) |

Principle check (design section 3.1): `review-screen.tsx` line 201 and `run-progress.ts` lines 89-102 (`logLine`) show internal stage and status text. Both must go or be replaced.

## 8. Spikes (no good component option, or unverified behaviour)

| ID | Question | Why a spike | Done when |
|---|---|---|---|
| S1 | Real waveform: backend peaks vs browser decode of WAV | Size, time to first paint and memory for a 15-minute recording (the current maximum per design section 8). Decide backend or browser | Measured numbers for both paths on a 15-minute WAV; decision recorded in HLD |
| S2 | Timeline performance at 15 minutes | About 300 segments, about 120 thumbnails, zoom and scroll at 60 fps in a custom DOM timeline | Frame times measured; decide whether to virtualise thumbnails |
| S3 | Cleaned playback: skip, 2×, and "hold last frame" | The `<video>` element cannot freeze a frame by seeking or playbackRate. "Hold 4 s" needs a pause-and-wait or a pre-rendered version. Also seek latency at cut boundaries (`timeupdate` fires about 4 times a second) | A demo plays a cut list in the browser; hold behaviour chosen (approximate in-browser hold, or show cleaned only after render) |
| S4 | Switching Cleaned and Original keeps position | Two different MP4s; the playhead must map through the cut list | Mapping function in `lib/` with tests |
| S5 | Undo and redo across tabs and timeline | Session-only per design open question 4. Need a reducer over changes and an invariant (undo restores timeline and length) | Reducer with tests; decision on persistence |
| S6 | Timeline keyboard model in a screen reader | `role="slider"` plus buttons inside groups is a pattern we have not verified with a screen reader | Manual check with VoiceOver on macOS; axe run in Playwright |

Unverified in this document: none of the library options were installed or rendered. Version and peer data are from the npm registry on 2026-10-20. The Radix, react-aria and wavesurfer rows are not tested under Tailwind 4 in this app.

### FE-3 spike results (2026-10-27)

- **S1 — Use backend peaks (BE-E E5).** On a generated 15-minute, 16 kHz mono, 16-bit PCM WAV (28,800,044 bytes), the E5 50-peaks-per-second algorithm produced 45,000 peaks in an 878,421-byte JSON file. A local Python standard-library pass took 792 ms including JSON serialization and peaked at 3.37 MB of traced Python allocations. In headless Chrome 156.0.8078.4, fetching/parsing that local JSON and painting the waveform took 9.7 ms. Browser decoding the same WAV took 725 ms; peak calculation took 47 ms; first paint took 794 ms. Chrome decoded to 48 kHz, so the `AudioBuffer` alone used 172.8 MB, in addition to the 28.8 MB WAV buffer. This is a reference measurement: BE-E E5 is not on this branch, and local `ffmpeg` and `numpy` are unavailable, so the backend result uses the same 320-sample absolute-max windows in Python rather than the production media service. The JS heap metric does not include native `AudioBuffer` storage, so decoded buffer bytes are reported directly. The local HTTP result does not include production object-storage latency. **Decision: keep backend peaks as the default.** It avoids downloading and decoding the full WAV and paints much sooner in this run. BE-E should write the generated peaks object before setting `peaks_uri`, as planned.
- **S2 — Do not virtualise thumbnails for the planned load.** A headless Chrome DOM prototype with 300 segment elements and 120 lazy SVG thumbnails (420 timeline items total) was scrolled for 2.5 seconds at each zoom. The track widths were 900 px at 1× and 3,600 px at 4× in a 760 px scrollport. Both runs measured p50/p95 frame intervals of 16.7 ms and a maximum of 16.8 ms; neither had a frame longer than 33.3 ms. Keep the 120 thumbnails in the DOM and use lazy loading. This was a lightweight static prototype, not the React editor.
- **S3 — Skip and speed work; show holds as applied when rendered.** A generated 8.98-second WebM scratch demo used `requestVideoFrameCallback` to skip source 1.5–2.2 s, set 2× playback from 3–5 s, and hold the frame at 6 s for four seconds. The skip reached `seeked` 16 ms after detection; the speed changes were observed at 3.003 s and 5.015 s. Pausing and waiting held the same frame and media time for 4,024 ms. However, pausing the single `<video>` also pauses its audio, so this does not faithfully preview a rendered hold when audio should continue. Keep the hold label “applied when rendered” until a preview can hold the image while its audio advances.
- **S4 — Cut map implemented.** `frontend/src/lib/cut-map.ts` maps source and output positions through removed and speed spans, maps the collapsed cut boundary to the first kept source time after the cut, and skips undone changes. Its six focused tests pass. `components.schemas.Change` is not generated on this branch yet because BE-E has not landed; the helper uses the C7 structural shape as a temporary type fallback and resolves to the generated type when available. C9's `PlayerSegment` has no hold-duration field although C7 `Change` has `hold_s`; the cut map leaves hold segments time-neutral, and hold mapping is not covered by these tests. Resolve that shape/meaning before relying on holds for version-position mapping.

## 9. Accessibility checklist for every new control

- Native elements first (checkbox, radio, range where possible). Custom controls only where the design needs a visual the native one cannot give (switch, segmented, timeline).
- Each control has a visible label; helper text linked with `aria-describedby`.
- Focus ring: global `:focus-visible` (`globals.css` lines 56-59). Do not remove outlines.
- Touch target at least 44 px (`Button` already; apply to segmented items, switch and timeline items on touch).
- Live regions: one polite region per screen for results (`review-screen.tsx` line 187 pattern). Never on continuously changing values (clock, playhead, counters).
- Reduced motion: respect `prefers-reduced-motion` in JS for scroll and animation; CSS rule already covers transitions.
- Colour: every state also has text or a shape.
- Test each new primitive in jsdom (`vitest`, `@testing-library/react`) and add one Playwright flow per screen, following `frontend/e2e/review.spec.ts` and `share.spec.ts`.

## 10. Layout constraints for the build

- `ui/` gets generic primitives and the player and timeline (props only, no `@/api` import).
- `lib/` gets pure time-mapping (cut list to output time) because the review, done and video features all need it. `lib/` may import only `lib/` and `api/`.
- Feature folders: video page to `videos`, processing to `runs`, editor to `review`, done and share to `shares`. Do not add a new feature folder; `check-layout.mjs` rejects it (line 40).
- Cross-feature sharing goes through `ui/` or `lib/`, or through composition in `app/` (as `video-with-share.tsx` does).
