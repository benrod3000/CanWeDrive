create or replace function public._pgr_get_statement(o_sql text)
returns text
language sql
stable
strict
as $$
  select extensions._pgr_get_statement(o_sql)
$$;
