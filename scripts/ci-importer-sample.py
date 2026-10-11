#!/usr/bin/env python3
"""Isolated importer contract test. NEVER executes scripts/load-road-graph.sql."""
import csv,json,pathlib,re,subprocess,sys
root=pathlib.Path("replay-results/importer")
root.mkdir(parents=True,exist_ok=True)
def feature(way,nodes,tags):
    return {"type":"Feature","properties":{"@id":str(way),"@way_nodes":nodes,**tags},
            "geometry":{"type":"LineString","coordinates":[[-117.30+i*.001,33.05+(way-9100)*.001] for i in range(len(nodes))]}}
# Sixteen unique OSM way fixtures, including directional 25/45.
cases=[
 feature(9101,[101,102],{"highway":"residential","maxspeed":"25 mph","name":"Two way"}),
 feature(9102,[201,202],{"highway":"residential","oneway":"yes","maxspeed":"20 mph"}),
 feature(9103,[301,302],{"highway":"residential","oneway":"-1","maxspeed":"30 mph"}),
 feature(9104,[401,402],{"highway":"service","access":"private","maxspeed":"15 mph"}),
 feature(9105,[501,502],{"highway":"residential","maxspeed":"25 mph","maxspeed:forward":"30 mph",
   "maxspeed:backward":"20 mph","source:maxspeed":"sign","maxspeed:type":"US:urban",
   "maxspeed:source":"survey","name":'A "quoted", road'}),
 feature(9106,[601,602],{"highway":"service","access":"destination","maxspeed":"15 mph"}),
 feature(9107,[701,702],{"highway":"residential","name":"Missing speed"}),
 feature(9108,[801,802],{"highway":"primary","maxspeed":"45 mph"}),
 feature(9109,[901,902],{"highway":"residential","maxspeed":"25 mph","maxspeed:conditional":"15 mph @ (Mo-Fr 07:00-09:00)"}),
 feature(9110,[1001,1002],{"highway":"residential","junction":"roundabout","maxspeed":"15 mph"}),
 feature(9111,[1101,1102],{"highway":"footway","maxspeed":"5 mph"}),
 feature(9112,[1201,1202,1203],{"highway":"residential","maxspeed":"30","name":"Two segments"}),
 feature(9113,[1301,1302],{"highway":"residential","motorroad":"yes","maxspeed":"25 mph"}),
 feature(9114,[1401,1402],{"highway":"residential","maxspeed":"25;45"}),
 feature(9115,[1501,1502],{"highway":"residential","maxspeed":"10"}),
 feature(9116,[1601,1602],{"highway":"residential","maxspeed:forward":"25 mph","maxspeed:backward":"45 mph"}),
]
# Fail before writing input if fixtures accidentally reuse an OSM way ID.
way_ids=[int(x["properties"]["@id"]) for x in cases]
if len(way_ids)!=len(set(way_ids)):
    from collections import Counter
    duplicates=sorted(k for k,v in Counter(way_ids).items() if v>1)
    raise AssertionError(f"duplicate fixture OSM way IDs: {duplicates}")
print(f"PASS unique fixture OSM way IDs ({len(way_ids)})",flush=True)
src=root/"sample.geojsonseq"
src.write_text("".join(json.dumps(x)+"\n" for x in cases))
subprocess.run(["node","scripts/build-road-import.mjs",str(src),str(root)],check=True)
def rows(p):
    with open(p,newline="") as f: return list(csv.DictReader(f))
edges=rows(root/"edges.csv"); nodes=rows(root/"nodes.csv")
by={i:[e for e in edges if e["osm_way_id"]==str(i)] for i in range(9101,9117)}
def check(label,ok):
    print(("PASS " if ok else "FAIL ")+label,flush=True)
    if not ok: raise AssertionError(label)
