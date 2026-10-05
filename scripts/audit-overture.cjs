const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');
const wkx = require('wkx');

const RELEASE = process.env.OVERTURE_RELEASE || '2026-09-23.1';
const BBOX = { west: -117.40, south: 32.98, east: -117.08, north: 33.30 };
const source = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=transportation/type=segment/*`;
const DRIVABLE_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'living_street', 'service', 'unclassified'
];

const db = new duckdb.Database(':memory:');
const conn = db.connect();

function all(sql) {
  return new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : rows ? resolve(rows) : resolve([])));
}

const haversineMiles = (a, b) => {
  const R = 3958.7613;
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};

const geometryMiles = (wkb) => {
  if (!wkb) return 0;
  const geometry = wkx.Geometry.parse(wkb).toGeoJSON();
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return 0;
  let miles = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    miles += haversineMiles(coordinates[i - 1], coordinates[i]);
  }
  return miles;
};

const speedValues = (value) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule) => {
    const speed = rule?.max_speed;
    const amount = Number(speed?.value);
    if (!Number.isFinite(amount)) return [];
    const unit = String(speed?.unit || '').toLowerCase();
    return [unit === 'km/h' || unit === 'kph' || unit === 'kmh' ? amount * 0.621371192 : amount];
  });
};

async function main() {
  await all(`INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';`);

  const classList = DRIVABLE_CLASSES.map((value) => `'${value}'`).join(', ');
  const where = `subtype = 'road'
    AND class IN (${classList})
    AND bbox.xmin < ${BBOX.east} AND bbox.xmax > ${BBOX.west}
    AND bbox.ymin < ${BBOX.north} AND bbox.ymax > ${BBOX.south}`;

  const rows = await all(`
    SELECT id, names.primary AS name, class, speed_limits, ST_AsWKB(geometry) AS geometry_wkb
    FROM read_parquet('${source}', filename=true, hive_partitioning=1)
    WHERE ${where}
  `);

  let totalMiles = 0;
  let milesWithSpeed = 0;
  let segmentsWithSpeed = 0;
  const byClass = new Map();
  const examples = [];

  for (const row of rows) {
    const miles = geometryMiles(row.geometry_wkb);
    const speeds = speedValues(row.speed_limits);
    const current = byClass.get(row.class) || { class: row.class, segments: 0, miles: 0, miles_with_speed: 0 };
    current.segments += 1;
    current.miles += miles;
    if (speeds.length) {
      current.miles_with_speed += miles;
      milesWithSpeed += miles;
      segmentsWithSpeed += 1;
    }
    totalMiles += miles;
    byClass.set(row.class, current);

    if (speeds.length && examples.length < 25) {
      examples.push({
        name: row.name || 'Unnamed',
        class: row.class,
        speeds: speeds.map((value) => Math.round(value * 10) / 10),
        speedRuleCount: Array.isArray(row.speed_limits) ? row.speed_limits.length : 0,
      });
    }
  }

  const classReport = [...byClass.values()]
    .sort((a, b) => b.miles - a.miles)
    .map((row) => ({
      class: row.class,
      segments: row.segments,
      miles: Number(row.miles.toFixed(2)),
      milesWithSpeed: Number(row.miles_with_speed.toFixed(2)),
      speedCoveragePct: row.miles ? Number((row.miles_with_speed / row.miles * 100).toFixed(1)) : 0,
    }));

  const report = {
    release: RELEASE,
    bbox: BBOX,
    measurement: 'WGS84 geometry decoded from Overture LineStrings; segment length summed with haversine distance',
    drivableClasses: DRIVABLE_CLASSES,
    generatedAt: new Date().toISOString(),
    totals: {
      segments: rows.length,
      miles: Number(totalMiles.toFixed(2)),
      milesWithSpeed: Number(milesWithSpeed.toFixed(2)),
      milesWithoutSpeed: Number((totalMiles - milesWithSpeed).toFixed(2)),
      speedCoveragePct: totalMiles ? Number((milesWithSpeed / totalMiles * 100).toFixed(2)) : 0,
      segmentsWithSpeed,
    },
    byClass: classReport,
    examples,
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
