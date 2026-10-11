alter table public.road_nodes add column if not exists lsv_component bigint;

with components as (
  select node, component
  from extensions.pgr_connectedComponents(
    'select id, source_node_id as source, target_node_id as target, 1::float8 as cost from public.road_edges where lsv_status in (''verified_eligible'',''unknown'') and (maxspeed_mph is null or maxspeed_mph <= 35)'
  )
)
update public.road_nodes n
set lsv_component = c.component
from components c
where c.node = n.id;

create index if not exists road_nodes_lsv_component_idx on public.road_nodes(lsv_component);

create or replace function public.route_lsv_candidate(
  start_lon double precision,
  start_lat double precision,
  end_lon double precision,
  end_lat double precision,
  allow_unknown boolean default true,
  snap_max_distance_meters double precision default 500
)
returns table (
  path_seq integer,
  edge_id bigint,
  edge_name text,
  edge_status text,
  maxspeed_mph numeric,
  length_m double precision,
  geom_geojson jsonb
)
set search_path = ''
language plpgsql
stable
as $$
declare
  start_node bigint;
  end_node bigint;
  graph_sql text;
begin
  if allow_unknown then
    graph_sql := $graph$
      select id, source_node_id as source, target_node_id as target,
        length_m as cost, -1::double precision as reverse_cost
      from public.road_edges
      where lsv_status in ('verified_eligible', 'unknown')
        and (maxspeed_mph is null or maxspeed_mph <= 35)
    $graph$;
  else
    graph_sql := $graph$
      select id, source_node_id as source, target_node_id as target,
        length_m as cost, -1::double precision as reverse_cost
      from public.road_edges
      where lsv_status = 'verified_eligible'
        and (maxspeed_mph is null or maxspeed_mph <= 35)
    $graph$;
  end if;

  with start_candidates as (
    select n.id, n.lsv_component,
      extensions.st_distance(
        n.geom::extensions.geography,
        extensions.st_setsrid(extensions.st_point(start_lon, start_lat),4326)::extensions.geography
      ) as distance_m
    from public.road_nodes n
    where n.lsv_component is not null
      and extensions.st_dwithin(
        n.geom::extensions.geography,
        extensions.st_setsrid(extensions.st_point(start_lon, start_lat),4326)::extensions.geography,
        snap_max_distance_meters
      )
  ), end_candidates as (
    select n.id, n.lsv_component,
      extensions.st_distance(
        n.geom::extensions.geography,
        extensions.st_setsrid(extensions.st_point(end_lon, end_lat),4326)::extensions.geography
      ) as distance_m
    from public.road_nodes n
    where n.lsv_component is not null
      and extensions.st_dwithin(
        n.geom::extensions.geography,
        extensions.st_setsrid(extensions.st_point(end_lon, end_lat),4326)::extensions.geography,
        snap_max_distance_meters
      )
  )
  select s.id, e.id
  into start_node, end_node
  from start_candidates s
  join end_candidates e on e.lsv_component = s.lsv_component
  order by s.distance_m + e.distance_m
  limit 1;

  if start_node is null or end_node is null then
    return;
  end if;

  return query
  select p.path_seq::integer, e.id, e.name, e.lsv_status,
    e.maxspeed_mph, e.length_m, extensions.st_asgeojson(e.geom)::jsonb
  from extensions.pgr_dijkstra(graph_sql, start_node, end_node, true) p
  join public.road_edges e on e.id = p.edge
  where p.edge <> -1
  order by p.path_seq;
end;
$$;

revoke all on function public.route_lsv_candidate(double precision,double precision,double precision,double precision,boolean,double precision) from public;
grant execute on function public.route_lsv_candidate(double precision,double precision,double precision,double precision,boolean,double precision) to anon, authenticated;
