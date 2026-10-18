\set ON_ERROR_STOP on
-- seed as superuser (bypasses RLS)
insert into users (id, email) values
  ('00000000-0000-0000-0000-00000000000a','a@x.com'), ('00000000-0000-0000-0000-00000000000b','b@x.com');
insert into workspaces (id, name) values
  ('10000000-0000-0000-0000-000000000001','W1'), ('10000000-0000-0000-0000-000000000002','W2');
insert into workspace_members values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','owner'),
  ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','owner');
insert into videos (id, workspace_id, owner_id, status, raw_uri, output_uri) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','ready','gs://r1','gs://o1'),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','ready','gs://r2','gs://o2');
insert into runs (id, workspace_id, video_id, created_by, mode, voice) values
  ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','auto','original'),
  ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','auto','original');
insert into shares (workspace_id, video_id, slug, created_by, expires_at) values
  ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','okslug_00001','00000000-0000-0000-0000-00000000000a', null),
  ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','oldslug_0001','00000000-0000-0000-0000-00000000000b', now() - interval '1 day');
insert into outbox (workspace_id, run_id, queue, task_id, payload) values
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','pre-cpu','t1','{}'),
  ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','pre-cpu','t2','{}');
\set ON_ERROR_STOP off

-- T1 user A sees only W1
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ begin
  assert (select count(*) from videos) = 1 and (select count(*) from runs) = 1 and (select count(*) from shares) = 1
     and (select count(*) from workspaces) = 1 and (select count(*) from users) = 1, 'T1 leak';
  raise notice 'PASS T1 user sees only own workspace rows'; end $$;
rollback;

-- T2 user A cannot insert into W2
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ begin
  insert into videos (workspace_id, owner_id) values ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a');
  raise exception 'FAIL T2 cross-tenant insert allowed';
exception when insufficient_privilege then raise notice 'PASS T2 cross-tenant insert rejected: %', sqlerrm; end $$;
rollback;

-- T3 no identity -> nothing
begin; set local role app_api;
do $$ begin assert (select count(*) from videos) = 0 and (select count(*) from runs) = 0, 'T3';
  raise notice 'PASS T3 unset identity sees 0 rows'; end $$;
rollback;

-- T4 user A cannot update W2 run (0 rows) or move own video to W2
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ declare n int; begin
  update runs set stage = 'x' where id = '30000000-0000-0000-0000-000000000002'; get diagnostics n = row_count;
  assert n = 0, 'T4a';
  raise notice 'PASS T4 cross-tenant update touches 0 rows'; end $$;
rollback;

-- T5 worker scoped to W1
begin; set local role app_worker; select set_config('app.workspace_id','10000000-0000-0000-0000-000000000001',true);
do $$ declare n int; begin
  assert (select count(*) from runs) = 1, 'T5a';
  update runs set stage = 'x' where id = '30000000-0000-0000-0000-000000000002'; get diagnostics n = row_count;
  assert n = 0, 'T5b';
  begin
    insert into proposals (workspace_id, run_id, version, source, script, edit_plan, seg_contexts, transcript_ctx, checks)
    values ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002',1,'agent','{}','{}','[]','{}','[]');
    raise exception 'FAIL T5c';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS T5 worker confined to its workspace'; end $$;
rollback;

-- T6 illegal transition
begin; set local role app_worker; select set_config('app.workspace_id','10000000-0000-0000-0000-000000000001',true);
do $$ begin
  update runs set status = 'done', finished_at = now() where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'FAIL T6';
exception when check_violation then raise notice 'PASS T6 %', sqlerrm; end $$;
rollback;

-- T6b legal transition chain
begin; set local role app_worker; select set_config('app.workspace_id','10000000-0000-0000-0000-000000000001',true);
do $$ begin
  update runs set status = 'preprocessing' where id = '30000000-0000-0000-0000-000000000001';
  update runs set status = 'agent_running' where id = '30000000-0000-0000-0000-000000000001';
  update runs set status = 'approved'      where id = '30000000-0000-0000-0000-000000000001';
  raise notice 'PASS T6b legal transitions accepted'; end $$;
rollback;

-- T7 one live run per video
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ begin
  insert into runs (workspace_id, video_id, created_by, mode, voice) values
    ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','review','original');
  raise exception 'FAIL T7';
exception when unique_violation then raise notice 'PASS T7 second live run rejected'; end $$;
rollback;

-- T8 proposal idempotency + one approved per run
begin; set local role app_worker; select set_config('app.workspace_id','10000000-0000-0000-0000-000000000001',true);
insert into proposals (workspace_id, run_id, version, source, script, edit_plan, seg_contexts, transcript_ctx, checks)
values ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,'agent','{}','{}','[]','{}','[]')
on conflict (run_id, version) do nothing;
insert into proposals (workspace_id, run_id, version, source, script, edit_plan, seg_contexts, transcript_ctx, checks)
values ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',1,'agent','{}','{}','[]','{}','[]')
on conflict (run_id, version) do nothing;
do $$ begin assert (select count(*) from proposals) = 1, 'T8a'; raise notice 'PASS T8a duplicate save is a no-op'; end $$;
rollback;

-- T9 voice check, T10 approved pair check
begin;
do $$ begin
  insert into runs (workspace_id, video_id, created_by, mode, voice) values
    ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','auto','ai');
  raise exception 'FAIL T9';
