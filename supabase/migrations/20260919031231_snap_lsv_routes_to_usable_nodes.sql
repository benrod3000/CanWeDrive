create or replace function public.route_lsv_candidate(
  start_lon double precision,
  start_lat double precision,
  end_lon double precision,
  end_lat double precision,
  allow_unknown boolean default true,
  snap_max_distance_meters double precision default 500
)
returns table(
  path_seq integer,
  edge_id bigint,
  edge_name text,
  edge_status text,
  maxspeed_mph numeric,
  length_m double precision,
  geom_geojson jsonb
)
language plpgsql
stable
set search_path to 'extensions, public'
as $function$
declare
  start_node bigint;
  end_node bigint;
  graph_sql text;
begin
  if allow_unknown then
    select n.id into start_node
    from public.road_nodes n
    where extensions.st_dwithin(
      n.geom::extensions.geography,
      extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)::extensions.geography,
      snap_max_distance_meters
    )
    and exists (
      select 1 from public.road_edges e
      where (e.source_node_id=n.id or e.target_node_id=n.id)
        and e.lsv_status in ('verified_eligible','unknown')
        and (e.maxspeed_mph is null or e.maxspeed_mph <= 35)
    )
    order by n.geom operator(extensions.<->)
      extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)
    limit 1;

    select n.id into end_node
    from public.road_nodes n
    where extensions.st_dwithin(
      n.geom::extensions.geography,
      extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)::extensions.geography,
      snap_max_distance_meters
    )
    and exists (
      select 1 from public.road_edges e
      where (e.source_node_id=n.id or e.target_node_id=n.id)
        and e.lsv_status in ('verified_eligible','unknown')
        and (e.maxspeed_mph is null or e.maxspeed_mph <= 35)
    )
    order by n.geom operator(extensions.<->)
      extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)
    limit 1;

    graph_sql := $graph$
      select id, source_node_id as source, target_node_id as target,
        length_m as cost, -1::double precision as reverse_cost
      from public.road_edges
      where lsv_status in ('verified_eligible','unknown')
        and (maxspeed_mph is null or maxspeed_mph <= 35)
    $graph$;
  else
    select n.id into start_node
    from public.road_nodes n
    where extensions.st_dwithin(
      n.geom::extensions.geography,
      extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)::extensions.geography,
      snap_max_distance_meters
    )
    and exists (
      select 1 from public.road_edges e
      where (e.source_node_id=n.id or e.target_node_id=n.id)
        and e.lsv_status = 'verified_eligible'
        and (e.maxspeed_mph is null or e.maxspeed_mph <= 35)
    )
    order by n.geom operator(extensions.<->)
      extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)
    limit 1;

    select n.id into end_node
    from public.road_nodes n
    where extensions.st_dwithin(
      n.geom::extensions.geography,
      extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)::extensions.geography,
      snap_max_distance_meters
    )
    and exists (
      select 1 from public.road_edges e
      where (e.source_node_id=n.id or e.target_node_id=n.id)
        and e.lsv_status = 'verified_eligible'
        and (e.maxspeed_mph is null or e.maxspeed_mph <= 35)
    )
    order by n.geom operator(extensions.<->)
      extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)
    limit 1;

    graph_sql := $graph$
      select id, source_node_id as source, target_node_id as target,
        length_m as cost, -1::double precision as reverse_cost
      from public.road_edges
      where lsv_status = 'verified_eligible'
        and (maxspeed_mph is null or maxspeed_mph <= 35)
    $graph$;
  end if;

  if start_node is null or end_node is null then return; end if;

  return query
  select p.path_seq::integer, e.id, e.name, e.lsv_status, e.maxspeed_mph,
    e.length_m, extensions.st_asgeojson(e.geom)::jsonb
  from extensions.pgr_dijkstra(graph_sql,start_node,end_node,true) p
  join public.road_edges e on e.id=p.edge
  where p.edge<>-1
  order by p.path_seq;
end;
$function$;