check("case 1 bidirectional",len(by[9101])==2 and [e["direction"] for e in by[9101]]==["forward","backward"])
check("case 2 forward one-way",len(by[9102])==1 and by[9102][0]["direction"]=="forward")
check("case 3 reverse one-way",len(by[9103])==1 and by[9103][0]["direction"]=="backward" and by[9103][0]["source_osm_node_id"]=="302")
check("case 4 access=private verified_blocked",len(by[9104])==2 and all(e["lsv_status"]=="verified_blocked" for e in by[9104]))
check("case 6 access=destination restricted",len(by[9106])==2 and all(e["lsv_status"]=="restricted" for e in by[9106]))
check("case 7 missing speed unknown",len(by[9107])==2 and all(e["lsv_status"]=="unknown" and e["maxspeed_mph"]=="" for e in by[9107]))
check("case 8 over-35 blocked",len(by[9108])==2 and all(e["lsv_status"]=="verified_blocked" for e in by[9108]))
check("case 9 conditional speed unknown",len(by[9109])==2 and all(e["lsv_status"]=="unknown" and e["maxspeed_conditional"]=="15 mph @ (Mo-Fr 07:00-09:00)" for e in by[9109]))
check("case 10 roundabout one-way",len(by[9110])==1 and by[9110][0]["direction"]=="forward")
check("case 11 excluded footway",len(by[9111])==0)
check("case 12 multi-segment and km/h",len(by[9112])==4 and sorted({e["osm_segment_index"] for e in by[9112]})==["0","1"] and all(abs(float(e["maxspeed_mph"])-30/1.609344)<0.01 for e in by[9112]))
check("case 13 motorroad hard blocked",len(by[9113])==2 and all(e["lsv_status"]=="verified_blocked" for e in by[9113]))
check("case 16 asymmetric directional speeds 25/45",len(by[9116])==2 and [e["direction"] for e in by[9116]]==["forward","backward"] and [e["lsv_status"] for e in by[9116]]==["verified_eligible","verified_blocked"] and [round(float(e["maxspeed_mph"])) for e in by[9116]]==[25,45])
check("case 15 observed bare maxspeed=10 follows current km/h policy",len(by[9115])==2 and all(e["osm_maxspeed_raw"]=="10" and abs(float(e["maxspeed_mph"])-10/1.609344)<0.001 and e["lsv_status"]=="verified_eligible" for e in by[9115]))
check("case 14 ambiguous multi-value speed is not verified",len(by[9114])==2 and all(e["osm_maxspeed_raw"]=="25;45" and e["maxspeed_mph"]=="" and e["lsv_status"]=="unknown" for e in by[9114]))
expected_raw={"osm_maxspeed_raw":"25 mph","osm_maxspeed_forward_raw":"30 mph",
 "osm_maxspeed_backward_raw":"20 mph","osm_source_maxspeed_raw":"sign",
 "osm_maxspeed_type_raw":"US:urban","osm_maxspeed_source_raw":"survey"}
check("case 5 raw speed tags and directional speeds",
 len(by[9105])==2 and all(all(e[k]==v for k,v in expected_raw.items()) for e in by[9105])
 and [round(float(e["maxspeed_mph"])) for e in by[9105]]==[30,20]
 and all(e["speed_source"]=="sign" for e in by[9105]))
check("CSV quoting, node references and totals",len(edges)==29 and len(nodes)==31
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
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9116)<>29
 THEN RAISE EXCEPTION 'real loader inserted wrong number of edges'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9105 AND osm_source_maxspeed_raw='sign')<>2
 THEN RAISE EXCEPTION 'raw speed tags lost in real insert'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9104 AND lsv_status='verified_blocked')<>2
 THEN RAISE EXCEPTION 'private hard-block status lost in real insert'; END IF;
 IF (SELECT count(*) FROM public.road_edges WHERE osm_way_id=9106 AND lsv_status='restricted')<>2
 THEN RAISE EXCEPTION 'destination restriction lost in real insert'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9114
   AND (x1_m IS NULL OR y1_m IS NULL OR x2_m IS NULL OR y2_m IS NULL))
 THEN RAISE EXCEPTION 'projected endpoints missing'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges WHERE osm_way_id BETWEEN 9101 AND 9114
   AND (abs(x1_m-extensions.st_x(extensions.st_transform(extensions.st_startpoint(geom),3857)))>0.1
     OR abs(y1_m-extensions.st_y(extensions.st_transform(extensions.st_startpoint(geom),3857)))>0.1
     OR abs(x2_m-extensions.st_x(extensions.st_transform(extensions.st_endpoint(geom),3857)))>0.1
     OR abs(y2_m-extensions.st_y(extensions.st_transform(extensions.st_endpoint(geom),3857)))>0.1))
 THEN RAISE EXCEPTION 'projected endpoints inconsistent'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_nodes n WHERE n.osm_node_id IN (101,102,201,202,301,302,501,502,701,702,901,902,1001,1002,1201,1202,1203,1401,1402,1501,1502,1601) AND n.lsv_component IS NULL)
 THEN RAISE EXCEPTION 'eligible nodes missing components'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_nodes n WHERE n.osm_node_id IN (401,402,601,602,801,802,1301,1302,1602) AND n.lsv_component IS NOT NULL)
 THEN RAISE EXCEPTION 'blocked/restricted-only nodes assigned components'; END IF;
 IF EXISTS (SELECT 1 FROM public.road_edges e JOIN public.road_nodes n ON n.id=e.source_node_id
 WHERE e.osm_way_id BETWEEN 9101 AND 9114 AND e.lsv_component IS DISTINCT FROM n.lsv_component)
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
(root/"results.json").write_text(json.dumps({"cases":16,"edges":len(edges),"nodes":len(nodes),"loader_columns":len(stage_cols),"result":"PASS"},indent=2)+"\n")
print("IMPORTER SAMPLE TEST PASS",flush=True)
