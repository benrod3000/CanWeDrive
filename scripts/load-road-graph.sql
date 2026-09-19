\set ON_ERROR_STOP on

begin;

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
  speed_source text
) on commit drop;

\copy stage_nodes from 'data/road-import/nodes.csv' with (format csv, header true)

\copy stage_edges from 'data/road-import/edges.csv' with (format csv, header true)

truncate table public.road_edges, public.road_nodes restart identity cascade;

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
  import_run_id
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
  :import_run_id
from stage_edges s
join public.road_nodes source_node
  on source_node.osm_node_id = s.source_osm_node_id
join public.road_nodes target_node
  on target_node.osm_node_id = s.target_osm_node_id;

update public.import_runs
set
  completed_at = now(),
  status = 'completed',
  record_count = (select count(*) from public.road_edges),
  notes = 'Imported directed road graph from the North County Southern California OSM extract.'
where id = :import_run_id;

commit;
