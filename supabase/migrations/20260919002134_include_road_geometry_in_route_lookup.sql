drop function if exists public.road_segments_near_route(jsonb, double precision);

create function public.road_segments_near_route(
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
  distance_meters double precision,
  geom_geojson jsonb
)
language sql
stable
set search_path = ''
as $$
  with route as (
    select
      extensions.st_setsrid(
        extensions.st_geomfromgeojson(route_geojson::text),
        4326
      ) as geom
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
    extensions.st_distance(
      r.geom::extensions.geography,
      route.geom::extensions.geography
    ) as distance_meters,
    extensions.st_asgeojson(r.geom)::jsonb as geom_geojson
  from public.road_segments r
  cross join route
  where extensions.st_dwithin(
    r.geom::extensions.geography,
    route.geom::extensions.geography,
    max_distance_meters
  )
  order by distance_meters asc;
$$;

grant execute on function public.road_segments_near_route(jsonb, double precision)
  to anon, authenticated;
