-- AUTH (phase 1): password hashes live in their own table that no app role can read.
-- app_api reaches it only through two SECURITY DEFINER functions owned by app_definer.
create table public.user_credentials (
  user_id       uuid primary key references public.users (id) on delete cascade,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
alter table public.user_credentials owner to app_owner;
alter table public.user_credentials enable row level security;
alter table public.user_credentials force row level security;

revoke all on public.user_credentials from public, app_api, app_worker, app_relay;
grant select, insert on public.user_credentials to app_definer;
create policy d_uc_s on public.user_credentials for select to app_definer using (true);         -- credentials_for
create policy d_uc_i on public.user_credentials for insert to app_definer with check (true);   -- register_credentials

-- sign-up: upsert the user, then attach credentials; a second register raises unique_violation (primary key)
create function app.register_credentials(p_email citext, p_name text, p_hash text) returns uuid
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare uid uuid;
begin
  uid := app.ensure_user(p_email, p_name);
  insert into public.user_credentials (user_id, password_hash) values (uid, p_hash);
  return uid;
end $$;

-- sign-in: the stored hash for an email (zero rows when unknown); verification happens in the API
create function app.credentials_for(p_email citext) returns table (user_id uuid, password_hash text)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select c.user_id, c.password_hash
  from public.users u join public.user_credentials c on c.user_id = u.id
  where u.email = p_email $$;

alter function app.register_credentials(citext, text, text) owner to app_definer;
alter function app.credentials_for(citext)                  owner to app_definer;
revoke execute on function app.register_credentials(citext, text, text), app.credentials_for(citext) from public;
grant execute on function app.register_credentials(citext, text, text), app.credentials_for(citext) to app_api;
