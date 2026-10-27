alter type edit_kind add value 'fix_chosen';
alter table proposals add column spots jsonb not null default '[]';
