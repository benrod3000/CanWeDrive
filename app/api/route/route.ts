import { NextRequest, NextResponse } from "next/server";

import { getPlace } from "@/lib/locations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LSV_MAX_SPEED_MPH = 35;
const MATCH_DISTANCE_METERS = 35;

type Coordinate = [number, number];

type OverpassWay = {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

type RouteSegment = {
  coordinates: [Coordinate, Coordinate];
  status: "eligible" | "blocked" | "unknown";
  speedMph: number | null;
  source: "OpenStreetMap" | null;
};

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distancePointToSegmentMeters(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
) {
  const lat = toRadians((point[1] + start[1] + end[1]) / 3);
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = 111_320 * Math.cos(lat);

  const px = point[0] * metersPerDegreeLon;
  const py = point[1] * metersPerDegreeLat;
  const ax = start[0] * metersPerDegreeLon;
  const ay = start[1] * metersPerDegreeLat;
  const bx = end[0] * metersPerDegreeLon;
  const by = end[1] * metersPerDegreeLat;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSquared = abx * abx + aby * aby;

  if (lengthSquared === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  const projection = Math.max(
    0,
    Math.min(1, (apx * abx + apy * aby) / lengthSquared),
  );
  const closestX = ax + abx * projection;
  const closestY = ay + aby * projection;

  return Math.hypot(px - closestX, py - closestY);
}

function parseSpeedMph(value?: string) {
  if (!value) return null;

  const normalized = value.toLowerCase();
  if (normalized.includes("signals") || normalized.includes("none")) {
    return null;
  }

  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  if (!matches?.length) return null;

  const numbers = matches.map(Number);
  const maxValue = Math.max(...numbers);

  if (normalized.includes("km/h") || normalized.includes("kph")) {
    return maxValue / 1.609344;
  }

  return maxValue;
}

function waySpeedMph(tags: Record<string, string> = {}) {
  const values = [
    tags.maxspeed,
    tags["maxspeed:forward"],
    tags["maxspeed:backward"],
  ]
    .map(parseSpeedMph)
    .filter((value): value is number => value !== null);

  if (!values.length) return null;

  return Math.max(...values);
}

async function fetchStoredSpeedWays(
  routeGeometry: { type: "LineString"; coordinates: Coordinate[] },
): Promise<OverpassWay[]> {
  const supabaseUrl =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) return [];

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/road_segments_near_route`,
    {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        route_geojson: routeGeometry,
        max_distance_meters: MATCH_DISTANCE_METERS,
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );

  if (!response.ok) return [];

  type StoredRoadRow = {
    id: number;
    osm_id: number | null;
    maxspeed_mph: number | null;
    speed_source: string | null;
    geom_geojson: {
      type?: string;
      coordinates?: Array<[number, number]>;
    } | null;
  };

  const rows = (await response.json()) as StoredRoadRow[];

  return rows
    .filter(
      (row) =>
        row.geom_geojson?.type === "LineString" &&
        Array.isArray(row.geom_geojson.coordinates) &&
        row.geom_geojson.coordinates.length > 1,
    )
    .map((row) => ({
      type: "way",
      id: row.osm_id ?? row.id,
      tags: row.maxspeed_mph === null
        ? ({} as Record<string, string>)
        : { maxspeed: String(row.maxspeed_mph) },
      geometry: row.geom_geojson!.coordinates!.map(([lon, lat]) => ({
        lon,
        lat,
      })),
    }));
}

function buildGrid(ways: OverpassWay[]) {
  const cellSize = 0.0007;
  const grid = new Map<string, number[]>();

  ways.forEach((way, index) => {
    const geometry = way.geometry ?? [];
    if (geometry.length < 2) return;

    const lats = geometry.map((point) => point.lat);
    const lons = geometry.map((point) => point.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const minX = Math.floor(minLon / cellSize);
    const maxX = Math.floor(maxLon / cellSize);
    const minY = Math.floor(minLat / cellSize);
    const maxY = Math.floor(maxLat / cellSize);

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = `${x}:${y}`;
        const bucket = grid.get(key) ?? [];
        bucket.push(index);
        grid.set(key, bucket);
      }
    }
  });

  return { grid, cellSize };
}

function nearestSpeedForPoint(
  point: Coordinate,
  ways: OverpassWay[],
  grid: Map<string, number[]>,
  cellSize: number,
) {
  const x = Math.floor(point[0] / cellSize);
  const y = Math.floor(point[1] / cellSize);
  const candidateIndexes = new Set<number>();

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const index of grid.get(`${x + dx}:${y + dy}`) ?? []) {
        candidateIndexes.add(index);
      }
    }
  }

  let closestDistance = Number.POSITIVE_INFINITY;
  let closestSpeed: number | null = null;

  for (const index of candidateIndexes) {
    const way = ways[index];
    const speed = waySpeedMph(way.tags);
    if (speed === null) continue;

    const geometry = way.geometry ?? [];
    for (let i = 1; i < geometry.length; i += 1) {
      const start: Coordinate = [geometry[i - 1].lon, geometry[i - 1].lat];
      const end: Coordinate = [geometry[i].lon, geometry[i].lat];
      const distance = distancePointToSegmentMeters(point, start, end);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestSpeed = speed;
      }
    }
  }

  if (closestDistance > MATCH_DISTANCE_METERS) {
    return null;
  }

  return closestSpeed;
}

async function fetchSpeedWays(
  coordinates: Coordinate[],
): Promise<OverpassWay[]> {
  const lons = coordinates.map(([lon]) => lon);
  const lats = coordinates.map(([, lat]) => lat);
  const south = Math.min(...lats) - 0.001;
  const north = Math.max(...lats) + 0.001;
  const west = Math.min(...lons) - 0.001;
  const east = Math.max(...lons) + 0.001;

  const query = [
    "[out:json][timeout:25];",
    `way["highway"]["maxspeed"](${south},${west},${north},${east});`,
    `way["highway"]["maxspeed:forward"](${south},${west},${north},${east});`,
    `way["highway"]["maxspeed:backward"](${south},${west},${north},${east});`,
    "out tags geom;",
  ].join("");

  const response = await fetch(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
    {
      headers: {
        "User-Agent": "CanWeDrive/0.1 (open-source LSV route research tool)",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Overpass returned ${response.status}`);
  }

  const payload = (await response.json()) as { elements?: OverpassWay[] };
  const uniqueWays = new Map<number, OverpassWay>();

  for (const element of payload.elements ?? []) {
    if (element.type === "way" && element.geometry?.length) {
      uniqueWays.set(element.id, element);
    }
  }

  return [...uniqueWays.values()];
}

