# Supabase migration replay verification

This is a **read-only baseline** captured from the live CanWeDrive project on 2026-10-10. Do not reset, merge, or replay migrations on the production Supabase branch.

## Required test

1. Start an **isolated, empty** PostgreSQL instance with compatible PostGIS and pgRouting extensions and Supabase roles/schemas.
2. Apply the 48 SQL files in `supabase/migrations` in filename order, without skipping historical fixes.
3. Run the read-only query below in the isolated instance and compare every returned row against the production baseline.
4. Inspect extension placement, access privileges, RLS policies, and migration failures before declaring parity. Do not merge PR #4 until replay and parity checks pass.

```sql
select
  n.nspname as schema,
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  p.proconfig,
  md5(pg_get_functiondef(p.oid)) as definition_md5
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname like '%lsv%' or p.proname like '%route%')
order by 1, 2, 3;
```

## Production function baseline

| Function | proconfig | definition_md5 |
| --- | --- | --- |
| `public.lsv_pgr_astar(text, bigint, bigint)` | NULL | `a2e1bfdc78c75b36fddd9d3f693534d0` |
| `public.lsv_pgr_bdastar(text, bigint, bigint)` | NULL | `e44902d5165b98227b0678b098ea4f71` |
| `public.lsv_pgr_dijkstra(text, bigint, bigint)` | NULL | `e367e86c06e34374633a029c07a32b0c` |
| `public.road_segments_near_route(jsonb, double precision)` | `search_path=""` | `4c3bc6eb25bdb4b37d32841745f19d5b` |
| `public.route_lsv_candidate(double precision, double precision, double precision, double precision, boolean, double precision)` | `statement_timeout=10000ms` | `f61f1800f6e05dd3f9e877c43e7450e9` |
| `public.route_lsv_candidate_with_source(double precision, double precision, double precision, double precision, boolean, double precision)` | `statement_timeout=10000ms` | `ec9724ec3b7445f92986ea53921b7345` |

**Important:** `pg_get_functiondef` formatting and hashes can differ across PostgreSQL versions even when behavior matches. When hashes differ, compare normalized definitions and runtime behavior manually; do not treat a hash mismatch as conclusive failure.

The migration SQL was recovered from `supabase_migrations.schema_migrations.statements`. Production road graph and migration history must remain untouched during validation.
