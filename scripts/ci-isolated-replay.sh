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

# Assert every baseline row (excluding the data-dependent component-stats count).
# JSON row objects avoid psql's TSV NULL/array formatting ambiguities.
python3 - <<'PY'
import json,pathlib,re,subprocess,sys,difflib
root=pathlib.Path('replay-results')
baseline={}
for p in ('scripts/replay-production-baseline-01-07.json','scripts/replay-production-baseline-08-14.json'):
    baseline.update(json.loads(pathlib.Path(p).read_text()))
failures=[]
for i in range(1,15):
    if i==10: continue  # Component stats rows depend on imported data.
    sql=(root/'baselines'/f'{i:02}.sql').read_text().strip().rstrip(';')
    query="select coalesce(json_agg(row_to_json(t)), '[]'::json) from ("+sql+") t"
    proc=subprocess.run(['psql','-v','ON_ERROR_STOP=1','-Atc',query],capture_output=True,text=True)
    if proc.returncode:
        failures.append(f'BASELINE {i:02}: SQL ERROR: {proc.stderr}')
        continue
    actual=json.loads(proc.stdout.strip())
    (root/'baselines'/f'{i:02}.json').write_text(json.dumps(actual,indent=2,sort_keys=True)+'\n')
    expected=baseline[f'{i:02}']
    # Query ORDER BY defines row order; normalize object-key ordering only.
    if actual!=expected:
        lhs=json.dumps(expected,indent=2,sort_keys=True).splitlines()
        rhs=json.dumps(actual,indent=2,sort_keys=True).splitlines()
        diff='\n'.join(difflib.unified_diff(lhs,rhs,fromfile='production',tofile='replay',lineterm=''))
        failures.append(f'BASELINE {i:02} MISMATCH:\n{diff}')
    else: print(f'BASELINE {i:02} PASS ({len(actual)} rows)')
# Compare the migration version/name pair set, not just the count.
sql="select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select version,name from supabase_migrations.schema_migrations order by version) t"
proc=subprocess.run(['psql','-v','ON_ERROR_STOP=1','-Atc',sql],capture_output=True,text=True)
if proc.returncode: failures.append('MIGRATION HISTORY QUERY ERROR: '+proc.stderr)
else:
    actual=json.loads(proc.stdout.strip())
    (root/'migration-history.json').write_text(json.dumps(actual,indent=2)+'\n')
    expected_pairs=[{'version':p.name[:14],'name':p.name[15:-4]} for p in sorted(pathlib.Path('supabase/migrations').glob('*.sql'))]
    if len(expected_pairs)!=48 or actual!=expected_pairs:
        failures.append('MIGRATION VERSION/NAME PAIRS MISMATCH: '+repr(actual))
    else: print(f'MIGRATION HISTORY PASS ({len(actual)} rows)')
# Dedicated function output with strict proconfig/hash/signature checks.
actual=json.loads((root/'baselines'/'01.json').read_text()) if (root/'baselines'/'01.json').exists() else []
expected=baseline['01']
report=[]
for i in range(max(len(actual),len(expected))):
    x=actual[i] if i<len(actual) else None
    y=expected[i] if i<len(expected) else None
    report.append(f"{y['proname'] if y else '<unexpected>'}: live={y['definition_md5'] if y else 'missing'} replay={x['definition_md5'] if x else 'missing'} live_config={y['proconfig'] if y else 'missing'} replay_config={x['proconfig'] if x else 'missing'} signature={x['args'] if x else 'missing'}")
(root/'function-comparison.txt').write_text('\n'.join(report)+'\n')
print('\n'.join(report))
(root/'parity-differences.txt').write_text('\n\n'.join(failures) if failures else 'All 13 data-independent baseline queries and migration pairs match exactly.\n')
if failures:
    print('\n\n'.join(failures),file=sys.stderr)
    sys.exit(1)
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
SET LOCAL ROLE anon;
DO $smoke$
DECLARE statuses text[]; restricted_count integer; blocked_count integer;
BEGIN
  SELECT array_agg(edge_status ORDER BY path_seq),
         count(*) FILTER (WHERE edge_status IN ('restricted','verified_blocked'))
    INTO statuses,restricted_count
  FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,true,100);
  IF statuses IS DISTINCT FROM ARRAY['verified_eligible','unknown']::text[] OR restricted_count <> 0 THEN
    RAISE EXCEPTION 'anon allow_unknown=true: expected [verified_eligible,unknown], got %, restricted count %',statuses,restricted_count;
  END IF;
  SELECT count(*) INTO blocked_count FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,false,100);
  IF blocked_count <> 0 THEN RAISE EXCEPTION 'anon allow_unknown=false: expected 0 rows, got %',blocked_count; END IF;
  RAISE NOTICE 'PASS anon true=[verified_eligible,unknown] false=0 restricted=0';
END
$smoke$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $smoke$
DECLARE statuses text[]; restricted_count integer; blocked_count integer;
BEGIN
  SELECT array_agg(edge_status ORDER BY path_seq),
         count(*) FILTER (WHERE edge_status IN ('restricted','verified_blocked'))
    INTO statuses,restricted_count
  FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,true,100);
  IF statuses IS DISTINCT FROM ARRAY['verified_eligible','unknown']::text[] OR restricted_count <> 0 THEN
    RAISE EXCEPTION 'authenticated allow_unknown=true: expected [verified_eligible,unknown], got %, restricted count %',statuses,restricted_count;
  END IF;
  SELECT count(*) INTO blocked_count FROM public.route_lsv_candidate(-117.3000,33.0500,-117.2980,33.0500,false,100);
  IF blocked_count <> 0 THEN RAISE EXCEPTION 'authenticated allow_unknown=false: expected 0 rows, got %',blocked_count; END IF;
  RAISE NOTICE 'PASS authenticated true=[verified_eligible,unknown] false=0 restricted=0';
END
$smoke$;
RESET ROLE;
ROLLBACK;
SQL
psql -v ON_ERROR_STOP=1 -F $'\t' -A -f replay-results/smoke.sql > replay-results/smoke-output.tsv 2>&1
cat replay-results/smoke-output.tsv
grep -q 'PASS anon true=' replay-results/smoke-output.tsv
grep -q 'PASS authenticated true=' replay-results/smoke-output.tsv
echo 'PASS: both API roles asserted routing outcomes and restricted-road exclusion.' > replay-results/smoke-review.txt
