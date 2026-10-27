-- 10: persist the user's post-upload cleanup choices on each run.
alter table runs add column fix_options jsonb not null default '{}';
