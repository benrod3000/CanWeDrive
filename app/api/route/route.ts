import { NextRequest, NextResponse } from "next/server";

import { getPlace } from "@/lib/locations";
import { getRouteTerrain } from "@/lib/terrain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const LSV_MAX_SPEED_MPH = 35;
const MATCH_DISTANCE_METERS = 35;
const ROUTER_EXCLUDE_CLASSES = "motorway";

type Coordinate = [number, number];

type OverpassWay = {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

type RouteSegment = {
  coordinates: Coordinate[];
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

type GraphRouteRow = {
  path_seq: number;
  edge_id: number;
  edge_name: string | null;
  edge_status: "verified_eligible" | "restricted" | "unknown" | "verified_blocked";
  maxspeed_mph: number | null;
  length_m: number;
  geom_geojson: {
    type?: string;
    coordinates?: Coordinate[];
  } | null;
};

type GraphRouteResult = {
  rows: GraphRouteRow[];
  networkAvailable: boolean;
};

async function fetchGraphRoute(
  from: Coordinate,
  to: Coordinate,
): Promise<GraphRouteResult> {
  // This route is intentionally pinned to the Can We Cart Supabase project.
  // The publishable key is public by design and avoids accidentally inheriting
  // unrelated Vercel environment variables from another project.
  const supabaseUrl = "https://bsnspyjsirfayypcvpmc.supabase.co";
  const supabaseKey = "sb_publishable_8GiFIyTV438cg8WbL_qV4Q_uj8COv_O";

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/route_lsv_candidate`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_lon: from[0],
        start_lat: from[1],
        end_lon: to[0],
        end_lat: to[1],
        allow_unknown: true,
        snap_max_distance_meters: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Graph routing returned ${response.status}`);
  }

  const rows = (await response.json()) as GraphRouteRow[];
  return { rows, networkAvailable: true };
}

