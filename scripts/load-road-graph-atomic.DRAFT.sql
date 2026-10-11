-- DRAFT / DO NOT RUN. NOT APPROVED FOR PRODUCTION.
-- Inherits TRUNCATE without CASCADE from existing loader; dependent FK audit REQUIRED.
-- psql input files must exist. One transaction; stop on any SQL error.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
-- Staging and insertion, import_runs initially 'running'.
insert into public.import_runs (
  source_name,
  source_url,
  source_version,
  bbox,
  status,
  notes
) values (
  'OpenStreetMap / Geofabrik',
  'https://download.geofabrik.de/north-america/us/california/socal-latest.osm.pbf',
  'latest',
  '-117.40,32.98,-117.23,33.30',
  'running',
  'North County San Diego road graph import'
) returning id as import_run_id \gset
\if :{?import_run_id}
\else
\echo 'Missing import_run_id'
\quit 1
\endif

create temp table stage_nodes (
  osm_node_id bigint primary key,
  lon double precision not null,
  lat double precision not null
) on commit drop;

create temp table stage_edges (
  osm_way_id bigint not null,
  osm_segment_index integer not null,
  direction text not null,
  source_osm_node_id bigint not null,
  target_osm_node_id bigint not null,
  geom_wkt text not null,
  length_m double precision not null,
  name text,
  ref text,
  highway_type text not null,
  oneway boolean not null,
  maxspeed_mph numeric,
  maxspeed_forward_mph numeric,
  maxspeed_backward_mph numeric,
  maxspeed_conditional text,
  access text,
  vehicle text,
  motor_vehicle text,
  motorcar text,
  motorroad text,
  lsv_status text not null,
  lsv_reason text,
  speed_source text,
  osm_maxspeed_raw text,
  osm_maxspeed_forward_raw text,
  osm_maxspeed_backward_raw text,
  osm_source_maxspeed_raw text,
  osm_maxspeed_type_raw text,
  osm_maxspeed_source_raw text
) on commit drop;

\copy stage_nodes from 'data/road-import/nodes.csv' with (format csv, header true)

\copy stage_edges from 'data/road-import/edges.csv' with (format csv, header true)

truncate table public.road_edges, public.road_nodes restart identity;

insert into public.road_nodes (
  osm_node_id,
  geom
)
select
  osm_node_id,
  extensions.st_setsrid(
    extensions.st_makepoint(lon, lat),
    4326
  )
from stage_nodes;

insert into public.road_edges (
  osm_way_id,
  osm_segment_index,
  direction,
  source_node_id,
  target_node_id,
  geom,
  length_m,
  name,
  ref,
  highway_type,
  oneway,
  maxspeed_mph,
  maxspeed_forward_mph,
  maxspeed_backward_mph,
  maxspeed_conditional,
  access,
  vehicle,
  motor_vehicle,
  motorcar,
  motorroad,
  lsv_status,
  lsv_reason,
  speed_source,
  osm_maxspeed_raw,
  osm_maxspeed_forward_raw,
  osm_maxspeed_backward_raw,
  osm_source_maxspeed_raw,
  osm_maxspeed_type_raw,
  osm_maxspeed_source_raw,
  import_run_id,
  x1_m, y1_m, x2_m, y2_m
)
select
  s.osm_way_id,
  s.osm_segment_index,
  s.direction,
  source_node.id,
  target_node.id,
  extensions.st_geomfromtext(s.geom_wkt, 4326),
  s.length_m,
  s.name,
  s.ref,
  s.highway_type,
  s.oneway,
  s.maxspeed_mph,
  s.maxspeed_forward_mph,
  s.maxspeed_backward_mph,
  s.maxspeed_conditional,
  s.access,
  s.vehicle,
  s.motor_vehicle,
  s.motorcar,
  s.motorroad,
  s.lsv_status,
  s.lsv_reason,
  s.speed_source,
  s.osm_maxspeed_raw,
  s.osm_maxspeed_forward_raw,
  s.osm_maxspeed_backward_raw,
  s.osm_source_maxspeed_raw,
  s.osm_maxspeed_type_raw,
  s.osm_maxspeed_source_raw,
  :import_run_id,
  extensions.st_x(extensions.st_transform(extensions.st_startpoint(extensions.st_geomfromtext(s.geom_wkt,4326)),3857)),
  extensions.st_y(extensions.st_transform(extensions.st_startpoint(extensions.st_geomfromtext(s.geom_wkt,4326)),3857)),
  extensions.st_x(extensions.st_transform(extensions.st_endpoint(extensions.st_geomfromtext(s.geom_wkt,4326)),3857)),
  extensions.st_y(extensions.st_transform(extensions.st_endpoint(extensions.st_geomfromtext(s.geom_wkt,4326)),3857))
from stage_edges s
join public.road_nodes source_node
  on source_node.osm_node_id = s.source_osm_node_id
