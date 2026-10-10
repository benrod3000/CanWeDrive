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

# Permanent CI checks the applied migration version/name pairs, not a
# production schema snapshot that becomes stale as the application evolves.
python3 - <<'PY'
import json,pathlib,subprocess,sys
root=pathlib.Path('replay-results')
expected=[{'version':p.name[:14],'name':p.name[15:-4]} for p in sorted(pathlib.Path('supabase/migrations').glob('*.sql'))]
query="select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select version,name from supabase_migrations.schema_migrations order by version) t"
proc=subprocess.run(['psql','-v','ON_ERROR_STOP=1','-Atc',query],capture_output=True,text=True)
if proc.returncode:
    print('MIGRATION HISTORY FAIL: '+proc.stderr,file=sys.stderr)
    sys.exit(1)
actual=json.loads(proc.stdout.strip())
(root/'migration-history.json').write_text(json.dumps(actual,indent=2)+'\n')
if len(expected)<48 or actual!=expected:
    print(f'MIGRATION HISTORY FAIL: expected {len(expected)} file pairs, got {len(actual)} database pairs',file=sys.stderr)
    print('EXPECTED:',expected,file=sys.stderr)
    print('ACTUAL:',actual,file=sys.stderr)
    sys.exit(1)
print(f'MIGRATION HISTORY PASS ({len(actual)} version/name pairs; original 48 included)')
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
# Run smoke even when parity failed; capture both API-role results and all errors.
set +e
psql -v ON_ERROR_STOP=1 -F $'\t' -A -f replay-results/smoke.sql > replay-results/smoke-output.tsv 2>&1
smoke_exit=$?
set -e
cat replay-results/smoke-output.tsv
if [ "$smoke_exit" -eq 0 ] && grep -q 'PASS anon true=' replay-results/smoke-output.tsv && grep -q 'PASS authenticated true=' replay-results/smoke-output.tsv; then
  echo 'PASS: both API roles asserted routing outcomes and restricted-road exclusion.' | tee replay-results/smoke-review.txt
else
  echo "FAIL: role-based smoke test exit=$smoke_exit or missing assertions" | tee replay-results/smoke-review.txt
fi
# Green requires the smoke assertions; migrations and history already failed
# the job if unsuccessful.
if ! grep -q '^PASS:' replay-results/smoke-review.txt; then
  echo 'FINAL REPLAY STATUS: FAIL (smoke assertions)' >&2
  exit 1
fi
echo 'FINAL REPLAY STATUS: PASS'
