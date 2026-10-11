-- Run only AFTER staging/import completes. This is NOT the full graph loader.
-- Requires pgRouting in extensions; assigns connected components over legal edges.
-- Production execution is intentionally on hold.
BEGIN;
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

UPDATE public.road_edges
SET x1_m=extensions.st_x(extensions.st_transform(extensions.st_startpoint(geom),3857)),
    y1_m=extensions.st_y(extensions.st_transform(extensions.st_startpoint(geom),3857)),
    x2_m=extensions.st_x(extensions.st_transform(extensions.st_endpoint(geom),3857)),
    y2_m=extensions.st_y(extensions.st_transform(extensions.st_endpoint(geom),3857));

DELETE FROM public.lsv_component_stats;
INSERT INTO public.lsv_component_stats(component,node_count,is_primary)
SELECT lsv_component,count(*)::bigint,
       row_number() over(order by count(*) DESC,lsv_component ASC)=1
FROM public.road_nodes
WHERE lsv_component IS NOT NULL
GROUP BY lsv_component;
COMMIT;
