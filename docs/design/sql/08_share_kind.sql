create type share_kind as enum ('cleaned', 'raw');
alter table shares add column kind share_kind not null default 'cleaned';

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

drop policy d_v on videos;
create policy d_v on videos for select to app_definer using (
  (status = 'ready' and id in (select video_id from shares where kind = 'cleaned'))
  or (raw_uri is not null and id in (select video_id from shares where kind = 'raw')));
