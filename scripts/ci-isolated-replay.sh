#!/usr/bin/env bash
set -euo pipefail
mkdir -p replay-results/baselines
psql -v ON_ERROR_STOP=1 -Atc "select version()" > replay-results/postgres-version.txt
psql -v ON_ERROR_STOP=1 -F $'\t' -Atc "select e.extname,e.extversion,n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname in ('postgis','pgrouting') order by e.extname" > replay-results/extension-versions.tsv
psql -v ON_ERROR_STOP=1 -F $'\t' -Atc "select rolname,rolconfig from pg_roles where rolname in ('postgres','anon','authenticated') order by rolname" > replay-results/role-settings.tsv
cat replay-results/postgres-version.txt
cat replay-results/extension-versions.tsv
cat replay-results/role-settings.tsv

# Verify the exact role-level settings survived the local reset.
psql -v ON_ERROR_STOP=1 -Atc "
select case when
  (select rolconfig::text like '%public, extensions%' from pg_roles where rolname='postgres')
  and (select 'statement_timeout=3s'=any(rolconfig) from pg_roles where rolname='anon')
  and (select 'statement_timeout=8s'=any(rolconfig) from pg_roles where rolname='authenticated')
then 'PASS' else 'FAIL' end" | tee replay-results/role-check.txt
test "$(cat replay-results/role-check.txt)" = PASS

# Pull the 14 executable SQL statements from the reviewed guide itself.
python3 - <<'PY'
import re,pathlib
text=pathlib.Path('docs/supabase-migration-replay-verification.md').read_text()
blocks=re.findall(r'```sql\n(.*?)\n```',text,re.S)
assert len(blocks)==4, f'Expected 4 SQL blocks, found {len(blocks)}'
n=0
for block in blocks:
    for query in block.split(';'):
        if re.sub(r'--[^\n]*','',query).strip():
            n+=1
            pathlib.Path(f'replay-results/baselines/{n:02d}.sql').write_text(query.strip()+';\n')
assert n==14, f'Expected 14 statements, found {n}'
PY
for file in replay-results/baselines/*.sql; do
  psql -v ON_ERROR_STOP=1 -F $'\t' -A -f "$file" > "${file%.sql}.tsv"
done

# Function signatures, proconfig and hashes must match the live baseline.
python3 - <<'PY'
import csv,pathlib,sys
p=pathlib.Path('replay-results/baselines/01.tsv')
rows=list(csv.DictReader((line for line in p.read_text().splitlines() if line and not line.startswith('(')),delimiter='\t'))
expected={
'_pgr_dijkstra':'d2e3be69befb2e7c03372f924e32f55e',
'_pgr_get_statement':'bc892e85caa1865221ec642c47167681',
'lsv_pgr_astar':'a2e1bfdc78c75b36fddd9d3f693534d0',
'lsv_pgr_bdastar':'e44902d5165b98227b0678b098ea4f71',
'lsv_pgr_dijkstra':'e367e86c06e34374633a029c07a32b0c',
'road_segments_near_route':'4c3bc6eb25bdb4b37d32841745f19d5b',
'route_lsv_candidate':'f61f1800f6e05dd3f9e877c43e7450e9',
'route_lsv_candidate_with_source':'ec9724ec3b7445f92986ea53921b7345'
}
report=[]
for row in rows:
    name=row['proname']; expected_hash=expected.get(name)
    if expected_hash:
        report.append(f"{name}: live={expected_hash} replay={row['definition_md5']} config={row['proconfig']}")
missing=set(expected)-{r['proname'] for r in rows}
report.extend(f'MISSING: {x}' for x in sorted(missing))
pathlib.Path('replay-results/function-comparison.txt').write_text('\n'.join(report)+'\n')
print('\n'.join(report))
if missing: sys.exit('Function baseline missing expected functions')
# Hash differences are reported, not silently called a pass: PostgreSQL version differences may affect formatting.
if any(r['definition_md5']!=expected[r['proname']] for r in rows if r['proname'] in expected):
    pathlib.Path('replay-results/hash-differences.txt').write_text('Hash differences detected: compare normalized definitions manually before approval.\n')
PY

# Smoke test is isolated and rolled back; never seed the production graph.
cat > replay-results/smoke.sql <<'SQL'
BEGIN;
INSERT INTO public.road_nodes(osm_node_id,geom,lsv_component)
VALUES
(-900001,extensions.st_setsrid(extensions.st_point(-117.3000,33.0500),4326),900001),
(-900002,extensions.st_setsrid(extensions.st_point(-117.2990,33.0500),4326),900001),
(-900003,extensions.st_setsrid(extensions.st_point(-117.2980,33.0500),4326),900001),
(-900004,extensions.st_setsrid(extensions.st_point(-117.2990,33.0510),4326),900001);
INSERT INTO public.road_edges(osm_way_id,osm_segment_index,direction,source_node_id,target_node_id,geom,length_m,highway_type,lsv_status,maxspeed_mph,lsv_component,x1_m,y1_m,x2_m,y2_m)
SELECT -900000-e.i,0,'forward',s.id,t.id,
 extensions.st_makeline(s.geom,t.geom),e.cost,'residential',e.status,e.speed,900001,
 extensions.st_x(s.geom),extensions.st_y(s.geom),extensions.st_x(t.geom),extensions.st_y(t.geom)
FROM (VALUES
 (1,-900001,-900002,100.0,'verified_eligible'::text,25::numeric),
 (2,-900002,-900003,100.0,'unknown'::text,NULL::numeric),
 (3,-900001,-900004,50.0,'restricted'::text,25::numeric),
 (4,-900004,-900003,50.0,'verified_eligible'::text,25::numeric)
) AS e(i,from_osm,to_osm,cost,status,speed)
JOIN public.road_nodes s ON s.osm_node_id=e.from_osm
JOIN public.road_nodes t ON t.osm_node_id=e.to_osm;
SELECT 'allow_unknown=true' as case_name,* FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,true,100);
SELECT 'allow_unknown=false' as case_name,* FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,false,100);
ROLLBACK;
SQL
psql -v ON_ERROR_STOP=1 -F $'\t' -A -f replay-results/smoke.sql > replay-results/smoke-output.tsv
cat replay-results/smoke-output.tsv
echo 'Smoke executed; review outputs for restricted-road exclusion and unknown-speed behavior.' > replay-results/smoke-review.txt
