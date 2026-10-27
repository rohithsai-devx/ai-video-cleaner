# FE-4: share cards and the done screen (4.1 "Share it as is", 4.4)

Screens: `ux-post-upload.md` 4.1 (the raw card) and 4.4, prototype artboards **1 · After upload** (the "Share it as is" card) and **4 · Done and share**. Routes `/videos/[id]` (card at `uploaded`; done screen at `ready`) and `/s/[slug]`. Contracts C5, C7, C9. Backend: BE-C. Uses FE-3's `ui/media-player.tsx` and `lib/cut-map.ts`.

Files you own: `features/shares/**`, `app/(app)/videos/[id]/**`, `app/s/**`, `e2e/share.spec.ts`.

## Composition (in `app/(app)/videos/[id]/`, features never import each other)

- `video-with-share.tsx` queries the video. At `ready` without `?clean=1` it renders `DoneScreen` (`features/shares/done-screen.tsx`). Otherwise it renders FE-1's `VideoScreen` with `renderShare` (C9) set to the raw `ShareCard`.
- "Clean again with other settings" links to `/videos/{id}?clean=1`, which shows the video page with its Clean panel.

## Wireframes

Raw card (inside the video page's left column, under the note):

```
+--------------------------------------------------------------+   surface, border line, rounded-2xl, p-5, gap-3
| Share it as is                                       (h2 16) |
| No AI, no waiting. The link plays this recording with your   |
| own voice, uncut. You can still clean it later; this link    |
| keeps showing the original.                                  |
| [ stepwise.app/s/r4n8x                     ] [ Copy link ]   |   before a link exists: [ Create link ] only
+--------------------------------------------------------------+
```

Done screen (1440; `main` max-width 1280, flex-wrap gap-8):

```
+---------------------------------------------------------------------------------------+
| Stepwise / Library / Setting up a new project                                         |
+---------------------------------------------------------------------------------------+
| LEFT (flex 999 1 560px)                                | SHARE aside (flex 1 1 360px)  |
| [ Cleaned · 4:05 | Original · 6:12 ]  (segmented sm)   | surface, rounded-3xl, p-7     |
| +----------------------------------------------------+ | Share                 (h2 26) |
| |  media-player (file mode), badge                   | | Each version has its own link.|
| |  "Cleaned · AI voice" / "Original recording · your | | Anyone with a link can watch  |
| |  voice", chapter marks on the progress bar         | | that version.                 |
| +----------------------------------------------------+ | +---------------------------+ |
| Cleaned version: pauses and retakes are gone, slow     | | Cleaned video  4:05 · AI v. | |
| parts play faster.   (13 muted; Original: "The full    | | [stepwise.app/s/k7q2m][Copy]| |
| recording with your own voice, exactly as recorded.")  | | Play this version  Download | |
|                                                        | |                        MP4  | |
| Setting up a new project (h1 26)            [Ready]    | +---------------------------+ |
| +----------------------------------------------------+ | | Original recording        | |
| | What changed                                       | | |  6:12 · your voice, uncut | |
| |  2:07        6           3           2             | | | [link] [Copy]             | |
| |  shorter     pauses      retakes     waits         | | | Play this version         | |
| |              removed     removed     sped up       | | |  Download original        | |
| | Narrated by the AI voice (Coral). 3 spots were     | | +---------------------------+ |
| | your call.                                         | | ----------------------------- |
| +----------------------------------------------------+ | Clean again with other        |
|                                                        | settings                      |
+---------------------------------------------------------------------------------------+
The card for the version in the player: border 2 px link colour, bg accent-soft. "Play this version" switches the player.
Phone (390): one column: switch, player, note, title, What changed (2 x 2 grid), share aside.
```

Stats: numbers in `font-display` 26 px bold, labels 13 px muted, 4 columns (2 on phone). Copy button turns to "Copied" (success background) for 2 s; on clipboard failure it selects the link text and says "Press Cmd+C to copy" (keep `share-panel.tsx`'s existing fallback and `aria-live`).

## Steps (one PR each; merge when "needs" is on main)

| Step | What | Needs |
|---|---|---|
| 4a | **`ShareCard`** (`features/shares/share-card.tsx`), extracted from `share-panel.tsx`: props `title, meta?, url | null, onCreate?, creating, onPlay?, downloadUrl?, downloadLabel, selected`. Drop the expiry and visibility controls (only link visibility exists). Delete `share-options.ts` and its test if nothing uses them after. `share-panel.tsx` becomes a thin wrapper rendering one cleaned card, so today's `ready` page still works until 4c. | FE-0 |
| 4b | **Raw card** on the video page: `GET /videos/{id}/shares` for the raw link; "Create link" posts `{kind: "raw"}`; render through FE-1's `renderShare` slot whenever `raw_uri` exists (status `uploaded`, `processing`, `awaiting_review`, `rendering`, `failed`). | BE-C SH2, SH3; FE-1 1b (slot) |
| 4c | **Done screen**: `done-screen.tsx` with the player in `file` mode (`playback_url` for Cleaned; `original_url` for Original; switching keeps position with `lib/cut-map.ts` and the current run's `changes`), the two cards (cleaned link via `POST {kind:"cleaned"}` / `GET`; original card only when BE-C SH3 is on main), downloads (`download_url` "Download MP4"; `original_download_url` "Download original"; when null at `ready`, "Download unavailable." with **Try again** that refetches the video). What changed from the current run's `GET /runs/{id}/proposal`: shorter = `formatShorter(duration_s, outputLength(...))`, pauses = `changes` of kind `pause` not undone, retakes = `retake`, waits = `speed`; narration line from `run.voice` and the voice label (`GET /voices`); "{n} spots were your call." counts spots with `chosen_by == "user"`, omitted when 0. | FE-3 3c (player), BE-C SH1, BE-E E2, E3 |
| 4d | **Public page** `app/s/[slug]/page.tsx`: unchanged shape, so it works for raw shares as is; check the title and that a raw link plays the original. | BE-C SH3 |

Not built (R15): "Edit and re-render". A `done` run cannot go back to review (`run_transitions` has no edge from `done`), so the link would lead nowhere. It needs a backend decision first.

## Render and check

README section 5. Fixtures: the demo video at `ready` with `playback_url`, `original_url` and download URLs; `GET /videos/{id}/shares` with and without links; the demo `ProposalView` from FE-3's `e2e/fixtures/proposal-demo.json`.

- Unit: `share-card.test.tsx` (create, copy and "Copied", copy failure fallback, selected style), `done-screen.test.tsx` (stats from the fixture: 2:07 shorter, counts, narration line).
- `e2e/share.spec.ts`: raw card at `uploaded` creates a link and copies it; the done screen shows two cards, switching the player from each card's "Play this version"; download links present; null download shows the unavailable state; `?clean=1` shows the Clean panel. Screenshots at 1440 and 390.
- Manual: open a raw link in a private window: it plays the uncut recording.
