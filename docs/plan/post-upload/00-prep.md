# P: prep (serial, before every other lane)

One agent, about half a day. Every other lane branches from `main` after this merges.

## Goal

Get the docs on `main`, make the phase status true, and land the two small shared changes that several lanes need, so no two lanes make them at once.

## Steps

### P1. Phase status

R1 is settled: Phase 3b is underway, and agent-side post-upload features are built now. Do not ask for confirmation.

On yes:
- `CLAUDE.md`, "Current phase": say Phase 3b is in progress and the post-upload rework is planned in `docs/plan/post-upload/`.
- `docs/plan/phases.md`: tick the Phase 3a exit criteria that hold today. Check each one before ticking it: run the 3a manual pass if it is not recorded (`docs/uat/` if present). Leave a box unticked when you cannot show it passes, and list it in your report.

On no: stop and report. The plan needs rework.

### P2. Commit the docs

`git add` and commit:
- `docs/design/ux-post-upload.md`
- `docs/research/components-post-upload.md`
- `docs/plan/pre-phase4-decisions.md`
- `docs/plan/ui-implementation-spec.md` (the pointer)
- `docs/plan/post-upload/`

In `pre-phase4-decisions.md`, under "Next (planning, not started)", replace the three items with one line: "Planned in [post-upload/README.md](post-upload/README.md)." Mark the "To decide" items covered by this plan: Retry (BE-D), Run history (BE-B), Compare / original video (BE-C). Leave the others.

### P3. Enum parser reads every migration

`backend/tests/contracts/test_models.py` reads only `01_schema.sql`. Migrations 08 and 09 add enum types and labels in later files, so change it now, test-first:

- `sql_enums()` reads every `docs/design/sql/NN_*.sql` except `*_tests.sql`, sorted by name.
- It matches `create type <name> as enum (...)` (existing `_ENUM_RE`) and `alter type <name> add value '<label>'`. An added label is appended to that enum's tuple, in file order.
- It must not match `alter type ... owner to ...` (in `02_rls.sql`).
- Add a unit test of the parser on an inline SQL string: one create, one add value, one owner-to line. Expected: the create labels then the added label; the owner-to line ignored.

`test_literal_matches_sql_enum` keeps its shape and still passes, since no migration adds a label yet.

### P4. Approved runs record their stage

`runs/review.py` approve calls `advance(conn, run, "approved")` with no stage, so a user-approved run keeps `stage = "review"`, while the auto path writes `stage = "approved"` (`pipeline/stages.py`, agent stage). BE-D's retry reads `run.stage`, so make them agree:

- Test first in `backend/tests/runs/test_review.py`: after approve, `GET /runs/{id}` has `stage == "approved"`.
- Change the call to `advance(conn, run, "approved", stage="approved")`.

## Exit

- README section 4 checks pass.
- One PR: "post-upload prep". Report the phase answer and any unticked 3a criteria.
