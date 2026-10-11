create or replace function public._pgr_dijkstra(
  edges_sql text,
  start_vids anyarray,
  end_vids anyarray,
  directed boolean,
  only_cost boolean,
  normal boolean,
  n_goals bigint,
  global boolean
)
returns table(
  seq integer,
  path_seq integer,
  start_vid bigint,
  end_vid bigint,
  node bigint,
  edge bigint,
  cost double precision,
  agg_cost double precision
)
language sql
stable
as $$
  select * from extensions._pgr_dijkstra(
    edges_sql,start_vids,end_vids,directed,only_cost,normal,n_goals,global
  )
$$;
