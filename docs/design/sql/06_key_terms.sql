-- 06: rename the agent's transcript glossary to key_terms in stored proposals.
set local row_security = off; -- A role that cannot bypass RLS must fail rather than silently update zero rows.

update proposals set transcript_ctx = (transcript_ctx - 'glossary')
  || jsonb_build_object('key_terms', transcript_ctx->'glossary')
  where transcript_ctx ? 'glossary';

update proposals set checks = (
  select coalesce(jsonb_agg(
    case when c->>'name' = 'glossary_kept' then jsonb_set(c, '{name}', '"key_terms_kept"') else c end
    order by ord), '[]'::jsonb)
  from jsonb_array_elements(checks) with ordinality as t(c, ord))
where exists (select 1 from jsonb_array_elements(checks) as t(c) where c->>'name' = 'glossary_kept');

do $$ begin
  if exists (select 1 from proposals p where p.transcript_ctx ? 'glossary'
             or exists (select 1 from jsonb_array_elements(p.checks) as t(c) where c->>'name' = 'glossary_kept'))
  then raise exception 'migration 06: proposals still hold glossary keys'; end if;
end $$;
