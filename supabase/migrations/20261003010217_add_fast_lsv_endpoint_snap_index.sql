create index if not exists road_nodes_geom_gist_idx on public.road_nodes using gist (geom); create index if not exists road_nodes_component_id_idx on public.road_nodes (lsv_component, id);
