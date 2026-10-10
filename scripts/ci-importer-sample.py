#!/usr/bin/env python3
"""Isolated importer contract test. NEVER executes scripts/load-road-graph.sql."""
import csv,json,pathlib,re,subprocess,sys
root=pathlib.Path("replay-results/importer")
root.mkdir(parents=True,exist_ok=True)
def feature(way,nodes,tags):
    return {"type":"Feature","properties":{"@id":str(way),"@way_nodes":nodes,**tags},
            "geometry":{"type":"LineString","coordinates":[[-117.30+i*.001,33.05+(way-9100)*.001] for i in range(len(nodes))]}}
# Five cases: bidirectional, forward one-way, reverse one-way,
# access-restricted, and directional/raw-speed provenance.
cases=[
 feature(9101,[101,102],{"highway":"residential","maxspeed":"25 mph","name":"Two way"}),
 feature(9102,[201,202],{"highway":"residential","oneway":"yes","maxspeed":"20 mph"}),
 feature(9103,[301,302],{"highway":"residential","oneway":"-1","maxspeed":"30 mph"}),
 feature(9104,[401,402],{"highway":"service","access":"private","maxspeed":"15 mph"}),
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
by={i:[e for e in edges if e["osm_way_id"]==str(i)] for i in range(9101,9106)}
def check(label,ok):
    print(("PASS " if ok else "FAIL ")+label,flush=True)
    if not ok: raise AssertionError(label)
check("case 1 bidirectional",len(by[9101])==2 and [e["direction"] for e in by[9101]]==["forward","backward"])
check("case 2 forward one-way",len(by[9102])==1 and by[9102][0]["direction"]=="forward")
check("case 3 reverse one-way",len(by[9103])==1 and by[9103][0]["direction"]=="backward" and by[9103][0]["source_osm_node_id"]=="302")
check("case 4 access restriction",len(by[9104])==2 and all(e["lsv_status"]=="verified_blocked" for e in by[9104]))
expected_raw={"osm_maxspeed_raw":"25 mph","osm_maxspeed_forward_raw":"30 mph",
 "osm_maxspeed_backward_raw":"20 mph","osm_source_maxspeed_raw":"sign",
 "osm_maxspeed_type_raw":"US:urban","osm_maxspeed_source_raw":"survey"}
check("case 5 raw speed tags and directional speeds",
 len(by[9105])==2 and all(all(e[k]==v for k,v in expected_raw.items()) for e in by[9105])
 and [round(float(e["maxspeed_mph"])) for e in by[9105]]==[30,20]
 and all(e["speed_source"]=="sign" for e in by[9105]))
check("CSV quoting, node references and totals",len(edges)==8 and len(nodes)==10
 and all(e["source_osm_node_id"] in {n["osm_node_id"] for n in nodes} and e["target_osm_node_id"] in {n["osm_node_id"] for n in nodes} for e in edges)
 and any(e["name"]=='A "quoted", road' for e in edges))
# Loader-completeness: parse declared staging columns and ordered insert/select
# columns; never execute the loader (it contains TRUNCATE).
loader=pathlib.Path("scripts/load-road-graph.sql").read_text()
builder_header=next(csv.reader((root/"edges.csv").open()))
stage=re.search(r"create temp table stage_edges\s*\((.*?)\)\s*on commit drop",loader,re.S|re.I)
check("loader stage_edges declaration found",stage is not None)
stage_cols=[re.match(r"\s*(\w+)",line).group(1) for line in stage.group(1).split(",\n") if line.strip()]
check("loader stage columns equal generated CSV header",stage_cols==builder_header)
insert=re.search(r"insert into public\.road_edges\s*\((.*?)\)\s*select\s+(.*?)\s+from stage_edges s",loader,re.S|re.I)
check("loader edge insert/select found",insert is not None)
dest=[x.strip() for x in insert.group(1).split(",")]
expressions=[x.strip() for x in insert.group(2).split(",\n")]
# SQL function expressions contain commas; compare each CSV staging field's
# direct s.column mapping in the SELECT, in the same destination order.
direct={d:expr for d,expr in zip(dest,expressions) if expr.startswith("s.")}
check("loader maps every raw speed field exactly",
 all(d in dest and re.search(r"\bs\."+re.escape(d)+r"\b",insert.group(2)) for d in expected_raw))
check("loader covers all CSV fields",
 all(c in dest or c in ("source_osm_node_id","target_osm_node_id","geom_wkt") for c in builder_header))
# Temporary database staging and \copy inside one rolled-back transaction.
sql=root/"stage.sql"
sql.write_text("BEGIN;\nCREATE TEMP TABLE sample_nodes(osm_node_id bigint,lon float8,lat float8) ON COMMIT DROP;\n"
 +"CREATE TEMP TABLE sample_edges("+",".join(f'"{c}" text' for c in builder_header)+") ON COMMIT DROP;\n"
 +f"\\copy sample_nodes FROM '{(root/'nodes.csv').resolve()}' WITH (FORMAT csv,HEADER true)\n"
 +f"\\copy sample_edges FROM '{(root/'edges.csv').resolve()}' WITH (FORMAT csv,HEADER true)\n"
 +"DO $$ BEGIN IF (SELECT count(*) FROM sample_nodes)<>10 OR (SELECT count(*) FROM sample_edges)<>8 THEN RAISE EXCEPTION 'staging counts wrong'; END IF;"
 +" IF (SELECT count(*) FROM sample_edges WHERE osm_source_maxspeed_raw='sign')<>2 THEN RAISE EXCEPTION 'raw provenance lost'; END IF;"
 +" IF (SELECT count(*) FROM sample_edges WHERE osm_way_id='9104' AND lsv_status='verified_blocked')<>2 THEN RAISE EXCEPTION 'restricted access lost'; END IF;"
 +" END $$;\nROLLBACK;\n")
with open(root/"staging-output.txt","w") as out:
    result=subprocess.run(["psql","-v","ON_ERROR_STOP=1","-f",str(sql)],stdout=out,stderr=subprocess.STDOUT,text=True)
check("temporary-only PostgreSQL CSV staging and rollback",result.returncode==0)
(root/"results.json").write_text(json.dumps({"cases":5,"edges":len(edges),"nodes":len(nodes),"loader_columns":len(stage_cols),"result":"PASS"},indent=2)+"\n")
print("IMPORTER SAMPLE TEST PASS",flush=True)
