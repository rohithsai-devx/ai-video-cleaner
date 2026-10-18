-- ROLES. No app role has BYPASSRLS; the owner is NOLOGIN and FORCE makes even it obey policies.
create role app_owner   nologin;                -- owns tables; migrations run as it (SET ROLE)
create role app_definer nologin;                -- owns the few SECURITY DEFINER functions, each with its own narrow policy
create role app_api     login;                  -- FastAPI; identity = app.user_id
create role app_worker  login;                  -- pre/agent/post workers; identity = app.workspace_id
create role app_relay   login;                  -- outbox relay; sees only the outbox

-- identity, read from transaction-local settings; unset -> NULL -> every policy is false (fail closed)
create function app.uid()  returns uuid language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app.wsid() returns uuid language sql stable
  as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

-- membership helpers run as app_definer so the workspace_members policy does not recurse into itself
create function app.my_workspaces() returns setof uuid
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$ select workspace_id from public.workspace_members where user_id = app.uid() $$;
create function app.has_role(ws uuid, roles member_role[]) returns boolean
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$ select exists (select 1 from public.workspace_members
                       where workspace_id = ws and user_id = app.uid() and role = any (roles)) $$;

-- sign-in and workspace creation need rows before membership exists, so they go through definer functions
create function app.ensure_user(p_email citext, p_name text) returns uuid
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp
  as $$ insert into public.users (email, name) values (p_email, p_name)
        on conflict (email) do update set name = coalesce(excluded.name, users.name)
        returning id $$;
create function app.create_workspace(p_name text) returns uuid
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare ws uuid;
begin
  if app.uid() is null then raise exception 'no user' using errcode = 'insufficient_privilege'; end if;
  insert into public.workspaces (name) values (p_name) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, app.uid(), 'owner');
  return ws;
end $$;

-- public share page: anonymous viewer, so no user id; returns only playback fields and counts the view
create function app.resolve_share(p_slug text)
  returns table (video_id uuid, title text, output_uri text, poster_uri text)
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  update public.shares s set view_count = s.view_count + 1
  from public.videos v
  where s.slug = p_slug and s.visibility = 'link'
    and (s.expires_at is null or s.expires_at > now())
    and v.id = s.video_id and v.status = 'ready'
  returning v.id, v.title, v.output_uri, v.poster_uri $$;

alter function app.my_workspaces()                   owner to app_definer;
alter function app.has_role(uuid, member_role[])      owner to app_definer;
alter function app.ensure_user(citext, text)          owner to app_definer;
alter function app.create_workspace(text)            owner to app_definer;
alter function app.resolve_share(text)               owner to app_definer;
revoke execute on all functions in schema app from public;
grant usage on schema app to app_api, app_worker, app_relay, app_definer;
grant execute on function app.uid(), app.wsid()                    to app_api, app_worker, app_definer;
grant execute on function app.my_workspaces(), app.has_role(uuid, member_role[]) to app_api;
grant execute on function app.ensure_user(citext, text), app.create_workspace(text),
                          app.resolve_share(text)                   to app_api;

