#!/usr/bin/env python3
"""Audit Overture transportation speed-limit coverage for North County San Diego.

This is intentionally an audit only. It does not change the production road graph.
The report measures road mileage, not just segment counts.
"""

import csv
import json
import math
import os
from collections import Counter, defaultdict

import duckdb
from shapely import wkb

RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-09-23.1")
S3 = f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=transportation/type=segment/*"
BBOX = (-117.40, 32.98, -117.23, 33.30)


def haversine_miles(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    r = 3958.7613
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(h), math.sqrt(max(0.0, 1.0 - h)))


def geometry_miles(value):
    if value is None:
        return 0.0
    try:
        geometry = wkb.loads(bytes(value))
        coords = list(geometry.coords)
        return sum(haversine_miles(coords[i - 1], coords[i]) for i in range(1, len(coords)))
    except Exception:
        return 0.0


def normalize_speed_limits(value):
    """Normalize DuckDB's native list<struct> result, with JSON fallback."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return []
    if isinstance(value, dict):
        value = [value]

    speeds = []
    for item in value or []:
        if not isinstance(item, dict):
            try:
                item = dict(item)
            except Exception:
                continue
        max_speed = item.get("max_speed")
        if max_speed is None:
            continue
        if not isinstance(max_speed, dict):
            try:
                max_speed = dict(max_speed)
            except Exception:
                continue
        v = max_speed.get("value")
        unit = str(max_speed.get("unit", "")).lower()
        if isinstance(v, (int, float)):
            if unit in {"km/h", "kph", "kmh"}:
                v = float(v) * 0.621371192
            speeds.append(float(v))
    return speeds


def main():
    os.makedirs("data/overture-audit", exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET s3_region='us-west-2';")

    xmin, ymin, xmax, ymax = BBOX
    query = f"""
        SELECT
          id,
          class,
          subclass,
          speed_limits,
          ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{S3}')
        WHERE bbox.xmin <= {xmax}
          AND bbox.xmax >= {xmin}
          AND bbox.ymin <= {ymax}
          AND bbox.ymax >= {ymin}
          AND subtype = 'road'
    """

    rows = con.execute(query).fetchall()
    columns = [d[0] for d in con.description]

    totals = Counter()
    by_class = defaultdict(Counter)
    samples = []
    for raw in rows:
        row = dict(zip(columns, raw))
        speeds = normalize_speed_limits(row.get("speed_limits"))
        length = geometry_miles(row.get("geometry_wkb"))
        state = "explicit_speed" if speeds else "no_explicit_speed"
        totals["segments"] += 1
        totals[state + "_segments"] += 1
        totals[state + "miles"] += length
        road_class = row.get("class") or "unknown"
        by_class[road_class]["segments"] += 1
        by_class[road_class][state + "_segments"] += 1
        by_class[road_class][state + "miles"] += length
        if len(samples) < 25 and speeds:
            samples.append({"id": row.get("id"), "class": road_class, "speeds_mph": speeds})

    total_miles = totals["explicit_speed_miles"] + totals["no_explicit_speed_miles"]
    report = {
        "release": RELEASE,
        "bbox": BBOX,
        "segments": totals["segments"],
        "total_road_miles": round(total_miles, 3),
        "explicit_speed_segments": totals["explicit_speed_segments"],
        "no_explicit_speed_segments": totals["no_explicit_speed_segments"],
        "explicit_speed_miles": round(totals["explicit_speed_miles"], 3),
        "no_explicit_speed_miles": round(totals["no_explicit_speed_miles"], 3),
        "explicit_speed_coverage_percent_by_miles": round(100 * totals["explicit_speed_miles"] / total_miles, 2) if total_miles else 0,
        "class_breakdown": {
            key: {k: round(v, 3) if k.endswith("miles") else v for k, v in value.items()}
            for key, value in sorted(by_class.items())
        },
        "speed_samples": samples,
    }

    with open("data/overture-audit/report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)

    with open("data/overture-audit/class-breakdown.csv", "w", newline="", encoding="utf-8") as f:
        fields = ["class", "segments", "explicit_speed_segments", "no_explicit_speed_segments", "explicit_speed_miles", "no_explicit_speed_miles"]
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for key, value in sorted(by_class.items()):
            writer.writerow({"class": key, **{k: round(v, 3) if k.endswith("miles") else v for k, v in value.items()}})

    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
