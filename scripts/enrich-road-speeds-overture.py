#!/usr/bin/env python3
from __future__ import annotations
import argparse, os
from datetime import datetime, timezone
import duckdb
import psycopg

RELEASE=os.getenv('OVERTURE_RELEASE','2026-08-19.0')
PARQUET='s3://overturemaps-us-west-2/release/'+RELEASE+'/theme=transportation/type=segment/*'
BBOX=os.getenv('OVERTURE_BBOX','-117.5355,32.9732,-117.2123,33.4022')
MATCH_M=float(os.getenv('OVERTURE_MATCH_METERS','20'))
MATCH_DEG=MATCH_M/111000.0

def mph(v,u):
    if v is None: return None
    u=(u or '').lower()
    if u in ('mph','mi/h'): return float(v)
    if u in ('km/h','kph'): return float(v)/1.609344
    return None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--bbox',default=BBOX)
    ap.add_argument('--limit',type=int,default=0)
    ap.add_argument('--apply',action='store_true')
    a=ap.parse_args()
    w,s,e,n=map(float,a.bbox.split(','))
    d=duckdb.connect()
    d.execute('INSTALL spatial')
    d.execute('LOAD spatial')
    d.execute("SET s3_region='us-west-2'")
    q="""SELECT id, ST_AsWKB(geometry), speed_limits, names, sources
         FROM read_parquet('%s')
         WHERE bbox.xmax >= %s AND bbox.xmin <= %s
           AND bbox.ymax >= %s AND bbox.ymin <= %s
           AND speed_limits IS NOT NULL""" % (PARQUET,w,e,s,n)
    if a.limit: q += ' LIMIT %d' % a.limit
    rows=d.execute(q).fetchall(); d.close()
    candidates=[]
    for oid,wkb,rules,names,sources in rows:
        name=names.get('primary') if isinstance(names,dict) else None
        source_names=[]
        if isinstance(sources,list):
            source_names=[x.get('dataset') for x in sources if isinstance(x,dict) and x.get('dataset')]
        source=','.join(dict.fromkeys(source_names)) or 'Overture'
        for rule in rules or []:
            ms=rule.get('max_speed') if isinstance(rule,dict) else None
            when=(rule.get('when') or {}) if isinstance(rule,dict) else {}
            if not isinstance(ms,dict) or rule.get('between') is not None: continue
            if any(when.get(k) is not None for k in ('during','mode','using','vehicle','heading')): continue
            speed=mph(ms.get('value'),ms.get('unit'))
            if speed is not None: candidates.append((str(oid),wkb,speed,name,source))
    print('Overture release:',RELEASE)
    print('Explicit unconditional speed candidates:',len(candidates))
    if not candidates: return
    url=os.getenv('SUPABASE_DB_URL')
    if not url: raise SystemExit('SUPABASE_DB_URL is required')
    with psycopg.connect(url) as c:
        with c.cursor() as cur:
            cur.execute("""CREATE TEMP TABLE overture_speed_candidates(
              overture_id text, geom extensions.geometry(LineString,4326),
              maxspeed_mph numeric, name text, source_dataset text) ON COMMIT DROP""")
            cur.executemany(
                """INSERT INTO overture_speed_candidates
                  VALUES(%s,extensions.ST_SetSRID(extensions.ST_GeomFromWKB(%s),4326),%s,%s,%s)""",
                candidates
            )
            # The candidate table is small enough to index. The bbox predicate below
            # also lets the existing road_edges geometry GiST index prune the 244k
            # unknown edges before exact distance/name matching.
            cur.execute("""CREATE INDEX overture_speed_candidates_geom_gix
              ON overture_speed_candidates USING GIST (geom)""")
            cur.execute("""ANALYZE overture_speed_candidates""")
            cur.execute("""SELECT count(*) FROM public.road_edges
              WHERE maxspeed_mph IS NULL AND lsv_status='unknown'""")
            before=cur.fetchone()[0]
            match_sql="""FROM public.road_edges e JOIN overture_speed_candidates c
              ON e.geom && extensions.ST_Expand(c.geom,%s)
              AND extensions.ST_DWithin(e.geom::extensions.geography,c.geom::extensions.geography,%s)
              WHERE e.maxspeed_mph IS NULL AND e.lsv_status='unknown'
              AND (c.name IS NULL OR e.name IS NULL OR lower(trim(e.name))=lower(trim(c.name))
                   OR extensions.ST_DWithin(e.geom::extensions.geography,c.geom::geography,8))"""
            cur.execute("""SELECT DISTINCT ON(e.id) e.id,c.maxspeed_mph,c.source_dataset,
              extensions.ST_Distance(e.geom::extensions.geography,c.geom::extensions.geography) d
              """ + match_sql + """
              ORDER BY e.id,
                CASE WHEN e.name IS NOT NULL AND c.name IS NOT NULL
                  AND lower(trim(e.name))=lower(trim(c.name)) THEN 0 ELSE 1 END, d""",(MATCH_DEG,MATCH_M))
            matches=cur.fetchall()
            print('Unknown edges before:',before)
            print('Unknown edges matched:',len(matches))
            if matches: print('Matched speed range: %.1f to %.1f mph' % (min(float(x[1]) for x in matches),max(float(x[1]) for x in matches)))
            if not a.apply:
                print('DRY RUN ONLY. No road_edges were modified.')
                return
            now=datetime.now(timezone.utc)
            cur.execute("""UPDATE public.road_edges e SET
              maxspeed_mph=m.maxspeed_mph,
              speed_source=CASE WHEN m.source_dataset IS NULL OR m.source_dataset='' THEN 'Overture' ELSE 'Overture ('||m.source_dataset||')' END,
              speed_verified_at=%s,
              lsv_status=CASE WHEN m.maxspeed_mph<=35 THEN 'verified_eligible' ELSE 'verified_blocked' END,
              lsv_reason=CASE WHEN m.maxspeed_mph<=35 THEN 'Overture speed limit <= 35 mph' ELSE 'Overture speed limit > 35 mph' END,
              updated_at=%s
              FROM (SELECT DISTINCT ON(e2.id) e2.id,c2.maxspeed_mph,c2.source_dataset
                """ + match_sql.replace('e.', 'e2.').replace('c.', 'c2.') + """
                ORDER BY e2.id,
                  CASE WHEN e2.name IS NOT NULL AND c2.name IS NOT NULL
                    AND lower(trim(e2.name))=lower(trim(c2.name)) THEN 0 ELSE 1 END,
                  extensions.ST_Distance(e2.geom::extensions.geography,c2.geom::extensions.geography)) m
              WHERE e.id=m.id""",(now,now,MATCH_DEG,MATCH_M))
            print('Updated road edges:',cur.rowcount)
        c.commit()

if __name__=='__main__': main()
