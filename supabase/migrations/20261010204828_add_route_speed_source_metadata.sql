-- Expose the persisted speed-source label alongside each routed road edge.
-- This is additive: the original route_lsv_candidate RPC remains available.
CREATE OR REPLACE FUNCTION public.route_lsv_candidate_with_source(
  start_lon double precision,
  start_lat double precision,
  end_lon double precision,
  end_lat double precision,
  allow_unknown boolean DEFAULT true,
  snap_max_distance_meters double precision DEFAULT 500
)
RETURNS TABLE(
  path_seq integer,
  edge_id bigint,
  edge_name text,
  edge_status text,
  maxspeed_mph numeric,
  speed_source text,
  length_m double precision,
  geom_geojson jsonb
)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '10000ms'
AS $function$
DECLARE
  start_node bigint;
  end_node bigint;
  graph_sql text;
  component_id bigint;
  buffer_lon double precision;
  buffer_lat double precision;
BEGIN
  buffer_lat := greatest(0.015, abs(end_lat - start_lat) * 0.5);
  buffer_lon := greatest(
    0.015 / greatest(0.25, cos(radians((start_lat + end_lat) / 2))),
    abs(end_lon - start_lon) * 0.75
  );

  WITH sc AS (
    SELECT n.id, n.lsv_component,
      extensions.st_distance(n.geom::extensions.geography, extensions.st_setsrid(extensions.st_point(start_lon, start_lat), 4326)::extensions.geography) d
    FROM public.road_nodes n
    WHERE n.lsv_component IS NOT NULL
      AND extensions.st_dwithin(n.geom::extensions.geography, extensions.st_setsrid(extensions.st_point(start_lon, start_lat), 4326)::extensions.geography, snap_max_distance_meters)
    ORDER BY n.geom operator(extensions.<->) extensions.st_setsrid(extensions.st_point(start_lon, start_lat), 4326)
    LIMIT 48
  ),
  ec AS (
    SELECT n.id, n.lsv_component,
      extensions.st_distance(n.geom::extensions.geography, extensions.st_setsrid(extensions.st_point(end_lon, end_lat), 4326)::extensions.geography) d
    FROM public.road_nodes n
    WHERE n.lsv_component IS NOT NULL
      AND extensions.st_dwithin(n.geom::extensions.geography, extensions.st_setsrid(extensions.st_point(end_lon, end_lat), 4326)::extensions.geography, snap_max_distance_meters)
    ORDER BY n.geom operator(extensions.<->) extensions.st_setsrid(extensions.st_point(end_lon, end_lat), 4326)
    LIMIT 48
  )
  SELECT s.id, e.id, s.lsv_component INTO start_node, end_node, component_id
  FROM sc s JOIN ec e ON e.lsv_component = s.lsv_component
  ORDER BY s.d + e.d LIMIT 1;

  IF start_node IS NULL OR end_node IS NULL THEN RETURN; END IF;

  graph_sql := CASE
    WHEN allow_unknown THEN format(
      $g$SELECT id, source_node_id source, target_node_id target, length_m cost,
        -1::double precision reverse_cost, x1_m x1, y1_m y1, x2_m x2, y2_m y2
      FROM public.road_edges
      WHERE lsv_component = %L
        AND lsv_status IN ('verified_eligible', 'unknown')
        AND (maxspeed_mph IS NULL OR maxspeed_mph <= 35)
        AND geom && extensions.st_makeenvelope(%L, %L, %L, %L, 4326)$g$,
      component_id, least(start_lon,end_lon)-buffer_lon, least(start_lat,end_lat)-buffer_lat,
      greatest(start_lon,end_lon)+buffer_lon, greatest(start_lat,end_lat)+buffer_lat
    )
    ELSE format(
      $g$SELECT id, source_node_id source, target_node_id target, length_m cost,
        -1::double precision reverse_cost, x1_m x1, y1_m y1, x2_m x2, y2_m y2
      FROM public.road_edges
      WHERE lsv_component = %L
        AND lsv_status = 'verified_eligible'
        AND (maxspeed_mph IS NULL OR maxspeed_mph <= 35)
        AND geom && extensions.st_makeenvelope(%L, %L, %L, %L, 4326)$g$,
      component_id, least(start_lon,end_lon)-buffer_lon, least(start_lat,end_lat)-buffer_lat,
      greatest(start_lon,end_lon)+buffer_lon, greatest(start_lat,end_lat)+buffer_lat
    )
  END;

  RETURN QUERY
  SELECT p.path_seq, e.id, e.name, e.lsv_status, e.maxspeed_mph, e.speed_source,
    e.length_m, extensions.st_asgeojson(e.geom)::jsonb
  FROM public.lsv_pgr_bdastar(graph_sql,start_node,end_node) p
  JOIN public.road_edges e ON e.id=p.edge
  WHERE p.edge <> -1
  ORDER BY p.path_seq;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.route_lsv_candidate_with_source(double precision, double precision, double precision, double precision, boolean, double precision) TO anon, authenticated;
