-- Schemas: public = app tables (RLS on), app = helper functions, lg = LangGraph checkpoints (workers only)
create extension if not exists citext;
create schema if not exists app;
create schema if not exists lg;

create type member_role   as enum ('owner','admin','member');
create type video_status  as enum ('uploading','uploaded','processing','awaiting_review','rendering','ready','failed');
create type run_mode      as enum ('review','auto');
create type voice_mode    as enum ('original','ai');
create type run_status    as enum ('queued','preprocessing','agent_running','awaiting_review',
                                   'approved','postprocessing','done','failed','cancelled');
create type proposal_src  as enum ('agent','user');
create type share_vis     as enum ('private','workspace','link');
create type edit_kind     as enum ('block_text','cut_toggle','speed','must_keep');

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       citext unique not null,
  name        text,
  created_at  timestamptz not null default now()
);

create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  settings    jsonb not null default '{}',   -- default mode, voice, accept threshold
  created_at  timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id      uuid not null references users on delete cascade,
  role         member_role not null default 'member',
  primary key (workspace_id, user_id)
);
create index on workspace_members (user_id, workspace_id);     -- the RLS membership lookup

create table videos (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces on delete cascade,
  owner_id        uuid not null references users,
  title           text not null default 'Untitled recording',
  status          video_status not null default 'uploading',
  raw_uri         text,
  duration_s      numeric(8,2) check (duration_s > 0),
  width int check (width > 0), height int check (height > 0), fps numeric(6,3) check (fps > 0),
  current_run_id  uuid,                        -- fk added after runs
  output_uri      text,
  poster_uri      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, id),                   -- target for child composite FKs
  check (status not in ('uploaded','processing','awaiting_review','rendering','ready') or raw_uri is not null),
  check (status <> 'ready' or output_uri is not null)
);
create index on videos (workspace_id, created_at desc);

create table runs (
  id            uuid primary key default gen_random_uuid(),   -- = LangGraph thread_id
  workspace_id  uuid not null,
  video_id      uuid not null,
  created_by    uuid not null references users,
  mode          run_mode not null,
  voice         voice_mode not null,
  voice_id      text,                          -- provider voice when voice = 'ai'
  status        run_status not null default 'queued',
  stage         text,                          -- fine-grained step for the UI
  attempt       int not null default 1 check (attempt >= 1),  -- bumped by the Retry button
  pre           jsonb,                         -- PreprocessResult
  flags         jsonb not null default '[]',
  error         jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  foreign key (workspace_id, video_id) references videos (workspace_id, id) on delete cascade,
  unique (workspace_id, id),
  unique (video_id, id),                       -- target for videos.current_run_id
  check ((voice = 'ai') = (voice_id is not null)),
  check ((status in ('done','failed','cancelled')) = (finished_at is not null))
);
create index on runs (video_id, created_at desc);
create index runs_active on runs (status) where status not in ('done','failed','cancelled');
-- at most one live run per video: a double-click on "Process with AI" cannot start two
create unique index runs_one_live_per_video on runs (video_id)
  where status not in ('done','failed','cancelled');
-- current_run_id must point at a run of the same video
alter table videos add foreign key (id, current_run_id) references runs (video_id, id)
  deferrable initially deferred;

-- legal status moves; a trigger rejects anything else, so a buggy worker cannot skip states
create table run_transitions (
  from_status run_status not null,
  to_status   run_status not null,
  primary key (from_status, to_status)
);
insert into run_transitions values
  ('queued','preprocessing'), ('preprocessing','agent_running'),
  ('agent_running','awaiting_review'), ('agent_running','approved'),      -- auto mode
  ('awaiting_review','approved'), ('approved','postprocessing'), ('postprocessing','done'),
  ('queued','failed'), ('preprocessing','failed'), ('agent_running','failed'), ('postprocessing','failed'),
  ('queued','cancelled'), ('preprocessing','cancelled'), ('agent_running','cancelled'),
  ('awaiting_review','cancelled'), ('approved','cancelled'),
  ('failed','preprocessing'), ('failed','agent_running'), ('failed','postprocessing');   -- Retry

create function app.check_run_transition() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and not exists (
       select 1 from run_transitions where from_status = old.status and to_status = new.status) then
    raise exception 'illegal run transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger runs_transition before update of status on runs
  for each row execute function app.check_run_transition();

create table proposals (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  run_id             uuid not null,
  version            int  not null check (version >= 1),
  source             proposal_src not null,
  script             jsonb not null,           -- Script
  edit_plan          jsonb not null,           -- EditPlan (EDL + reasoning)
  seg_contexts       jsonb not null,           -- list[SegContext]
  transcript_ctx     jsonb not null,           -- TranscriptContext
  checks             jsonb not null,           -- list[CheckResult]
  approved_by        uuid references users,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (workspace_id, run_id) references runs (workspace_id, id) on delete cascade,
  unique (run_id, version),                    -- makes "save proposal" idempotent
  unique (workspace_id, id),
  check ((approved_by is null) = (approved_at is null)),
  check (source = 'user' or version = 1)       -- only v1 comes from the agent
);
create unique index proposals_one_approved on proposals (run_id) where approved_at is not null;

create table review_edits (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  proposal_id  uuid not null,
  user_id      uuid not null references users,
  kind         edit_kind not null,
  target_id    text not null,                  -- block_id or seg_id
  agent_value  jsonb,
  user_value   jsonb,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, proposal_id) references proposals (workspace_id, id) on delete cascade
);
create index on review_edits (proposal_id);

create table shares (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  video_id     uuid not null,
  slug         text unique not null check (slug ~ '^[A-Za-z0-9_-]{10,32}$'),
  visibility   share_vis not null default 'link',
  expires_at   timestamptz,
  created_by   uuid not null references users,
  view_count   bigint not null default 0 check (view_count >= 0),
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, video_id) references videos (workspace_id, id) on delete cascade
);
create index on shares (video_id);

create table glossary_terms (
  workspace_id  uuid not null references workspaces on delete cascade,
  term          text not null check (length(term) between 1 and 200),
  pronunciation text,
  primary key (workspace_id, term)
);

create table provider_calls (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces on delete cascade,
  run_id       uuid,
  stage        text not null,                  -- transcribe | vlm_context | tts | ...
  provider     text not null,
  model        text,
  units        numeric check (units >= 0),     -- seconds of audio, tokens, characters
  cost_usd     numeric(10,5) check (cost_usd >= 0),
  latency_ms   int check (latency_ms >= 0),
  ok           boolean not null,
  error        text,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, run_id) references runs (workspace_id, id) on delete set null (run_id)  -- PG 15+
);
create index on provider_calls (workspace_id, created_at desc);
create index on provider_calls (run_id);

-- transactional outbox: rows written in the same transaction as the state change they announce
create table outbox (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces on delete cascade,
  run_id        uuid not null,
  queue         text not null check (queue in ('pre-cpu','pre-io','agent','post-io','post-cpu')),
  task_id       text not null unique,          -- sha256(run_id:stage:attempt), also the Cloud Tasks task id
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  tries         int not null default 0,
  foreign key (workspace_id, run_id) references runs (workspace_id, id) on delete cascade
);
create index outbox_unsent on outbox (id) where sent_at is null;

-- updated_at maintained by the database, not by callers
create function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger videos_touch before update on videos
  for each row execute function app.touch_updated_at();