export async function GET(request: NextRequest) {
  const fromId = request.nextUrl.searchParams.get("from") ?? "";
  const toId = request.nextUrl.searchParams.get("to") ?? "";

  if (fromId === toId) {
    return NextResponse.json(
      { error: "Choose two different locations." },
      { status: 400 },
    );
  }

  const from = getPlace(fromId);
  const to = getPlace(toId);

  if (!from || !to) {
    return NextResponse.json(
      { error: "Unknown starting point or destination." },
      { status: 400 },
    );
  }

  const coordinates = `${from.coordinates.join(",")};${to.coordinates.join(",")}`;
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    "?overview=full&geometries=geojson&steps=true";

  try {
    const osrmResponse = await fetch(osrmUrl, {
      headers: {
        "User-Agent": "CanWeDrive/0.1 (open-source LSV route research tool)",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!osrmResponse.ok) {
      throw new Error(`Routing service returned ${osrmResponse.status}`);
    }

    const osrm = (await osrmResponse.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry?: {
          coordinates?: Coordinate[];
        };
        legs?: Array<{
          steps?: Array<{
            name?: string;
            distance: number;
            duration: number;
          }>;
        }>;
      }>;
    };

    if (osrm.code !== "Ok" || !osrm.routes?.[0]?.geometry?.coordinates?.length) {
      return NextResponse.json(
        { error: "No driving route was found between those locations." },
        { status: 404 },
      );
    }

    const route = osrm.routes?.[0];
    if (!route?.geometry?.coordinates?.length) {
      return NextResponse.json(
        { error: "No driving route geometry was returned." },
        { status: 502 },
      );
    }
    const routeCoordinates: Coordinate[] = route.geometry.coordinates;

    let speedWays: OverpassWay[] = [];

    try {
      speedWays = await fetchStoredSpeedWays({
        type: "LineString",
        coordinates: routeCoordinates,
      });
    } catch {
      speedWays = [];
    }

    if (speedWays.length === 0) {
      try {
        speedWays = await fetchSpeedWays(routeCoordinates);
      } catch {
        speedWays = [];
      }
    }

    const { grid, cellSize } = buildGrid(speedWays);
    const segments: RouteSegment[] = [];
    let unknownCount = 0;
    let blockedCount = 0;

    for (let i = 1; i < routeCoordinates.length; i += 1) {
      const start = routeCoordinates[i - 1];
      const end = routeCoordinates[i];
      const midpoint: Coordinate = [
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2,
      ];

      const speedMph = nearestSpeedForPoint(
        midpoint,
        speedWays,
        grid,
        cellSize,
      );
      const status =
        speedMph === null
          ? "unknown"
          : speedMph > LSV_MAX_SPEED_MPH
            ? "blocked"
            : "eligible";

      if (status === "unknown") unknownCount += 1;
      if (status === "blocked") blockedCount += 1;

      segments.push({
        coordinates: [start, end],
        status,
        speedMph:
          speedMph === null ? null : Math.round(speedMph * 10) / 10,
        source: speedMph === null ? null : "OpenStreetMap",
      });
    }

    const overallStatus =
      blockedCount > 0
        ? "blocked"
        : unknownCount > 0
          ? "unknown"
          : "eligible";

    return NextResponse.json({
      vehicle: {
        id: "golf_cart_lsv",
        maxRoadSpeedMph: LSV_MAX_SPEED_MPH,
      },
      from: {
        id: from.id,
        name: from.name,
        coordinates: from.coordinates,
      },
      to: {
        id: to.id,
        name: to.name,
        coordinates: to.coordinates,
      },
      route: {
        status: overallStatus,
        distanceMiles: Math.round((route.distance / 1609.344) * 10) / 10,
        durationMinutes: Math.max(1, Math.round(route.duration / 60)),
        geometry: {
          type: "LineString",
          coordinates: routeCoordinates,
        },
        segments,
        speedDataAvailable: speedWays.length > 0,
      },
    });
  } catch (error) {
    console.error("CanWeDrive route error", error);

    return NextResponse.json(
      {
        error:
          "Routing is temporarily unavailable. Try again in a moment.",
      },
      { status: 502 },
    );
  }
}
