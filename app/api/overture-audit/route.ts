import { NextResponse } from "next/server";
import duckdb from "duckdb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RELEASE = process.env.OVERTURE_RELEASE ?? "2026-09-23.1";

function all(conn: any, sql: string) {
  return new Promise<any[]>((resolve, reject) => {
    conn.all(sql, (error: Error | null, rows: any[]) => error ? reject(error) : resolve(rows));
  });
}

export async function GET() {
  const bbox = {
    west: -117.285,
    south: 33.045,
    east: -117.235,
    north: 33.070,
  };

  const source = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=transportation/type=segment/*`;
  const where = `subtype = 'road'
    AND bbox.xmin < ${bbox.east} AND bbox.xmax > ${bbox.west}
    AND bbox.ymin < ${bbox.north} AND bbox.ymax > ${bbox.south}`;

  const db = new duckdb.Database(":memory:");
  const conn = db.connect();

  try {
    await all(conn, "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");

    const rows = await all(conn, `
      SELECT
        id,
        names.primary AS name,
        class,
        subclass,
        speed_limits,
        ST_AsWKB(geometry) AS geometry_wkb
      FROM read_parquet('${source}')
      WHERE ${where}
    `);

    let totalMiles = 0;
    let milesWithSpeed = 0;
    const classes = new Map<string, { miles: number; withSpeed: number; segments: number }>();
    const speedExamples: Array<{ name: string; class: string; speeds: number[] }> = [];

    const haversine = (a: [number, number], b: [number, number]) => {
      const r = 3958.7613;
      const p1 = a[1] * Math.PI / 180;
      const p2 = b[1] * Math.PI / 180;
      const dp = (b[1] - a[1]) * Math.PI / 180;
      const dl = (b[0] - a[0]) * Math.PI / 180;
      const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      return r * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    };

    const speedsFromValue = (value: any): number[] => {
      const raw = Array.isArray(value) ? value : [];
      const out: number[] = [];
      for (const rule of raw) {
        const speed = rule?.max_speed;
        const amount = Number(speed?.value);
        if (!Number.isFinite(amount)) continue;
        const unit = String(speed?.unit ?? "").toLowerCase();
        out.push(unit === "km/h" || unit === "kph" || unit === "kmh" ? amount * 0.621371192 : amount);
      }
      return out;
    };

    for (const row of rows) {
      const geometry = row.geometry_wkb ? (await import("wkx")).Geometry.parse(row.geometry_wkb).toGeoJSON() : null;
      const coordinates = geometry?.coordinates ?? [];
      let miles = 0;
      for (let i = 1; i < coordinates.length; i += 1) miles += haversine(coordinates[i - 1], coordinates[i]);
      const speeds = speedsFromValue(row.speed_limits);
      totalMiles += miles;
      if (speeds.length) milesWithSpeed += miles;

      const key = String(row.class ?? "unknown");
      const current = classes.get(key) ?? { miles: 0, withSpeed: 0, segments: 0 };
      current.miles += miles;
      current.withSpeed += speeds.length ? miles : 0;
      current.segments += 1;
      classes.set(key, current);

      if (speeds.length && speedExamples.length < 40) {
        speedExamples.push({ name: row.name ?? "Unnamed", class: key, speeds: speeds.map((v) => Math.round(v * 10) / 10) });
      }
    }

    return NextResponse.json({
      release: RELEASE,
      bbox,
      segments: rows.length,
      totalRoadMiles: Number(totalMiles.toFixed(3)),
      milesWithExplicitSpeed: Number(milesWithSpeed.toFixed(3)),
      milesWithoutExplicitSpeed: Number((totalMiles - milesWithSpeed).toFixed(3)),
      explicitSpeedCoveragePct: totalMiles ? Number((milesWithSpeed / totalMiles * 100).toFixed(2)) : 0,
      byClass: Object.fromEntries([...classes.entries()].map(([key, value]) => [
        key,
        {
          segments: value.segments,
          miles: Number(value.miles.toFixed(3)),
          milesWithExplicitSpeed: Number(value.withSpeed.toFixed(3)),
          speedCoveragePct: value.miles ? Number((value.withSpeed / value.miles * 100).toFixed(1)) : 0,
        },
      ])),
      speedExamples,
    });
  } catch (error) {
    console.error("Overture audit failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Overture audit failed." }, { status: 500 });
  } finally {
    conn.close();
  }
}
