# BE-C: shares and media URLs (raw share, original playback, downloads)

Backend for "Share it as is" (4.1), Original playback in the editor (4.3), and the done screen's two share cards with downloads (4.4). Contract C5 in [contracts.md](contracts.md). Consumers: FE-3 (original URL), FE-4 (cards, downloads).

## Goal

The raw recording gets its own link right after upload, with no run (D5). The editor and done screen can play and download both versions.

## Steps

### SH1. Original playback and signed downloads (no decision needed; start here)

- `shared/storage/gcs.py`: `GcsStorage.sign` gains an optional keyword `download_names: list[str | None] | None = None`, one per URI. When a name is set, the signed URL carries `response-content-disposition=attachment; filename="<name>"`. The fake-GCS (emulator) branch appends the same query parameter so tests can see it. Callers that pass nothing are unchanged.
- `videos/schemas.py` `Video` gains `original_url`, `download_url`, `original_download_url` (C5).
- `videos/router.py` `video_with_playback`: `original_url` is signed for `raw_uri` whenever it is set (today raw playback is signed only for some statuses; keep `playback_url` behaviour as it is). `download_url` only when `ready` (output MP4, filename `<title>.mp4`, slugged). `original_download_url` whenever `raw_uri` is set (filename `<title>-original.<ext>`, ext from the object name). Sign all URIs in one `sign` call.
- Tests: emulator URL contains the disposition parameter; `original_url` is present at `uploaded` and at `ready`; `download_url` is null before `ready`.

### SH2. List shares

- `GET /videos/{video_id}/shares` -> `list[ShareLink]` (C5), newest first, link-visibility only. 404 when the video is not visible. Add to `REQUIRED` in `scripts/export_openapi.py`.
- `POST /videos/{id}/shares` becomes idempotent per kind: when a non-expired link share of the same kind exists, return it with 200; otherwise create it with 201. `ShareCreated` gains `kind`.
- Tests in `backend/tests/shares/` (new folder with `__init__.py`): second POST returns the same slug; list returns it.

### SH3. Raw share kind (wait for **R12** to be confirmed)

Migration `docs/design/sql/08_share_kind.sql`. `02_rls.sql` is applied and must not be edited, so replace the function and policy here, in this order:

```sql
create type share_kind as enum ('cleaned', 'raw');
alter table shares add column kind share_kind not null default 'cleaned';

-- the return type changes, so drop and recreate
drop function app.resolve_share(text);
create function app.resolve_share(p_slug text)
  returns table (video_id uuid, title text, uri text, poster_uri text, kind share_kind)
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  update public.shares s set view_count = s.view_count + 1
  from public.videos v
  where s.slug = p_slug and s.visibility = 'link'
    and (s.expires_at is null or s.expires_at > now())
    and v.id = s.video_id
    and ((s.kind = 'cleaned' and v.status = 'ready') or (s.kind = 'raw' and v.raw_uri is not null))
  returning v.id, v.title,
    case when s.kind = 'raw' then v.raw_uri else v.output_uri end,
    v.poster_uri, s.kind $$;
alter function app.resolve_share(text) owner to app_definer;
revoke execute on function app.resolve_share(text) from public;
grant execute on function app.resolve_share(text) to app_api;

-- app_definer reads videos only through d_v; let it see raw-shared videos before they are ready
drop policy d_v on videos;
create policy d_v on videos for select to app_definer using (
  (status = 'ready' and id in (select video_id from shares where kind = 'cleaned'))
  or (raw_uri is not null and id in (select video_id from shares where kind = 'raw')));
```

Before writing it, read `02_rls.sql` and check: the function's current body and signature, the `d_v` policy text, and the owner and grants. If any differ from what this SQL assumes, match the real ones and say so in the PR.

Then:
- `contracts/enums.py`: `ShareKind` beside `ShareVisibility`, in `__all__`; `tests/contracts/test_models.py` `PAIRS` gains `"share_kind": enums.ShareKind` (P's parser reads 08).
- `shares/schemas.py`: `ShareCreate.kind`, `ShareLink.kind` (C5).
- `shares/router.py`: `create_share` reads `raw_uri`, inserts `kind`, returns 409 `raw_not_available` for `raw` without `raw_uri`; `public_share` reads the `uri` column.
- RLS test `T12c` in `docs/design/sql/03_rls_tests.sql` (inside its rolled-back transaction, as the superuser): set a seeded video to `uploaded` (it keeps `raw_uri`), insert one raw and one cleaned share with valid slugs, then as `app_api` `resolve_share` returns the raw slug and not the cleaned one.
- API tests: raw share at `uploaded` resolves to the raw URL; cleaned share at `uploaded` does not resolve; raw share without `raw_uri` is 409.
- `docs/design/hld-lld.md`: the `shares` table and `resolve_share` blocks.

## Exit

README section 4 checks, including `check_db.py` (it runs T12c). Report if SH3 was skipped for R12.