-- OWNERSHIP + RLS ON EVERY TABLE
do $$
declare t text;
begin
  foreach t in array array['users','workspaces','workspace_members','videos','runs','run_transitions',
                           'proposals','review_edits','shares','glossary_terms','provider_calls','outbox'] loop
    execute format('alter table public.%I owner to app_owner', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
alter type member_role owner to app_owner;

-- TABLE PRIVILEGES (RLS narrows rows; GRANT narrows verbs)
revoke all on all tables in schema public from public;
grant usage on schema public to app_api, app_worker, app_relay, app_definer;
grant select, update (name)                                on users              to app_api;
grant select, update (name, settings)                      on workspaces         to app_api;
grant select, insert, update (role), delete                on workspace_members  to app_api;
grant select, insert, update (title, status, raw_uri, duration_s, width, height, fps, current_run_id), delete
                                                           on videos             to app_api;
grant select, insert, update (status, stage, attempt, error, finished_at)
                                                           on runs               to app_api;
grant select                                               on run_transitions    to app_api, app_worker;
grant select, insert, update (approved_by, approved_at)    on proposals          to app_api;
grant select, insert                                       on review_edits       to app_api;
grant select, insert, update (visibility, expires_at), delete on shares          to app_api;
grant select, insert, update, delete                       on glossary_terms     to app_api;
grant select                                               on provider_calls     to app_api;
grant insert                                               on outbox             to app_api, app_worker;
grant select                                               on workspaces, glossary_terms to app_worker;
grant select, update                                       on videos, runs       to app_worker;
grant select, insert                                       on proposals, provider_calls to app_worker;
grant select, update (sent_at, tries)                      on outbox             to app_relay;
grant select                                               on workspace_members  to app_definer;
grant select, insert, update (name)                        on users              to app_definer;
grant insert, select                                       on workspaces         to app_definer;
grant insert                                               on workspace_members  to app_definer;
grant select, update (view_count)                          on shares             to app_definer;
grant select                                               on videos             to app_definer;

-- POLICIES. Shorthand: member(ws) = ws in (select app.my_workspaces()); the subselect is evaluated once per query.
-- reference table: readable by everyone who can read it at all
create policy rt_read on run_transitions for select to app_api, app_worker using (true);

-- users: yourself and people you share a workspace with
create policy u_read on users for select to app_api
  using (id = app.uid() or id in (select user_id from workspace_members));      -- members table is itself RLS-filtered
create policy u_self on users for update to app_api using (id = app.uid()) with check (id = app.uid());

-- workspaces and members
create policy ws_read  on workspaces for select to app_api using (id in (select app.my_workspaces()));
create policy ws_admin on workspaces for update to app_api
  using (app.has_role(id, '{owner,admin}')) with check (app.has_role(id, '{owner,admin}'));
create policy wm_read  on workspace_members for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy wm_ins   on workspace_members for insert to app_api with check (app.has_role(workspace_id, '{owner,admin}'));
create policy wm_upd   on workspace_members for update to app_api
  using (app.has_role(workspace_id, '{owner,admin}')) with check (app.has_role(workspace_id, '{owner,admin}'));
create policy wm_del   on workspace_members for delete to app_api
  using (app.has_role(workspace_id, '{owner,admin}') or user_id = app.uid());  -- leave a workspace

-- workspace-scoped content, user context (API)
create policy v_read on videos for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy v_ins  on videos for insert to app_api
  with check (workspace_id in (select app.my_workspaces()) and owner_id = app.uid());
create policy v_upd  on videos for update to app_api
  using (workspace_id in (select app.my_workspaces())) with check (workspace_id in (select app.my_workspaces()));
create policy v_del  on videos for delete to app_api
  using (owner_id = app.uid() or app.has_role(workspace_id, '{owner,admin}'));

create policy r_read on runs for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy r_ins  on runs for insert to app_api
  with check (workspace_id in (select app.my_workspaces()) and created_by = app.uid());
create policy r_upd  on runs for update to app_api
  using (workspace_id in (select app.my_workspaces())) with check (workspace_id in (select app.my_workspaces()));

create policy p_read on proposals for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy p_ins  on proposals for insert to app_api
  with check (workspace_id in (select app.my_workspaces()) and source = 'user');   -- agent proposals come from workers
create policy p_upd  on proposals for update to app_api
  using (workspace_id in (select app.my_workspaces()))
  with check (workspace_id in (select app.my_workspaces()) and approved_by = app.uid());

create policy re_read on review_edits for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy re_ins  on review_edits for insert to app_api
  with check (workspace_id in (select app.my_workspaces()) and user_id = app.uid());   -- append-only: no update/delete grant

create policy s_read on shares for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy s_ins  on shares for insert to app_api
  with check (workspace_id in (select app.my_workspaces()) and created_by = app.uid());
create policy s_upd  on shares for update to app_api
  using (workspace_id in (select app.my_workspaces())) with check (workspace_id in (select app.my_workspaces()));
create policy s_del  on shares for delete to app_api using (workspace_id in (select app.my_workspaces()));

create policy g_read  on glossary_terms for select to app_api using (workspace_id in (select app.my_workspaces()));
create policy g_write on glossary_terms for all to app_api
  using (app.has_role(workspace_id, '{owner,admin}')) with check (app.has_role(workspace_id, '{owner,admin}'));

create policy pc_read on provider_calls for select to app_api using (app.has_role(workspace_id, '{owner,admin}'));
create policy ob_api  on outbox for insert to app_api with check (workspace_id in (select app.my_workspaces()));

-- worker context: one task = one run = one workspace, set from the task payload
create policy w_ws   on workspaces     for select to app_worker using (id = app.wsid());
create policy w_g    on glossary_terms for select to app_worker using (workspace_id = app.wsid());
create policy w_v    on videos         for all to app_worker using (workspace_id = app.wsid()) with check (workspace_id = app.wsid());
create policy w_r    on runs           for all to app_worker using (workspace_id = app.wsid()) with check (workspace_id = app.wsid());
create policy w_p    on proposals      for all to app_worker using (workspace_id = app.wsid()) with check (workspace_id = app.wsid());
create policy w_pc   on provider_calls for all to app_worker using (workspace_id = app.wsid()) with check (workspace_id = app.wsid());
create policy w_ob   on outbox         for insert to app_worker with check (workspace_id = app.wsid());

-- relay: drains the outbox across workspaces, nothing else (by GRANT)
create policy rl_read on outbox for select to app_relay using (true);
create policy rl_upd  on outbox for update to app_relay using (true) with check (true);

-- definer functions: each table they touch has a policy for app_definer, scoped to what the function needs
create policy d_wm   on workspace_members for select to app_definer using (true);   -- membership lookups
create policy d_wm_i on workspace_members for insert to app_definer
  with check (user_id = app.uid() and role = 'owner');                              -- create_workspace only
create policy d_ws_i on workspaces for insert to app_definer with check (true);
create policy d_ws_s on workspaces for select to app_definer using (true);         -- needed by insert ... returning
create policy d_u    on users for all to app_definer using (true) with check (true); -- ensure_user (sign-in)
create policy d_s    on shares for select to app_definer
  using (visibility = 'link' and (expires_at is null or expires_at > now()));
create policy d_s_u  on shares for update to app_definer
  using (visibility = 'link' and (expires_at is null or expires_at > now())) with check (true);
create policy d_v    on videos for select to app_definer
  using (status = 'ready' and id in (select video_id from shares));                  -- shares is filtered by d_s
