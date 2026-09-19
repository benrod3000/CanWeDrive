create index if not exists road_edges_import_run_idx
  on public.road_edges (import_run_id);

create index if not exists turn_restrictions_import_run_idx
  on public.turn_restrictions (import_run_id);