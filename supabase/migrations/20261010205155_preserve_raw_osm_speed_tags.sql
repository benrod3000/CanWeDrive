ALTER TABLE public.road_edges
  ADD COLUMN IF NOT EXISTS osm_maxspeed_raw text,
  ADD COLUMN IF NOT EXISTS osm_maxspeed_forward_raw text,
  ADD COLUMN IF NOT EXISTS osm_maxspeed_backward_raw text,
  ADD COLUMN IF NOT EXISTS osm_source_maxspeed_raw text,
  ADD COLUMN IF NOT EXISTS osm_maxspeed_type_raw text,
  ADD COLUMN IF NOT EXISTS osm_maxspeed_source_raw text;

COMMENT ON COLUMN public.road_edges.osm_maxspeed_raw IS 'Raw OSM maxspeed tag value before unit parsing or normalization.';
COMMENT ON COLUMN public.road_edges.osm_maxspeed_forward_raw IS 'Raw OSM maxspeed:forward tag value.';
COMMENT ON COLUMN public.road_edges.osm_maxspeed_backward_raw IS 'Raw OSM maxspeed:backward tag value.';
COMMENT ON COLUMN public.road_edges.osm_source_maxspeed_raw IS 'Raw OSM source:maxspeed tag; metadata, not proof of independent field verification.';
COMMENT ON COLUMN public.road_edges.osm_maxspeed_type_raw IS 'Raw OSM maxspeed:type tag value.';
COMMENT ON COLUMN public.road_edges.osm_maxspeed_source_raw IS 'Raw deprecated/alternate OSM maxspeed:source tag value.';
