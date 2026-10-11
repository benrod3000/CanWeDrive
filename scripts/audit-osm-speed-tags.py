#!/usr/bin/env python3
"""Read-only audit of Geofabrik OSM ways intersecting North County bbox."""
import csv
import json
from collections import Counter
from pathlib import Path
import osmium

S, W, N, E = 32.98, -117.40, 33.30, -117.23
OUT = Path("speed-audit-results")
OUT.mkdir(exist_ok=True)
KEYS = ("maxspeed", "maxspeed:forward", "maxspeed:backward")
counts = {key: Counter() for key in KEYS}
ways = 0

class Audit(osmium.SimpleHandler):
    def way(self, way):
        global ways
        if "highway" not in way.tags or not any(k in way.tags for k in KEYS):
            return
        # OSM way nodes inside bbox; also includes any way whose segment crosses
        # the bbox with endpoints outside (handled by segment intersection).
        coords = []
        for n in way.nodes:
            if n.location.valid():
                coords.append((n.location.lon, n.location.lat))
        if not coords:
            return
        def inside(p):
            return W <= p[0] <= E and S <= p[1] <= N
        def intersects(a, b):
            if inside(a) or inside(b):
                return True
            dx, dy = b[0]-a[0], b[1]-a[1]
            p = (-dx, dx, -dy, dy)
            q = (a[0]-W, E-a[0], a[1]-S, N-a[1])
            lo, hi = 0.0, 1.0
            for pi, qi in zip(p, q):
                if pi == 0:
                    if qi < 0: return False
                else:
                    t = qi/pi
                    if pi < 0: lo = max(lo, t)
                    else: hi = min(hi, t)
                    if lo > hi: return False
            return True
        if not any(inside(p) for p in coords) and not any(intersects(a,b) for a,b in zip(coords,coords[1:])):
            return
        ways += 1
        for key in KEYS:
            if key in way.tags:
                counts[key][way.tags[key]] += 1

Audit().apply_file("socal-261008.osm.pbf", locations=True)
with (OUT/"raw-values.csv").open("w",newline="") as f:
    w = csv.writer(f)
    w.writerow(("column","raw_value","count"))
    for key in KEYS:
        for value, count in counts[key].most_common():
            w.writerow((key,value,count))
(OUT/"metadata.json").write_text(json.dumps({"source":"socal-261008.osm.pbf","bbox_swen":[S,W,N,E],"matching_ways":ways,"distinct_counts":{k:len(v) for k,v in counts.items()}},indent=2)+"\n")
print("Matching ways:",ways,"distinct tags:",{k:len(v) for k,v in counts.items()})