exception when check_violation then raise notice 'PASS T9 ai voice without voice_id rejected'; end $$;
rollback;

-- T11 current_run_id of another video rejected at commit (deferred FK)
-- (SET CONSTRAINTS ... IMMEDIATE runs the same deferred check commit would, but inside a catchable block)
begin;
do $$ begin
  update videos set current_run_id = '30000000-0000-0000-0000-000000000002' where id = '20000000-0000-0000-0000-000000000001';
  set constraints all immediate;
  raise exception 'FAIL T11 cross-video current_run_id accepted';
exception when foreign_key_violation then raise notice 'PASS T11 cross-video current_run_id rejected at commit'; end $$;
rollback;

-- T12 public share
begin; set local role app_api;
select case when count(*) = 1 then 'PASS T12a live link resolves' else 'FAIL T12a' end from app.resolve_share('okslug_00001');
select case when count(*) = 0 then 'PASS T12b expired link does not resolve' else 'FAIL T12b' end from app.resolve_share('oldslug_0001');
rollback;

-- T13 create_workspace
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
select app.create_workspace('W3') is not null as created;
select case when count(*) = 2 then 'PASS T13 creator now sees 2 workspaces' else 'FAIL T13 ' || count(*) end from workspaces;
rollback;
begin; set local role app_api;
do $$ begin perform app.create_workspace('W4'); raise exception 'FAIL T13b';
exception when insufficient_privilege then raise notice 'PASS T13b anonymous cannot create workspace'; end $$;
rollback;

-- T14 relay sees all outbox rows, nothing else
begin; set local role app_relay;
select case when count(*) = 2 then 'PASS T14a relay drains all workspaces' else 'FAIL T14a' end from outbox;
do $$ begin perform 1 from videos; raise exception 'FAIL T14b';
exception when insufficient_privilege then raise notice 'PASS T14b relay cannot read videos'; end $$;
rollback;

-- T15 owner obeys policies (FORCE)
begin; set local role app_owner;
select case when count(*) = 0 then 'PASS T15 table owner sees 0 rows (FORCE)' else 'FAIL T15' end from videos;
rollback;

-- T16 review_edits append-only for api
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ begin delete from review_edits; raise exception 'FAIL T16';
exception when insufficient_privilege then raise notice 'PASS T16 review_edits delete denied'; end $$;
rollback;

-- T17 CI guard: every public table has RLS enabled and forced
select case when count(*) = 0 then 'PASS T17 all tables enabled+forced' else 'FAIL T17 ' || string_agg(relname, ',') end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity);

-- T18 transaction-local identity does not leak to the next transaction on the same connection
begin; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true); commit;
begin; set local role app_api;
select case when app.uid() is null and (select count(*) from videos) = 0 then 'PASS T18 identity cleared after commit' else 'FAIL T18' end;
rollback;

-- T19 concurrent CAS: the second identical compare-and-set finds 0 rows
begin; set local role app_worker; select set_config('app.workspace_id','10000000-0000-0000-0000-000000000001',true);
do $$ declare n1 int; n2 int; begin
  update runs set status = 'preprocessing' where id = '30000000-0000-0000-0000-000000000001' and status = 'queued'; get diagnostics n1 = row_count;
  update runs set status = 'preprocessing' where id = '30000000-0000-0000-0000-000000000001' and status = 'queued'; get diagnostics n2 = row_count;
  assert n1 = 1 and n2 = 0, 'T19'; raise notice 'PASS T19 CAS wins once'; end $$;
rollback;

-- AUTH (04_auth.sql)
-- T20 app_api cannot read password hashes directly
begin; set local role app_api; select set_config('app.user_id','00000000-0000-0000-0000-00000000000a',true);
do $$ begin perform 1 from user_credentials; raise exception 'FAIL T20 app_api can select user_credentials';
exception when insufficient_privilege then raise notice 'PASS T20 app_api cannot select user_credentials'; end $$;
rollback;

-- T21 register then look up: credentials_for returns the stored hash for that user
begin; set local role app_api;
do $$ declare uid uuid; r record; begin
  uid := app.register_credentials('new@x.com', 'New', 'argon2-hash-1');
  select * into r from app.credentials_for('NEW@x.com');
  assert r.user_id = uid and r.password_hash = 'argon2-hash-1', 'FAIL T21 credentials_for mismatch';
  assert (select count(*) from app.credentials_for('nobody@x.com')) = 0, 'FAIL T21b unknown email returned a row';
  raise notice 'PASS T21 credentials_for returns the registered hash'; end $$;
rollback;

-- T22 a second register for the same email is rejected
begin; set local role app_api;
do $$ begin
  perform app.register_credentials('dup@x.com', 'Dup', 'h1');
  perform app.register_credentials('DUP@x.com', 'Dup', 'h2');
  raise exception 'FAIL T22 duplicate register accepted';
exception when unique_violation then raise notice 'PASS T22 duplicate register rejected'; end $$;
rollback;

-- T23 workers cannot use the credential functions or table
begin; set local role app_worker;
do $$ begin perform 1 from app.credentials_for('a@x.com'); raise exception 'FAIL T23 worker can read credentials';
exception when insufficient_privilege then raise notice 'PASS T23 worker cannot read credentials'; end $$;
rollback;

