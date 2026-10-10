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
  and (p.proname like '%lsv%' or p.proname like '%route%' or left(p.proname, 5) = '_pgr_')
order by 1, 2, 3;
```

## Production function baseline (including pgRouting helper wrappers)

| Function | proconfig | definition_md5 |
| --- | --- | --- |
| `public._pgr_dijkstra(text, anyarray, anyarray, boolean, boolean, boolean, bigint, boolean)` | NULL | `d2e3be69befb2e7c03372f924e32f55e` |
| `public._pgr_get_statement(text)` | NULL | `bc892e85caa1865221ec642c47167681` |
| `public.lsv_pgr_astar(text, bigint, bigint)` | NULL | `a2e1bfdc78c75b36fddd9d3f693534d0` |
| `public.lsv_pgr_bdastar(text, bigint, bigint)` | NULL | `e44902d5165b98227b0678b098ea4f71` |
| `public.lsv_pgr_dijkstra(text, bigint, bigint)` | NULL | `e367e86c06e34374633a029c07a32b0c` |
| `public.road_segments_near_route(jsonb, double precision)` | `search_path=""` | `4c3bc6eb25bdb4b37d32841745f19d5b` |
| `public.route_lsv_candidate(double precision, double precision, double precision, double precision, boolean, double precision)` | `statement_timeout=10000ms` | `f61f1800f6e05dd3f9e877c43e7450e9` |
| `public.route_lsv_candidate_with_source(double precision, double precision, double precision, double precision, boolean, double precision)` | `statement_timeout=10000ms` | `ec9724ec3b7445f92986ea53921b7345` |

**Important:** `pg_get_functiondef` formatting and hashes can differ across PostgreSQL versions even when behavior matches. When hashes differ, compare normalized definitions and runtime behavior manually; do not treat a hash mismatch as conclusive failure.

The migration SQL was recovered from `supabase_migrations.schema_migrations.statements`. Production road graph and migration history must remain untouched during validation.


## Additional production schema and security baseline

Capture the following read-only queries from **both** production and the isolated replay database. Compare sorted rows, including role-specific grants and RLS flags; do not assume a successful SQL replay means equivalent permissions. The production snapshot taken on 2026-10-10 contained 93 public columns, 32 public indexes, 7 public policies, 154 role-table grant rows for the selected grantees, and 993 `lsv_component_stats` records. The last count is **data**, not a migration-only invariant: seed comparable component data before comparing counts.

```sql
-- Extensions: schema placement matters for PostGIS/pgRouting resolution.
select e.extname, n.nspname as schema, e.extversion
from pg_extension e join pg_namespace n on n.oid=e.extnamespace
order by e.extname;

-- Tables, columns, types, nullability, defaults.
select table_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default
from information_schema.columns where table_schema='public'
order by table_name,ordinal_position;

-- Index definitions.
select schemaname,tablename,indexname,indexdef
from pg_indexes where schemaname='public'
order by tablename,indexname;

-- RLS policies AND enabled/forced flags.
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public'
order by tablename,policyname;
select c.relname,c.relrowsecurity,c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p')
order by c.relname;

-- Table privileges: compare exact grants, including PUBLIC.
select table_schema,table_name,grantee,privilege_type
from information_schema.role_table_grants
where table_schema='public'
  and grantee in ('anon','authenticated','service_role','PUBLIC')
order by table_name,grantee,privilege_type;

-- Function privileges are separate from table privileges.
select routine_schema,routine_name,grantee,privilege_type
from information_schema.role_routine_grants
where routine_schema='public'
order by routine_name,grantee,privilege_type;

-- Component columns and component-stats state.
select table_name,column_name,data_type,udt_name
from information_schema.columns
where table_schema='public'
  and (column_name ilike '%component%' or table_name='lsv_component_stats')
