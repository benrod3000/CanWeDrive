#!/usr/bin/env python3
from __future__ import annotations
import argparse, os
from collections import Counter
from datetime import datetime, timezone
import duckdb
import psycopg

RELEASE=os.getenv('OVERTURE_RELEASE','2026-08-19.0')
PARQUET='s3://overturemaps-us-west-2/release/'+RELEASE+'/theme=transportation/type=segment/*'
BBOX=os.getenv('OVERTURE_BBOX','-117.5355,32.9732,-117.2123,33.4022')
MATCH_M=float(os.getenv('OVERTURE_MATCH_METERS','8'))
MATCH_DEG=MATCH_M/111000.0

def mph(v,u):
    if v is None: return None
    u=(u or '').lower()
    if u in ('mph','mi/h'): return float(v)
    if u in ('km/h','kph'): return float(v)/1.609344
    return None

def speed_bucket(speed):
    speed=float(speed)
    if speed <= 15: return '<=15'
    if speed <= 25: return '16-25'
    if speed <= 35: return '26-35'
    if speed <= 45: return '36-45'
    if speed <= 55: return '46-55'
    return '56-65+'

def distance_bucket(distance):
    distance=float(distance)
    if distance <= 3: return '<=3m'
    if distance <= 8: return '3-8m'
    if distance <= 12: return '8-12m'
    return '12-20m'

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
    q="""SELECT id, ST_AsWKB(geometry), speed_limits, names, sources, class
         FROM read_parquet('%s')
         WHERE bbox.xmax >= %s AND bbox.xmin <= %s
           AND bbox.ymax >= %s AND bbox.ymin <= %s
           AND speed_limits IS NOT NULL""" % (PARQUET,w,e,s,n)
    if a.limit: q += ' LIMIT %d' % a.limit
    rows=d.execute(q).fetchall(); d.close()
    candidates=[]
    source_record_stats=Counter()
    source_record_samples=[]
    for oid,wkb,rules,names,sources,road_class in rows:
        name=names.get('primary') if isinstance(names,dict) else None
        source_names=[]
        osm_way_id=None
        if isinstance(sources,list):
            for source_item in sources:
                if not isinstance(source_item,dict): continue
                if source_item.get('dataset'): source_names.append(source_item.get('dataset'))
                record_id=source_item.get('record_id')
                if source_item.get('dataset') == 'OpenStreetMap':
                    if record_id is None:
                        source_record_stats['OSM record_id: null'] += 1
                    elif isinstance(record_id,str):
                        source_record_stats['OSM record_id: string'] += 1
                        prefix=record_id.split('@',1)[0][:1] or '(empty)'
                        source_record_stats['OSM record prefix: '+prefix] += 1
                        if len(source_record_samples) < 12:
                            source_record_samples.append((str(oid), record_id, source_item.get('property')))
                    else:
                        source_record_stats['OSM record_id: '+type(record_id).__name__] += 1
                if osm_way_id is None and source_item.get('dataset')=='OpenStreetMap' and isinstance(record_id,str):
                    record_id=record_id.split('@',1)[0]
                    if record_id.startswith('w') and record_id[1:].isdigit(): osm_way_id=int(record_id[1:])
        source=','.join(dict.fromkeys(source_names)) or 'Overture'
        for rule in rules or []:
            ms=rule.get('max_speed') if isinstance(rule,dict) else None
            when=(rule.get('when') or {}) if isinstance(rule,dict) else {}
            if not isinstance(ms,dict) or rule.get('between') is not None: continue
            if any(when.get(k) is not None for k in ('during','mode','using','vehicle','heading')): continue
            speed=mph(ms.get('value'),ms.get('unit'))
            if speed is not None: candidates.append((str(oid),wkb,speed,name,source,osm_way_id,road_class))
    print('Overture release:',RELEASE)
    print('Explicit unconditional speed candidates:',len(candidates))
    if not candidates: return
    url=os.getenv('SUPABASE_DB_URL')
    if not url: raise SystemExit('SUPABASE_DB_URL is required')
    with psycopg.connect(url) as c:
        with c.cursor() as cur:
            cur.execute("""CREATE TEMP TABLE overture_speed_candidates(
              overture_id text, geom extensions.geometry(LineString,4326),
              maxspeed_mph numeric, name text, source_dataset text, osm_way_id bigint, overture_class text) ON COMMIT DROP""")
            cur.executemany(
                """INSERT INTO overture_speed_candidates
                  VALUES(%s,extensions.ST_SetSRID(extensions.ST_GeomFromWKB(%s),4326),%s,%s,%s,%s,%s)""",
                candidates
            )
            cur.execute("""CREATE INDEX overture_speed_candidates_geom_gix
              ON overture_speed_candidates USING GIST (geom)""")
            cur.execute("""ANALYZE overture_speed_candidates""")
            cur.execute("""SELECT count(*) FROM public.road_edges
              WHERE maxspeed_mph IS NULL AND lsv_status='unknown'""")
            before=cur.fetchone()[0]
            candidates_with_osm_id=sum(1 for x in candidates if x[5] is not None)
            candidate_osm_ids=[x[5] for x in candidates if x[5] is not None]
            print('Candidates with OSM way ID:',candidates_with_osm_id)
            print('Candidates without OSM way ID:',len(candidates)-candidates_with_osm_id)
            cur.execute("""CREATE TEMP TABLE overture_candidate_osm_ids(osm_way_id bigint) ON COMMIT DROP""")
            if candidate_osm_ids:
                cur.executemany("INSERT INTO overture_candidate_osm_ids VALUES(%s)", [(x,) for x in candidate_osm_ids])
                if candidate_osm_ids:
                    cur.execute("""SELECT
                  count(DISTINCT c.osm_way_id),
                  count(DISTINCT e.osm_way_id) FILTER (WHERE e.lsv_status='unknown' AND e.maxspeed_mph IS NULL),
                  count(DISTINCT e.osm_way_id) FILTER (WHERE e.lsv_status='verified_eligible'),
                  count(DISTINCT e.osm_way_id) FILTER (WHERE e.lsv_status='verified_blocked'),
                  count(DISTINCT e.osm_way_id) FILTER (WHERE e.lsv_status='restricted')
                  FROM overture_candidate_osm_ids c
                  JOIN public.road_edges e ON e.osm_way_id=c.osm_way_id""")
                exact_id_intersection,exact_unknown,exact_eligible,exact_blocked,exact_restricted=cur.fetchone()
            else:
                exact_id_intersection=exact_unknown=exact_eligible=exact_blocked=exact_restricted=0
            print('Unique candidate OSM way IDs:',len(set(candidate_osm_ids)))
            print('Candidate OSM way IDs found in road_edges:',exact_id_intersection)
            print('Candidate OSM way IDs with unknown edges:',exact_unknown)
            print('Candidate OSM way IDs with verified eligible edges:',exact_eligible)
            print('Candidate OSM way IDs with verified blocked edges:',exact_blocked)
            print('Candidate OSM way IDs with restricted edges:',exact_restricted)
            match_sql="""FROM public.road_edges e JOIN overture_speed_candidates c
              ON (
                e.osm_way_id = c.osm_way_id
                OR (
                  e.geom && extensions.ST_Expand(c.geom,%s)
                  AND extensions.ST_DWithin(e.geom::extensions.geography,c.geom::extensions.geography,%s)
                  AND (
                    (extensions.ST_DWithin(e.geom::extensions.geography,c.geom::geography,3) AND (
                      lower(coalesce(c.overture_class,'unknown')) = lower(coalesce(e.highway_type,'unknown'))
                      OR lower(coalesce(c.overture_class,'unknown')) = 'unknown'
                      OR lower(coalesce(e.highway_type,'unknown')) = 'unknown'
                      OR (lower(coalesce(c.overture_class,''))='primary' AND lower(coalesce(e.highway_type,''))='primary_link')
                      OR (lower(coalesce(c.overture_class,''))='secondary' AND lower(coalesce(e.highway_type,''))='secondary_link')
                      OR (lower(coalesce(c.overture_class,''))='tertiary' AND lower(coalesce(e.highway_type,''))='tertiary_link')
                    ))
                    OR (c.name IS NOT NULL AND e.name IS NOT NULL
                      AND lower(trim(e.name))=lower(trim(c.name))
                      AND (
                        lower(coalesce(c.overture_class,'unknown')) = lower(coalesce(e.highway_type,'unknown'))
                        OR (lower(coalesce(c.overture_class,''))='primary' AND lower(coalesce(e.highway_type,''))='primary_link')
                        OR (lower(coalesce(c.overture_class,''))='secondary' AND lower(coalesce(e.highway_type,''))='secondary_link')
                        OR (lower(coalesce(c.overture_class,''))='tertiary' AND lower(coalesce(e.highway_type,''))='tertiary_link')
                      )
                    )
                  )
                )
              )
              WHERE e.maxspeed_mph IS NULL AND e.lsv_status='unknown'"""
            cur.execute("""SELECT DISTINCT ON(e.id) e.id,c.maxspeed_mph,c.source_dataset,
              e.highway_type,e.name,c.name,c.overture_class,
              CASE WHEN e.name IS NOT NULL AND c.name IS NOT NULL
                AND lower(trim(e.name))=lower(trim(c.name)) THEN true ELSE false END AS same_name,
              (e.osm_way_id = c.osm_way_id) AS exact_osm_way,
              extensions.ST_Distance(e.geom::extensions.geography,c.geom::extensions.geography) d
              """ + match_sql + """
              ORDER BY e.id,
                CASE WHEN e.osm_way_id = c.osm_way_id THEN 0 ELSE 1 END,
                CASE WHEN e.name IS NOT NULL AND c.name IS NOT NULL
                  AND lower(trim(e.name))=lower(trim(c.name)) THEN 0 ELSE 1 END, d""",(MATCH_DEG,MATCH_M))
            matches=cur.fetchall()
            print('Unknown edges before:',before)
            print('Unknown edges matched:',len(matches))
            if matches:
                speeds=[float(x[1]) for x in matches]
                print('Matched speed range: %.1f to %.1f mph' % (min(speeds),max(speeds)))
                print('Speed buckets:')
                for bucket in ('<=15','16-25','26-35','36-45','46-55','56-65+'):
                    print('  %-7s %d' % (bucket,sum(speed_bucket(x)==bucket for x in speeds)))
                exact_osm_way=sum(1 for x in matches if x[7])
                same_name=sum(1 for x in matches if x[6])
                print('Match quality:')
                print('  Exact OSM way ID:',exact_osm_way)
                print('  Geometry/name fallback:',len(matches)-exact_osm_way)
                print('  Same street name:',same_name)
                print('  Geometry/other:',len(matches)-same_name)
                print('Distance buckets:')
                for bucket in ('<=3m','3-8m','8-12m','12-20m'):
                    print('  %-7s %d' % (bucket,sum(distance_bucket(x[9])==bucket for x in matches)))
                print('Distance buckets by match quality:')
                for label,rows in (('Same name',[x for x in matches if x[6]]),('Geometry/other',[x for x in matches if not x[6]])):
                    print('  '+label+':')
                    for bucket in ('<=3m','3-8m','8-12m','12-20m'):
                        print('    %-7s %d' % (bucket,sum(distance_bucket(x[9])==bucket for x in rows)))
                geometry_only=sorted((x for x in matches if not x[7]), key=lambda x:x[8], reverse=True)
                print('Worst geometry/other matches (farthest first):')
                for x in geometry_only[:20]:
                    print('  %.1fm | %s | %s | %s | %.1f mph' % (float(x[9]), x[4] or '(unnamed)', x[5] or '(unnamed)', x[3] or 'unknown', float(x[1])))
                print('Road types:')
                for road_type,count in sorted(Counter((x[3] or 'unknown') for x in matches).items(), key=lambda item:(-item[1],item[0])):
                    print('  %-18s %d' % (road_type,count))
                print('Overture sources:')
                for source,count in sorted(Counter((x[2] or 'Overture') for x in matches).items(), key=lambda item:(-item[1],item[0])):
                    print('  %-30s %d' % (source,count))
            print('OSM source record diagnostics:')
            for label,count in sorted(source_record_stats.items()):
                print('  %-32s %d' % (label,count))
            if source_record_samples:
                print('Sample OSM source records:')
                for oid,record_id,prop in source_record_samples:
                    print('  %s | %s | property=%s' % (oid,record_id,prop or '(none)'))
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
                  CASE WHEN e2.osm_way_id = c2.osm_way_id THEN 0 ELSE 1 END,
                  CASE WHEN e2.name IS NOT NULL AND c2.name IS NOT NULL
                    AND lower(trim(e2.name))=lower(trim(c2.name)) THEN 0 ELSE 1 END,
                  extensions.ST_Distance(e2.geom::extensions.geography,c2.geom::extensions.geography)) m
              WHERE e.id=m.id""",(now,now,MATCH_DEG,MATCH_M))
            print('Updated road edges:',cur.rowcount)
        c.commit()

if __name__=='__main__': main()
