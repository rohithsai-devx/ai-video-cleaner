# UI implementation spec: superseded

Replaced on 2026-10-27 by the workstream plan in [post-upload/README.md](post-upload/README.md). It splits the same scope (glossary cleanup, post-upload backend, the four screens) into parallel workstreams with shared contracts, wireframes and render instructions.

What changed from the round-10 version of this spec (decisions R1 to R15 in the new README):

- Phase 3b is treated as underway, since the agent is committed; agent-side features are built now (R1).
- No hidden-until flags or stored-but-unread data: every UI element merges with its data (R2).
- The backend serves the editor's applied changes, spots with fixes, chapters and script lines (R3, R4).
- Agent retries use a fresh graph thread per attempt (R5); `retryable` comes from the exception (R6).
- Dropped: the hard-coded pause threshold (R7), the stub marker and its migration (R8), captions and struck-through words until real word timings exist (R9).
- New open item: "Edit and re-render" after a done run has no backend path (R15).
- Citations name symbols, not line numbers (R14).

The round-10 text is still in the main checkout's untracked copy if it is needed for history.