order by table_name,ordinal_position;
select count(*) as component_stats_rows from public.lsv_component_stats;
```

Production extension placement observed: `postgis` and `pgrouting` both in `extensions` (versions 3.3.7 and 3.4.1 respectively); `pgcrypto`, `uuid-ossp`, and `pg_stat_statements` also in `extensions`. Supabase-managed extensions include `supabase_vault` in `vault` and `plpgsql` in `pg_catalog`. Match compatible versions and schema placement; managed extensions may vary between environments.

## Role-level runtime configuration

These settings are **not guaranteed to be created by migration files**. Establish them on the isolated instance *before replay* using the equivalent supported role configuration and confirm the result with:

```sql
select rolname,rolconfig
from pg_roles
where rolname in ('postgres','anon','authenticated','service_role')
order by rolname;
```

Live production baseline:

- `postgres`: `search_path="$user", public, extensions`
- `anon`: `statement_timeout=3s`
- `authenticated`: `statement_timeout=8s`
- `service_role`: no role-level override (`NULL`)

Use a Supabase-compatible isolated environment with these roles. Do not run `ALTER ROLE` against production as part of validation.

## Routing behavior smoke test

A clean migration replay creates schema and functions, **not the imported road graph**. First seed a tiny, deterministic, non-production graph containing a connected legal path, an unknown-speed segment, and an ineligible segment. Use the same seed in two isolated databases if comparing outputs; do not assume the production graph has identical seed IDs.

For a production-vs-replay behavior comparison, select a known-good real route's start/end coordinates and invoke the same `public.route_lsv_candidate` function with matching parameters in each environment **only after** seeding equivalent road nodes/edges. Compare ordered edge geometry, statuses, speed fields, and total length rather than database-generated edge IDs. Use a read-only transaction for the production invocation and do not change production road data. Verify that restricted/ineligible roads are excluded and unknown-speed handling respects `allow_unknown`.

Keep this PR in draft until a full replay, schema/permission parity checks, and routing behavior checks are completed.


## Default privileges, constraints, triggers, and security advisors

Default privileges apply to **future** objects and may be provisioned by the Supabase platform rather than this repository. Compare them explicitly between the production project and isolated environment, including object creator and target schema.

```sql
-- Default ACLs, including role/schema scope and grantee privilege expansion.
select owner.rolname as owner_role,
       coalesce(n.nspname, '<all schemas>') as schema,
       d.defaclobjtype as object_type,
       d.defaclacl::text as acl,
       pg_get_userbyid(d.defaclrole) as owner_check
from pg_default_acl d
join pg_roles owner on owner.oid=d.defaclrole
left join pg_namespace n on n.oid=d.defaclnamespace
order by owner.rolname, schema, d.defaclobjtype, d.defaclacl::text;

-- Constraints include CHECK, foreign keys, unique and primary keys.
select n.nspname as schema, t.relname as table_name,
       c.conname, c.contype, c.convalidated,
       pg_get_constraintdef(c.oid, true) as definition
from pg_constraint c
join pg_class t on t.oid=c.conrelid
join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public'
order by t.relname,c.conname;

-- Non-internal triggers, their enabled status, and definitions.
select n.nspname as schema, c.relname as table_name,
       t.tgname, t.tgenabled, pg_get_triggerdef(t.oid, true) as definition
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
order by c.relname,t.tgname;
```

Run Supabase **security advisors** on production and on the isolated replay project after migration replay. Compare each finding's lint name, affected object, severity and explanation; platform-managed differences should be documented rather than silently ignored. Security advisor findings are not equivalent to exploitable vulnerabilities, but new exposed tables/functions or missing RLS require investigation.

At the time of the production check, the advisor returned:

- **INFO** `rls_enabled_no_policy`: `public.lsv_component_stats` has RLS enabled with no policies. This is an intentional deny-by-default posture; ensure privileges remain restricted. [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- **WARN** `function_search_path_mutable`: seven functions (`_pgr_get_statement`, `_pgr_dijkstra`, `lsv_pgr_astar`, `lsv_pgr_bdastar`, `lsv_pgr_dijkstra`, `route_lsv_candidate`, `route_lsv_candidate_with_source`). Some are intentionally dependent on inherited pgRouting search paths. Do not change them just to silence the advisor without regression testing. [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)

The security advisor was run against production only. An isolated replay environment has **not** been created or scanned yet.


## Production read-only SQL execution check (2026-10-10)

All **14 individual SQL statements** in the four fenced SQL blocks above were executed successfully against the live project, using read-only queries. This validates the copy-paste syntax and production baseline collection; it **does not** validate clean migration replay.

Observed result counts, in statement order:

| Check | Rows returned |
| --- | ---: |
| Routing and pgRouting helper functions | 8 |
| Extensions | 7 |
| Public columns | 93 |
| Public indexes | 32 |
| Public RLS policies | 7 |
| Public RLS table flags | 8 |
| Selected table grants | 154 |
| Public function grants | 39 |
| Component-related columns | 5 |
| Component-stat count query | 1 (value: 993) |
| Role configurations | 4 |
| Default ACL entries | 24 |
| Public constraints | 21 |
| Non-internal public triggers | 0 |

Production advisor security findings were collected separately as documented above. The isolated replay, its advisor comparison, and its seeded routing behavior checks remain outstanding.
