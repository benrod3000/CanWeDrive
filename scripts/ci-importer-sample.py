#!/usr/bin/env python3
"""Isolated importer contract test. NEVER executes scripts/load-road-graph.sql."""
import csv,json,pathlib,re,subprocess,sys
root=pathlib.Path("replay-results/importer")
root.mkdir(parents=True,exist_ok=True)
def feature(way,nodes,tags):
    return {"type":"Feature","properties":{"@id":str(way),"@way_nodes":nodes,**tags},
            "geometry":{"type":"LineString","coordinates":[[-117.30+i*.001,33.05+(way-9100)*.001] for i in range(len(nodes))]}}
# Six cases: bidirectional, forward one-way, reverse one-way,
# private hard block, directional/raw-speed provenance, destination restriction.
cases=[
 feature(9101,[101,102],{"highway":"residential","maxspeed":"25 mph","name":"Two way"}),
 feature(9102,[201,202],{"highway":"residential","oneway":"yes","maxspeed":"20 mph"}),
 feature(9103,[301,302],{"highway":"residential","oneway":"-1","maxspeed":"30 mph"}),
 feature(9104,[401,402],{"highway":"service","access":"private","maxspeed":"15 mph"}),
 feature(9106,[601,602],{"highway":"service","access":"destination","maxspeed":"15 mph"}),
 feature(9105,[501,502],{"highway":"residential","maxspeed":"25 mph","maxspeed:forward":"30 mph",
   "maxspeed:backward":"20 mph","source:maxspeed":"sign","maxspeed:type":"US:urban",
   "maxspeed:source":"survey","name":'A "quoted", road'}),
]
src=root/"sample.geojsonseq"
src.write_text("".join(json.dumps(x)+"\n" for x in cases))
subprocess.run(["node","scripts/build-road-import.mjs",str(src),str(root)],check=True)
def rows(p):
    with open(p,newline="") as f: return list(csv.DictReader(f))
edges=rows(root/"edges.csv"); nodes=rows(root/"nodes.csv")
by={i:[e for e in edges if e["osm_way_id"]==str(i)] for i in range(9101,9107)}
def check(label,ok):
    print(("PASS " if ok else "FAIL ")+label,flush=True)
    if not ok: raise AssertionError(label)
check("case 1 bidirectional",len(by[9101])==2 and [e["direction"] for e in by[9101]]==["forward","backward"])
check("case 2 forward one-way",len(by[9102])==1 and by[9102][0]["direction"]=="forward")
check("case 3 reverse one-way",len(by[9103])==1 and by[9103][0]["direction"]=="backward" and by[9103][0]["source_osm_node_id"]=="302")
check("case 4 access=private verified_blocked",len(by[9104])==2 and all(e["lsv_status"]=="verified_blocked" for e in by[9104]))
check("case 6 access=destination restricted",len(by[9106])==2 and all(e["lsv_status"]=="restricted" for e in by[9106]))
expected_raw={"osm_maxspeed_raw":"25 mph","osm_maxspeed_forward_raw":"30 mph",
 "osm_maxspeed_backward_raw":"20 mph","osm_source_maxspeed_raw":"sign",
 "osm_maxspeed_type_raw":"US:urban","osm_maxspeed_source_raw":"survey"}
check("case 5 raw speed tags and directional speeds",
 len(by[9105])==2 and all(all(e[k]==v for k,v in expected_raw.items()) for e in by[9105])
 and [round(float(e["maxspeed_mph"])) for e in by[9105]]==[30,20]
 and all(e["speed_source"]=="sign" for e in by[9105]))
check("CSV quoting, node references and totals",len(edges)==10 and len(nodes)==12
 and all(e["source_osm_node_id"] in {n["osm_node_id"] for n in nodes} and e["target_osm_node_id"] in {n["osm_node_id"] for n in nodes} for e in edges)
 and any(e["name"]=='A "quoted", road' for e in edges))
