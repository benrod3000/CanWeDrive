const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const RELEASE = process.env.OVERTURE_RELEASE || '2026-09-23.1';
const BBOX = { west: -117.40, south: 32.98, east: -117.08, north: 33.30 };
const source = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=transportation/type=segment/*`;

const db = new duckdb.Database(':memory:');
const conn = db.connect();

function all(sql) {
  return new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));
}

const lengthMiles = `ST_Length_Spheroid(geometry) / 1609.344`;
const hasSpeed = `speed_limits IS NOT NULL AND array_length(speed_limits) > 0`;

async function main() {
  await all(`INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET geometry_always_xy=true;`);

  const where = `subtype = 'road'
    AND bbox.xmin < ${BBOX.east} AND bbox.xmax > ${BBOX.west}
    AND bbox.ymin < ${BBOX.north} AND bbox.ymax > ${BBOX.south}`;

  const totals = await all(`
    SELECT
      COUNT(*) AS segments,
      SUM(${lengthMiles}) AS miles,
      SUM(CASE WHEN ${hasSpeed} THEN ${lengthMiles} ELSE 0 END) AS miles_with_speed,
      COUNT(CASE WHEN ${hasSpeed} THEN 1 END) AS segments_with_speed
    FROM read_parquet('${source}', filename=true, hive_partitioning=1)
    WHERE ${where}
  `);

  const byClass = await all(`
    SELECT
      class,
      COUNT(*) AS segments,
      ROUND(SUM(${lengthMiles}), 2) AS miles,
      ROUND(SUM(CASE WHEN ${hasSpeed} THEN ${lengthMiles} ELSE 0 END), 2) AS miles_with_speed,
      ROUND(100.0 * SUM(CASE WHEN ${hasSpeed} THEN ${lengthMiles} ELSE 0 END) / NULLIF(SUM(${lengthMiles}), 0), 1) AS speed_coverage_pct
    FROM read_parquet('${source}', filename=true, hive_partitioning=1)
    WHERE ${where}
    GROUP BY class
    ORDER BY miles DESC
  `);

  const examples = await all(`
    SELECT
      names.primary AS name,
      class,
      speed_limits[1].max_speed.value AS max_speed,
      speed_limits[1].max_speed.unit AS unit,
      ARRAY_LENGTH(speed_limits) AS speed_rule_count
    FROM read_parquet('${source}', filename=true, hive_partitioning=1)
    WHERE ${where}
      AND ${hasSpeed}
      AND names.primary IS NOT NULL
    LIMIT 25
  `);

  const t = totals[0] || {};
  const report = {
    release: RELEASE,
    bbox: BBOX,
    generatedAt: new Date().toISOString(),
    totals: {
      segments: Number(t.segments || 0),
      miles: Number(t.miles || 0),
      milesWithSpeed: Number(t.miles_with_speed || 0),
      milesWithoutSpeed: Number(t.miles || 0) - Number(t.miles_with_speed || 0),
      speedCoveragePct: Number(t.miles) ? Number(t.miles_with_speed || 0) / Number(t.miles) * 100 : 0,
      segmentsWithSpeed: Number(t.segments_with_speed || 0),
    },
    byClass: byClass.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
    examples: examples.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))),
  };

  const outDir = path.join(process.cwd(), 'public', 'audit');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'overture-speed-coverage.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
