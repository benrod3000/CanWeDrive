create or replace function public.lsv_pgr_bdastar(graph_sql text,start_node bigint,end_node bigint)
returns table(path_seq integer,edge bigint,cost double precision,agg_cost double precision)
language sql stable as $$ select p.path_seq,p.edge,p.cost,p.agg_cost from extensions.pgr_bdastar($1,$2,$3,true,2,1.0,1.0) p $$;
grant execute on function public.lsv_pgr_bdastar(text,bigint,bigint) to anon,authenticated;
create or replace function public.route_lsv_candidate(start_lon double precision,start_lat double precision,end_lon double precision,end_lat double precision,allow_unknown boolean default true,snap_max_distance_meters double precision default 500)
returns table(path_seq integer,edge_id bigint,edge_name text,edge_status text,maxspeed_mph numeric,length_m double precision,geom_geojson jsonb)
language plpgsql stable as $$
declare start_node bigint; end_node bigint; graph_sql text; component_id bigint;
begin
 with sc as (select n.id,n.lsv_component,extensions.st_distance(n.geom::extensions.geography,extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)::extensions.geography) d from public.road_nodes n where n.lsv_component is not null and extensions.st_dwithin(n.geom::extensions.geography,extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326)::extensions.geography,snap_max_distance_meters) order by n.geom operator(extensions.<->) extensions.st_setsrid(extensions.st_point(start_lon,start_lat),4326) limit 48), ec as (select n.id,n.lsv_component,extensions.st_distance(n.geom::extensions.geography,extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)::extensions.geography) d from public.road_nodes n where n.lsv_component is not null and extensions.st_dwithin(n.geom::extensions.geography,extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326)::extensions.geography,snap_max_distance_meters) order by n.geom operator(extensions.<->) extensions.st_setsrid(extensions.st_point(end_lon,end_lat),4326) limit 48)
 select s.id,e.id,s.lsv_component into start_node,end_node,component_id from sc s join ec e on e.lsv_component=s.lsv_component order by s.d+e.d limit 1;
 if start_node is null or end_node is null then return; end if;
 graph_sql:=format($g$select id,source_node_id source,target_node_id target,length_m cost,-1::double precision reverse_cost,x1_m x1,y1_m y1,x2_m x2,y2_m y2 from public.road_edges where lsv_component=%L and lsv_status in ('verified_eligible','unknown') and (maxspeed_mph is null or maxspeed_mph<=35)$g$,component_id);
 return query select p.path_seq,e.id,e.name,e.lsv_status,e.maxspeed_mph,e.length_m,extensions.st_asgeojson(e.geom)::jsonb from public.lsv_pgr_bdastar(graph_sql,start_node,end_node) p join public.road_edges e on e.id=p.edge where p.edge<>-1 order by p.path_seq;
end; $$;
revoke all on function public.route_lsv_candidate(double precision,double precision,double precision,double precision,boolean,double precision) from public;
grant execute on function public.route_lsv_candidate(double precision,double precision,double precision,double precision,boolean,double precision) to anon,authenticated;