# The real loader's INSERT is executed (never its TRUNCATE) inside a
# transaction that rolls back. Stage DDL and INSERT are extracted verbatim.
loader=pathlib.Path("scripts/load-road-graph.sql").read_text()
builder_header=next(csv.reader((root/"edges.csv").open()))
stage=re.search(r"create temp table stage_edges\s*\(.*?\)\s*on commit drop;",loader,re.S|re.I)
stage_nodes=re.search(r"create temp table stage_nodes\s*\(.*?\)\s*on commit drop;",loader,re.S|re.I)
insert=re.search(r"insert into public\.road_edges\s*\(.*?\)\s*select\s+.*?\s+from stage_edges s\s+join public\.road_nodes source_node.*?join public\.road_nodes target_node.*?;",loader,re.S|re.I)
check("real loader stage declarations and insert located",all((stage,stage_nodes,insert)))
check("loader INSERT has import_run_id binding",":import_run_id" in insert.group())
stage_cols=[re.match(r"\s*(\w+)",line).group(1) for line in stage.group().split("(",1)[1].rsplit(")",1)[0].split(",\n") if line.strip()]
check("real loader staging columns equal CSV header",stage_cols==builder_header)
node_insert=re.search(r"insert into public\.road_nodes\s*\(.*?\)\s*select\s+.*?\s+from stage_nodes;",loader,re.S|re.I)
check("real loader node insert located",node_insert is not None)
sql=root/"stage.sql"
post=pathlib.Path("scripts/post-import-components.sql").read_text()
post=re.sub(r"^\s*BEGIN;\s*","",post,flags=re.I|re.M)
post=re.sub(r"^\s*COMMIT;\s*","",post,flags=re.I|re.M)
sql.write_text(
 "BEGIN;\n"
 +"INSERT INTO public.import_runs(source_name,status) VALUES ('ci-fixture','running') RETURNING id AS import_run_id \\gset\n"
 +stage_nodes.group()+"\n"+stage.group()+"\n"
 +f"\\copy stage_nodes FROM '{(root/'nodes.csv').resolve()}' WITH (FORMAT csv,HEADER true)\n"
 +f"\\copy stage_edges FROM '{(root/'edges.csv').resolve()}' WITH (FORMAT csv,HEADER true)\n"
 +node_insert.group()+"\n"+insert.group()+"\n"
 +post+"\n"
 +"""DO $assert$
 DECLARE bad int;
 BEGIN
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9106)<>10
 THEN RAISE EXCEPTION 'real loader inserted wrong number of edges'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9105 AND osm_source_maxspeed_raw='sign')<>2
 THEN RAISE EXCEPTION 'raw speed tags lost in real insert'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9104 AND lsv_status='verified_blocked')<>2
 THEN RAISE EXCEPTION 'private hard-block status lost in real insert'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9106 AND lsv_status='restricted')<>2
 THEN RAISE EXCEPTION 'destination restriction lost in real insert'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9106
   AND (x1_m IS NULL OR y1_m IS NULL OR x2_m IS NULL OR y2_m IS NULL))
 THEN RAISE EXCEPTION 'projected endpoints missing'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9106
   AND (abs(x1_m-extensions.st_x(extensions.st_transform(extensions.st_startpoint(geom),3857)))>0.1
     OR abs(y1_m-extensions.st_y(extensions.st_transform(extensions.st_startpoint(geom),3857)))>0.1))
 THEN RAISE EXCEPTION 'projected endpoints inconsistent'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_nodes n WHERE n.osm_node_id IN (101,102,201,202,301,302,501,502) AND n.lsv_component IS NULL)
 THEN RAISE EXCEPTION 'eligible nodes missing components'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_nodes n WHERE n.osm_node_id IN (401,402,601,602) AND n.lsv_component IS NOT NULL)
 THEN RAISE EXCEPTION 'blocked/restricted-only nodes assigned components'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges e JOIN public.road_nodes n ON n.id=e.source_node_id
 WHERE e.osm_way_id BETWEEN 9101 AND 9106 AND e.lsv_component IS DISTINCT FROM n.lsv_component)
 THEN RAISE EXCEPTION 'edge component differs from source node'; END IF;
 IF (SELECT count(*) FROM public.lsv_component_stats WHERE is_primary)<>1
 THEN RAISE EXCEPTION 'exactly one primary component required'; END IF;
 IF (SELECT coalesce(sum(node_count),0) FROM public.lsv_component_stats) <>
    (SELECT count(*) FROM public.road_nodes WHERE lsv_component IS NOT NULL)
 THEN RAISE EXCEPTION 'component stats total does not equal assigned nodes'; END IF;
 IF EXISTS (SELECT 1 FROM public.lsv_component_stats s
 WHERE node_count <> (SELECT count(*) FROM public.road_nodes n WHERE n.lsv_component=s.component))
 THEN RAISE EXCEPTION 'component stats counts incorrect'; END IF;
 RAISE NOTICE 'PASS actual loader insert, raw speed preservation, components, stats, projected endpoints';
 END $assert$;
 ROLLBACK;
 """)
with open(root/"staging-output.txt","w") as out:
    result=subprocess.run(["psql","-v","ON_ERROR_STOP=1","-f",str(sql)],stdout=out,stderr=subprocess.STDOUT,text=True)
if result.returncode:
    print((root/"staging-output.txt").read_text()[-5000:])
check("real loader insert and post-import inside rolled-back CI transaction",result.returncode==0)
(root/"results.json").write_text(json.dumps({"cases":6,"edges":len(edges),"nodes":len(nodes),"loader_columns":len(stage_cols),"result":"PASS"},indent=2)+"\n")
print("IMPORTER SAMPLE TEST PASS",flush=True)
