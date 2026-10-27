# BE-A: remove the workspace glossary (D1)

Backend and docs only. No UI. Merge this lane first; the other backend lanes rebase onto it.

## Goal

The user-facing glossary has no UI and nothing reads it, so it goes (D1). The agent's own `TranscriptContext.glossary` (terms pulled from the transcript) stays, renamed `key_terms` so "glossary" means nothing in the codebase.

## Steps (each leaves the checks green; one PR per step is fine, one PR for all is fine)

### A1. Rename `glossary` to `key_terms` (behaviour-neutral)

Find every use: `grep -rn "glossary" backend/app backend/tests`.
- `contracts/pipeline.py`: `TranscriptContext.glossary` -> `key_terms`.
- `runs/checks.py`: `glossary_kept` -> `key_terms_kept`, and the check name string `"glossary_kept"` -> `"key_terms_kept"`.
- `agent/nodes/orchestrator.py` (call site) and `agent/prompts.py` (wording "glossary terms" -> "key terms").
- `pipeline/proposal_stub.py` and `pipeline/fixtures/proposal.json`.
- Tests that use either name.

New migration `docs/design/sql/06_key_terms.sql`. Stored proposals hold the old key in `transcript_ctx` and the old check name in `checks`, and `TranscriptContext.model_validate` reads them back, so rewrite them:

```sql
-- 06: rename the agent's transcript glossary to key_terms in stored proposals.
set local row_security = off;  -- a role that cannot bypass RLS errors here instead of matching zero rows

update proposals set transcript_ctx = (transcript_ctx - 'glossary')
  || jsonb_build_object('key_terms', transcript_ctx->'glossary')
  where transcript_ctx ? 'glossary';

update proposals set checks = (
  select coalesce(jsonb_agg(
    case when c->>'name' = 'glossary_kept' then jsonb_set(c, '{name}', '"key_terms_kept"') else c end
    order by ord), '[]'::jsonb)
  from jsonb_array_elements(checks) with ordinality as t(c, ord))
where exists (select 1 from jsonb_array_elements(checks) c where c->>'name' = 'glossary_kept');

do $$ begin
  if exists (select 1 from proposals p where p.transcript_ctx ? 'glossary'
             or exists (select 1 from jsonb_array_elements(p.checks) c where c->>'name' = 'glossary_kept'))
  then raise exception 'migration 06: proposals still hold glossary keys'; end if;
end $$;
```

Why the guard: `proposals` has FORCE RLS, and `migrate.py` records a file as applied in the same transaction as its statements. A migrating role without BYPASSRLS would update zero rows and still record 06. `row_security = off` makes that an error instead. Do not add BYPASSRLS to any role.

Test `backend/tests/shared/test_migration_06.py`: in a scratch database (`with_dbname` + `recreate_database`, as `scripts/check_db.py` does), apply `01` to `05` from a temp folder with `apply_migrations(url, sql_dir=...)`, insert two old-shape proposals as the admin (with the workspace, user, video and run rows they need), then apply `01` to `06`. Assert both rows have `key_terms`, no `glossary`, and `key_terms_kept` in `checks`. Drop the database in `finally`. Import `apply_migrations` with `from scripts.migrate import apply_migrations`; if pytest cannot resolve it, load the file with `importlib.util.spec_from_file_location`.

Regenerate: `uv run python scripts/export_openapi.py` and `cd frontend && npm run gen:api`.

### A2. Remove the glossary API and the pronunciation plumbing

- Delete `backend/app/glossary/`. Remove its import and router from `main.py`, its two `REQUIRED` paths from `scripts/export_openapi.py`, and `"glossary"` from `DOMAINS` in `scripts/check_layout.py`.
- Delete the glossary test in `tests/videos/test_api.py`. In `tests/contracts/test_models.py`, the `Page[GlossaryTerm]` case becomes `Page[Video]` (`Page` is still used by `GET /videos`).
- Pronunciations exist only to carry glossary terms to TTS. Remove the `pronunciations` parameter from `MediaEngines.synthesize` (its production caller passes `{}`), from the provider bundle's `synthesize`, and from their tests. ElevenLabs will re-add pronunciation dictionaries with the voice work.
- Regenerate OpenAPI and TS types. No frontend source uses the glossary; only `schema.d.ts` changes.

### A3. Drop the table

`docs/design/sql/07_drop_glossary_terms.sql`: `drop table glossary_terms;` with a comment that its policies and grants go with it. Do not edit `01_schema.sql` or `02_rls.sql`: they are applied, and `migrate.py` refuses a changed checksum. `check_db.py` must pass (T17 reads the catalog, so `03_rls_tests.sql` needs no edit).

### A4. Docs

- `docs/design/hld-lld.md`: remove the glossary table, API row, RLS row, grants, policies, `Ctx.glossary`, the `glossary/` domain, and `synthesize(... pronunciations)`; rename the transcript field to `key_terms`. Keep the ElevenLabs pronunciation-dictionary provider fact.
- `docs/plan/phase3b.md`, `README.md`: same renames and removals.
- `docs/design/screens/Library.dc.html`: remove the static "Glossary" nav link.
- `docs/plan/pre-phase4-audit.md`: remove the glossary items.
- `docs/plan/pre-phase4-decisions.md`: D1 status "Done" with the PR link; delete its "Scope when implemented" block.

## Exit

```bash
grep -rliE 'glossar|pronunc' README.md docs backend frontend/src frontend/e2e \
  --exclude-dir=node_modules --exclude-dir=.venv
```

lists only: `docs/plan/pre-phase4-decisions.md`, `docs/plan/ui-implementation-spec.md`, `docs/plan/post-upload/*`, `docs/design/sql/01_schema.sql`, `02_rls.sql`, `06_key_terms.sql`, `07_drop_glossary_terms.sql`, `backend/tests/shared/test_migration_06.py`, `docs/research/findings-2026-10-17.md`, and `docs/design/hld-lld.md` (the ElevenLabs provider fact only). Plus the README section 4 checks.
