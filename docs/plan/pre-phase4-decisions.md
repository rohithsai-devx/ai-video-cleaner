# Pre-phase-4 decisions

Tracker for the decisions made against [pre-phase4-audit.md](pre-phase4-audit.md). Decisions only; implementation happens later, in its own slice.

## Rule

A feature is part of the architecture only as a complete slice: UI, API, database, and the code that consumes it. A feature missing any layer is removed until it is built whole.

## Decisions

| # | Date | Item | Decision | Status |
|---|---|---|---|---|
| D1 | 2026-10-20 | Workspace glossary | **Remove.** No UI exists and no pipeline code reads it. Re-add later as one complete slice (settings page included) if a customer needs it. | Done (commits `cb16ee8`, `651e139`, `09703a8`) |
| D2 | 2026-10-20 | Fake Chrome share-picker on the record screen | **Remove.** The "What Chrome shows next" panel (`record-screen.tsx`, the `aside` mock) is a static drawing, not a feature. | Locked, not started |
| D3 | 2026-10-20 | Internal names in the UI | **Rule:** the UI never shows ids or data-class names (`seg_02`, `block_01`, check names, raw check math). Every message says what, where (timestamp), why, and offers a one-click fix. | Locked |
| D5 | 2026-10-20 | Sharing the original recording | **Add (Loom mode).** The raw recording, with the user's own voice and uncut, gets its own share link and download, available right after upload with no AI run, and next to the cleaned version on the done screen. | Locked, in prototype |
| D4 | 2026-10-20 | Order of the post-upload rework | **UX first.** Prototype the post-upload experience (video page → processing → review editor → share) with no backend constraints, lock it, then reshape the backend to serve it. Prototype: https://claude.ai/artifact/Xobc3e53GfLJnLi6SJeEvu | Locked; UX written up in [../design/ux-post-upload.md](../design/ux-post-upload.md) |
| D6 | 2026-10-20 | Run preferences | **One request carries every choice:** which fixes the AI may make (pauses, filler, retakes, slow parts), narration (my voice / AI voice + which voice), and review first or not. AI voices have playable samples. | Locked, implement later |
| D7 | 2026-10-20 | Processing screen | **Steps in the user's words plus live "found so far" counts and chapters.** The technical activity log goes. Failures show a plain message and a working Try again. | Locked, implement later |
| D8 | 2026-10-20 | Review screen becomes an editor | **Player, multi-track timeline (chapters, screen, AI voice, your voice), and a left panel with Needs you / Done by AI / Script.** Playback follows along in every panel; Cleaned skips removed parts, Original plays everything with removed parts shaded; clicking anything jumps there. | Locked, implement later |
| D9 | 2026-10-20 | How AI changes are presented | **Two kinds:** changes the AI applied itself (each undoable, with a one-line reason) and spots that need the user (each with fix buttons). A skipped spot uses its first fix, so rendering is never blocked. | Locked, implement later |
| D10 | 2026-10-20 | Done screen | **One player for both versions, a "What changed" summary, and a share card per version** (own link, copy, play, download). | Locked, implement later |
| D11 | 2026-10-20 | Past attempts | **Every run of a video is listed on the video page** with status, time, voice and a link. | Locked, implement later |

## Next (planning, not started)

Planned in [post-upload/README.md](post-upload/README.md).

## To decide

Audit items still waiting for a finish-or-remove call:

- [ ] `provider_calls`: the table exists, nothing writes to it, and phase 4 observability depends on it.
- [ ] Checkpointer: the code uses `MemorySaver`; the spec and docs promise `PostgresSaver` in schema `lg`.
- [x] Retry: covered by [post-upload/README.md](post-upload/README.md) (BE-D).
- [x] Run history: covered by [post-upload/README.md](post-upload/README.md) (BE-B).
- [x] Compare / original video: covered by [post-upload/README.md](post-upload/README.md) (BE-C).
- [ ] Review-edit fields the API accepts but the UI never offers (`action`, `speed`, `freeze_s`).
- [ ] Share visibility `private` / `workspace`: in the schema; only `link` is served.