join public.road_nodes target_node
  on target_node.osm_node_id = s.target_osm_node_id;
-- Component and projected-coordinate rebuild in SAME transaction.
WITH components AS (
  SELECT node, component
  FROM extensions.pgr_connectedComponents(
    'SELECT id, source_node_id AS source, target_node_id AS target, 1::float8 AS cost
       FROM public.road_edges
      WHERE lsv_status IN (''verified_eligible'',''unknown'')
        AND (maxspeed_mph IS NULL OR maxspeed_mph <= 35)'
  )
)
UPDATE public.road_nodes n
SET lsv_component = c.component
FROM components c
WHERE n.id = c.node;

UPDATE public.road_nodes n SET lsv_component = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.road_edges e
  WHERE (e.source_node_id=n.id OR e.target_node_id=n.id)
    AND e.lsv_status IN ('verified_eligible','unknown')
    AND (e.maxspeed_mph IS NULL OR e.maxspeed_mph<=35)
);

UPDATE public.road_edges e
SET lsv_component = n.lsv_component
FROM public.road_nodes n
WHERE n.id=e.source_node_id;

DELETE FROM public.lsv_component_stats;
INSERT INTO public.lsv_component_stats(component,node_count,is_primary)
SELECT lsv_component,count(*)::bigint,
       row_number() over(order by count(*) DESC,lsv_component ASC)=1
FROM public.road_nodes
WHERE lsv_component IS NOT NULL
GROUP BY lsv_component;

-- Fail the transaction if the derived graph is incomplete.
DO $atomic_assert$
BEGIN
 IF (SELECT count(*) FROM public.road_edges)<>(SELECT count(*) FROM stage_edges)
 THEN RAISE EXCEPTION 'edge stage count mismatch'; END IF;
 IF (SELECT count(*) FROM public.road_nodes)<>(SELECT count(*) FROM stage_nodes)
 THEN RAISE EXCEPTION 'node stage count mismatch'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.road_edges)
 THEN RAISE EXCEPTION 'empty graph'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges e WHERE e.geom IS NULL
   OR extensions.st_isempty(e.geom) OR extensions.st_srid(e.geom)<>4326
   OR e.x1_m IS NULL OR e.y1_m IS NULL OR e.x2_m IS NULL OR e.y2_m IS NULL
   OR abs(e.x1_m-extensions.st_x(extensions.st_transform(extensions.st_startpoint(e.geom),3857)))>0.1
   OR abs(e.y1_m-extensions.st_y(extensions.st_transform(extensions.st_startpoint(e.geom),3857)))>0.1
   OR abs(e.x2_m-extensions.st_x(extensions.st_transform(extensions.st_endpoint(e.geom),3857)))>0.1
   OR abs(e.y2_m-extensions.st_y(extensions.st_transform(extensions.st_endpoint(e.geom),3857)))>0.1)
 THEN RAISE EXCEPTION 'invalid projected coordinates'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges e JOIN public.road_nodes n ON n.id=e.source_node_id
 WHERE e.lsv_component IS DISTINCT FROM n.lsv_component)
 THEN RAISE EXCEPTION 'edge component mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_nodes n WHERE n.lsv_component IS NULL
 AND EXISTS (SELECT 1 FROM public.road_edges e WHERE
 (e.source_node_id=n.id OR e.target_node_id=n.id)
 AND e.lsv_status IN ('verified_eligible','unknown')
 AND (e.maxspeed_mph IS NULL OR e.maxspeed_mph<=35)))
 THEN RAISE EXCEPTION 'eligible node missing component'; END IF;
 IF (SELECT count(*) FROM public.lsv_component_stats WHERE is_primary)<>1
 THEN RAISE EXCEPTION 'primary component count mismatch'; END IF;
 IF (SELECT coalesce(sum(node_count),0) FROM public.lsv_component_stats)<>
 (SELECT count(*) FROM public.road_nodes WHERE lsv_component IS NOT NULL)
 THEN RAISE EXCEPTION 'component stats totals mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.lsv_component_stats s WHERE node_count<>
 (SELECT count(*) FROM public.road_nodes n WHERE n.lsv_component=s.component))
 THEN RAISE EXCEPTION 'component stats row mismatch'; END IF;
END $atomic_assert$;
-- Completion happens ONLY after the post-import assertions above.
DO $complete$
DECLARE affected integer;
BEGIN
 UPDATE public.import_runs SET status='completed', completed_at=now(),
 record_count=(SELECT count(*) FROM public.road_edges),
 notes='Imported and validated road graph in one transaction.'
 WHERE id=:import_run_id AND status='running';
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 1 THEN RAISE EXCEPTION 'expected one completed import, got %',affected; END IF;
END $complete$;
COMMIT;
ANALYZE public.road_nodes;
ANALYZE public.road_edges;