async function buildGraphRouteResult(rows: GraphRouteRow[], includeTerrain = true) {
  const routeCoordinates: Coordinate[] = [];
  const segments: RouteSegment[] = [];
  let distanceMeters = 0;
  let unknownMiles = 0;

  for (const row of rows) {
    const coordinates = row.geom_geojson?.coordinates ?? [];
    if (coordinates.length < 2) continue;

    distanceMeters += row.length_m;

    for (const coordinate of coordinates) {
      const previous = routeCoordinates[routeCoordinates.length - 1];
      if (
        !previous ||
        previous[0] !== coordinate[0] ||
        previous[1] !== coordinate[1]
      ) {
        routeCoordinates.push(coordinate);
      }
    }

    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    const status =
      row.edge_status === "verified_eligible" ? "eligible" : "unknown";

    if (status === "unknown") {
      unknownMiles += row.length_m / 1609.344;
    }

    segments.push({
      coordinates,
      status,
      speedMph:
        row.maxspeed_mph === null
          ? null
          : Math.round(row.maxspeed_mph * 10) / 10,
      source: row.maxspeed_mph === null ? null : "OpenStreetMap",
    });
  }

  if (routeCoordinates.length < 2) return null;

  const distanceMiles = distanceMeters / 1609.344;
  const estimatedMinutes = segments.reduce((minutes, segment) => {
    const segmentMiles = segment.coordinates.reduce((miles, coordinate, index, coordinates) => {
      if (index === 0) return miles;
      const [lon1, lat1] = coordinates[index - 1];
      const [lon2, lat2] = coordinate;
      const toRadians = (value: number) => (value * Math.PI) / 180;
      const dLat = toRadians(lat2 - lat1);
      const dLon = toRadians(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
          Math.cos(toRadians(lat2)) *
          Math.sin(dLon / 2) ** 2;
      return miles + (3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }, 0);
    const assumedSpeed = segment.speedMph ?? 25;
    return minutes + (segmentMiles / Math.max(1, assumedSpeed)) * 60;
  }, 0);
  const terrain = includeTerrain ? await getRouteTerrain(routeCoordinates) : null;

  return {
    status: unknownMiles > 0 ? ("unknown" as const) : ("eligible" as const),
    blockedMiles: 0,
    unknownMiles,
    alternativesConsidered: 1,
    routerConstraints: {
      excludedClasses: ["motorway", "motorway_link", "motorroad"],
    },
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    durationMinutes: Math.round(estimatedMinutes),
    geometry: {
      type: "LineString" as const,
      coordinates: routeCoordinates,
    },
    segments,
    speedDataAvailable: unknownMiles === 0,
    terrain,
  };
}

async function buildMultiStopRoute(stops: Array<{ name: string; coordinates: Coordinate }>) {
  if (stops.length < 2 || stops.length > 3) {
    throw new Error("A route needs two or three stops.");
  }

  const legs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const graphRoute = await fetchGraphRoute(
      stops[index].coordinates,
      stops[index + 1].coordinates,
    );

    if (!graphRoute.networkAvailable) {
      throw new Error("The LSV road network is not available yet.");
    }

    const leg = await buildGraphRouteResult(graphRoute.rows, false);
    if (!leg) {
      throw new Error(
        \`No LSV route was found between \${stops[index].name} and \${stops[index + 1].name}.\`,
      );
    }
    legs.push(leg);
  }

  const routeCoordinates: Coordinate[] = [];
  const segments: RouteSegment[] = [];
  let distanceMiles = 0;
  let durationMinutes = 0;
  let unknownMiles = 0;

  for (const leg of legs) {
    distanceMiles += leg.distanceMiles;
    durationMinutes += leg.durationMinutes ?? 0;
    unknownMiles += leg.unknownMiles;

    for (const coordinate of leg.geometry.coordinates) {
      const previous = routeCoordinates[routeCoordinates.length - 1];
      if (
        !previous ||
        previous[0] !== coordinate[0] ||
        previous[1] !== coordinate[1]
      ) {
        routeCoordinates.push(coordinate);
      }
    }

    segments.push(...leg.segments);
  }

  const terrain =
    routeCoordinates.length >= 2
      ? await getRouteTerrain(routeCoordinates)
      : null;

  return {
    status: unknownMiles > 0 ? ("unknown" as const) : ("eligible" as const),
    blockedMiles: 0,
    unknownMiles,
    alternativesConsidered: 1,
    routerConstraints: {
      excludedClasses: ["motorway", "motorway_link", "motorroad"],
    },
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    durationMinutes: Math.round(durationMinutes),
    geometry: {
      type: "LineString" as const,
      coordinates: routeCoordinates,
    },
    segments,
    speedDataAvailable: unknownMiles === 0,
    terrain,
  };
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

function evaluateRoute(
  routeCoordinates: Coordinate[],
  speedWays: OverpassWay[],
) {
  const { grid, cellSize } = buildGrid(speedWays);
  const segments: RouteSegment[] = [];
  let unknownMiles = 0;
  let blockedMiles = 0;

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

    const segmentMiles = haversineMiles(start, end);
    if (status === "unknown") unknownMiles += segmentMiles;
    if (status === "blocked") blockedMiles += segmentMiles;

    segments.push({
      coordinates: [start, end],
      status,
      speedMph:
        speedMph === null ? null : Math.round(speedMph * 10) / 10,
      source: speedMph === null ? null : "OpenStreetMap",
    });
  }

  const overallStatus =
    blockedMiles > 0
      ? "blocked"
      : unknownMiles > 0
        ? "unknown"
        : "eligible";

  return {
    status: overallStatus as "eligible" | "blocked" | "unknown",
    segments,
    unknownMiles,
    blockedMiles,
  };
}

function haversineMiles(start: Coordinate, end: Coordinate) {
  const earthRadiusMiles = 3958.7613;
  const dLat = toRadians(end[1] - start[1]);
  const dLon = toRadians(end[0] - start[0]);
  const lat1 = toRadians(start[1]);
  const lat2 = toRadians(end[1]);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
        "User-Agent": "Can We Cart/0.1 (open-source LSV route research tool)",
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

  const fromLon = Number(request.nextUrl.searchParams.get("fromLon"));
  const fromLat = Number(request.nextUrl.searchParams.get("fromLat"));
  const toLon = Number(request.nextUrl.searchParams.get("toLon"));
  const toLat = Number(request.nextUrl.searchParams.get("toLat"));

  const hasCoordinateRoute = [fromLon, fromLat, toLon, toLat].every(
    (value) => Number.isFinite(value),
  );

  const fromPlace = getPlace(fromId);
  const toPlace = getPlace(toId);

  const from = hasCoordinateRoute
    ? {
        id: "custom-from",
        name:
          request.nextUrl.searchParams.get("fromName") ??
          fromPlace?.name ??
          "Selected starting point",
        coordinates: [fromLon, fromLat] as Coordinate,
      }
    : fromPlace;

  const to = hasCoordinateRoute
    ? {
        id: "custom-to",
        name:
          request.nextUrl.searchParams.get("toName") ??
          toPlace?.name ??
          "Selected destination",
        coordinates: [toLon, toLat] as Coordinate,
      }
    : toPlace;

  if (!from || !to) {
    return NextResponse.json(
      { error: "Choose a starting point and destination." },
      { status: 400 },
    );
  }

  return routeStops(request, [from, to]);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      stops?: Array<{ name?: string; coordinates?: Coordinate }>;
    };

    const stops = (body.stops ?? []).map((stop) => ({
      name: stop.name?.trim() || "Selected point",
      coordinates: stop.coordinates,
    }));

    if (
      stops.length < 2 ||
      stops.length > 3 ||
      stops.some(
        (stop) =>
          !Array.isArray(stop.coordinates) ||
          stop.coordinates.length !== 2 ||
          !stop.coordinates.every((value) => Number.isFinite(value)),
      )
    ) {
      return NextResponse.json(
        { error: "Provide two or three valid route stops." },
        { status: 400 },
      );
    }

    return routeStops(
      request,
      stops as Array<{ name: string; coordinates: Coordinate }>,
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid route request." },
      { status: 400 },
    );
  }
}

async function routeStops(
  request: NextRequest,
  stops: Array<{ name: string; coordinates: Coordinate }>,
) {
  for (let index = 1; index < stops.length; index += 1) {
    if (
      stops[index - 1].coordinates[0] === stops[index].coordinates[0] &&
      stops[index - 1].coordinates[1] === stops[index].coordinates[1]
    ) {
      return NextResponse.json(
        { error: "Choose different points for each stop." },
        { status: 400 },
      );
    }
  }

  const startedAt = Date.now();

  try {
    const graphResult = await buildMultiStopRoute(stops);

    const response = NextResponse.json({
      vehicle: {
        id: "golf_cart_lsv",
        maxRoadSpeedMph: LSV_MAX_SPEED_MPH,
      },
      from: stops[0],
      to: stops[stops.length - 1],
      stops,
      route: graphResult,
    });

    response.headers.set(
      "x-can-we-cart-version",
      process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    );
    response.headers.set(
      "x-can-we-cart-route-ms",
      String(Date.now() - startedAt),
    );
    return response;
  } catch (error) {
    console.error("Can We Cart route error", {
      error: error instanceof Error ? error.message : String(error),
      stops,
      elapsedMs: Date.now() - startedAt,
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    });

    const message =
      error instanceof Error
        ? error.message
        : "Routing is temporarily unavailable.";

    return NextResponse.json(
      { error: message },
      { status: message.startsWith("No LSV route") ? 404 : 502 },
    );
  }
}

