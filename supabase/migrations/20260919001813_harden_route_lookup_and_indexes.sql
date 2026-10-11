create index if not exists speed_verifications_road_segment_id_idx
  on public.speed_verifications (road_segment_id);

create or replace function public.road_segments_near_route(
  route_geojson jsonb,
  max_distance_meters double precision default 30
)
returns table (
  id bigint,
  osm_id bigint,
  name text,
  highway_type text,
  maxspeed_mph numeric,
  oneway boolean,
  access text,
  lsv_status text,
  speed_source text,
  speed_verified_at timestamptz,
  distance_meters double precision
)
language sql
stable
set search_path = public
as $$
  with route as (
    select
      st_setsrid(st_geomfromgeojson(route_geojson::text), 4326) as geom
  )
  select
    r.id,
    r.osm_id,
    r.name,
    r.highway_type,
    r.maxspeed_mph,
    r.oneway,
    r.access,
    r.lsv_status,
    r.speed_source,
    r.speed_verified_at,
    st_distance(r.geom::geography, route.geom::geography) as distance_meters
  from public.road_segments r
  cross join route
  where st_dwithin(
    r.geom::geography,
    route.geom::geography,
    max_distance_meters
  )
  order by distance_meters asc;
$$;

grant execute on function public.road_segments_near_route(jsonb, double precision)
  to anon, authenticated;
