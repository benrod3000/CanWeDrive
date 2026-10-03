import { NextRequest, NextResponse } from "next/server";

import { getPlace } from "@/lib/locations";
import { getRouteTerrain } from "@/lib/terrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LSV_MAX_SPEED_MPH = 35;

type Coordinate = [number, number];

type RouteDirection = {
  instruction: string;
  roadName: string;
  distanceMiles: number;
};

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

function haversineMiles(start: Coordinate, end: Coordinate) {
  const earthRadiusMiles = 3958.7613;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(end[1] - start[1]);
  const dLon = toRadians(end[0] - start[0]);
  const lat1 = toRadians(start[1]);
  const lat2 = toRadians(end[1]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(start: Coordinate, end: Coordinate) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const toDegrees = (value: number) => (value * 180) / Math.PI;
  const lon1 = toRadians(start[0]);
  const lon2 = toRadians(end[0]);
  const lat1 = toRadians(start[1]);
  const lat2 = toRadians(end[1]);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function compassDirection(bearing: number) {
  const directions = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return directions[Math.round(bearing / 45) % 8];
}

function turnWord(previousBearing: number, nextBearing: number) {
  let delta = nextBearing - previousBearing;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;

  const absolute = Math.abs(delta);
  if (absolute >= 135) return "Make a U-turn";
  if (absolute >= 35) return delta > 0 ? "Turn right" : "Turn left";
  if (absolute >= 18) return delta > 0 ? "Bear right" : "Bear left";
  return "Continue";
}

function buildDirections(rows: GraphRouteRow[]): RouteDirection[] {
  const groups: Array<{
    roadName: string;
    distanceMiles: number;
    firstCoordinate: Coordinate;
    lastCoordinate: Coordinate;
    firstBearing: number;
  }> = [];

  for (const row of rows) {
    const coordinates = row.geom_geojson?.coordinates ?? [];
    if (coordinates.length < 2) continue;

    const roadName = row.edge_name?.trim() || "Unnamed road";
    const distanceMiles = row.length_m / 1609.344;
    const firstCoordinate = coordinates[0];
    const lastCoordinate = coordinates[coordinates.length - 1];
    const firstBearing = bearingDegrees(firstCoordinate, coordinates[1]);
    const lastBearing = bearingDegrees(coordinates[coordinates.length - 2], lastCoordinate);
    const previous = groups[groups.length - 1];

    if (previous && previous.roadName === roadName) {
      previous.distanceMiles += distanceMiles;
      previous.lastCoordinate = lastCoordinate;
    } else {
      groups.push({
        roadName,
        distanceMiles,
        firstCoordinate,
        lastCoordinate,
        firstBearing,
      });
    }

    if (previous && previous.roadName === roadName) {
      (previous as typeof previous & { lastBearing?: number }).lastBearing = lastBearing;
    } else {
      (groups[groups.length - 1] as typeof groups[number] & { lastBearing?: number }).lastBearing = lastBearing;
    }
  }

  if (!groups.length) return [];

  return groups.map((group, index) => {
    const distanceMiles = Math.max(0.01, group.distanceMiles);
    if (index === 0) {
      return {
        instruction: `Head ${compassDirection(group.firstBearing)} on ${group.roadName}`,
        roadName: group.roadName,
        distanceMiles,
      };
    }

    const previous = groups[index - 1];
    const previousBearing =
      (previous as typeof previous & { lastBearing?: number }).lastBearing ?? previous.firstBearing;
    const maneuver = turnWord(previousBearing, group.firstBearing);

    return {
      instruction: `${maneuver} onto ${group.roadName}`,
      roadName: group.roadName,
      distanceMiles,
    };
  });
}

async function fetchGraphRoute(from: Coordinate, to: Coordinate) {
  const supabaseUrl = "https://bsnspyjsirfayypcvpmc.supabase.co";
  const supabaseKey = "sb_publishable_8GiFIyTV438cg8WbL_qV4Q_uj8COv_O";

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/route_lsv_candidate`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
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
  });

  if (!response.ok) throw new Error(`Graph routing returned ${response.status}`);
  return (await response.json()) as GraphRouteRow[];
}

async function buildGraphRouteResult(rows: GraphRouteRow[], includeTerrain = true) {
  const routeCoordinates: Coordinate[] = [];
  const segments: Array<{
    coordinates: Coordinate[];
    status: "eligible" | "blocked" | "unknown";
    speedMph: number | null;
    source: "OpenStreetMap" | null;
  }> = [];
  let distanceMeters = 0;
  let unknownMiles = 0;

  for (const row of rows) {
    const coordinates = row.geom_geojson?.coordinates ?? [];
    if (coordinates.length < 2) continue;

    distanceMeters += row.length_m;
    for (const coordinate of coordinates) {
      const previous = routeCoordinates[routeCoordinates.length - 1];
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        routeCoordinates.push(coordinate);
      }
    }

    const status = row.edge_status === "verified_eligible" ? "eligible" : "unknown";
    if (status === "unknown") unknownMiles += row.length_m / 1609.344;

    segments.push({
      coordinates,
      status,
      speedMph: row.maxspeed_mph === null ? null : Math.round(row.maxspeed_mph * 10) / 10,
      source: row.maxspeed_mph === null ? null : "OpenStreetMap",
    });
  }

  if (routeCoordinates.length < 2) return null;

  const distanceMiles = distanceMeters / 1609.344;
  const durationMinutes = Math.round(
    segments.reduce((minutes, segment) => {
      const segmentMiles = segment.coordinates.reduce((miles, coordinate, index, coordinates) => {
        if (index === 0) return miles;
        return miles + haversineMiles(coordinates[index - 1], coordinate);
      }, 0);
      return minutes + (segmentMiles / Math.max(1, segment.speedMph ?? 25)) * 60;
    }, 0),
  );

  return {
    status: unknownMiles > 0 ? ("unknown" as const) : ("eligible" as const),
    blockedMiles: 0,
    unknownMiles,
    alternativesConsidered: 1,
    routerConstraints: {
      excludedClasses: ["motorway", "motorway_link", "motorroad"],
    },
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    durationMinutes,
    geometry: { type: "LineString" as const, coordinates: routeCoordinates },
    segments,
    directions: buildDirections(rows),
    speedDataAvailable: unknownMiles === 0,
    terrain: includeTerrain ? await getRouteTerrain(routeCoordinates) : null,
  };
}

async function buildMultiStopRoute(stops: Array<{ name: string; coordinates: Coordinate }>) {
  if (stops.length < 2 || stops.length > 3) throw new Error("A route needs two or three stops.");

  const legs = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const rows = await fetchGraphRoute(stops[index].coordinates, stops[index + 1].coordinates);
    const leg = await buildGraphRouteResult(rows, false);
    if (!leg) throw new Error(`No LSV route was found between ${stops[index].name} and ${stops[index + 1].name}.`);
    legs.push(leg);
  }

  const routeCoordinates: Coordinate[] = [];
  const segments = [];
  const directions: RouteDirection[] = [];
  let distanceMiles = 0;
  let durationMinutes = 0;
  let unknownMiles = 0;

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    distanceMiles += leg.distanceMiles;
    durationMinutes += leg.durationMinutes ?? 0;
    unknownMiles += leg.unknownMiles;

    for (const coordinate of leg.geometry.coordinates) {
      const previous = routeCoordinates[routeCoordinates.length - 1];
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) routeCoordinates.push(coordinate);
    }

    segments.push(...leg.segments);
    directions.push(...leg.directions);
    if (index < legs.length - 1) {
      directions.push({ instruction: `Continue to stop ${String.fromCharCode(67 + index)}`, roadName: "Stop", distanceMiles: 0 });
    }
  }

  return {
    status: unknownMiles > 0 ? ("unknown" as const) : ("eligible" as const),
    blockedMiles: 0,
    unknownMiles,
    alternativesConsidered: 1,
    routerConstraints: { excludedClasses: ["motorway", "motorway_link", "motorroad"] },
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    durationMinutes: Math.round(durationMinutes),
    geometry: { type: "LineString" as const, coordinates: routeCoordinates },
    segments,
    directions,
    speedDataAvailable: unknownMiles === 0,
    terrain: routeCoordinates.length >= 2 ? await getRouteTerrain(routeCoordinates) : null,
  };
}

export async function GET(request: NextRequest) {
  const fromId = request.nextUrl.searchParams.get("from") ?? "";
  const toId = request.nextUrl.searchParams.get("to") ?? "";
  const fromLon = Number(request.nextUrl.searchParams.get("fromLon"));
  const fromLat = Number(request.nextUrl.searchParams.get("fromLat"));
  const toLon = Number(request.nextUrl.searchParams.get("toLon"));
  const toLat = Number(request.nextUrl.searchParams.get("toLat"));
  const hasCoordinates = [fromLon, fromLat, toLon, toLat].every(Number.isFinite);
  const fromPlace = getPlace(fromId);
  const toPlace = getPlace(toId);

  const from = hasCoordinates
    ? { id: "custom-from", name: request.nextUrl.searchParams.get("fromName") ?? fromPlace?.name ?? "Selected starting point", coordinates: [fromLon, fromLat] as Coordinate }
    : fromPlace;
  const to = hasCoordinates
    ? { id: "custom-to", name: request.nextUrl.searchParams.get("toName") ?? toPlace?.name ?? "Selected destination", coordinates: [toLon, toLat] as Coordinate }
    : toPlace;

  if (!from || !to) return NextResponse.json({ error: "Choose a starting point and destination." }, { status: 400 });
  return routeStops(request, [from, to]);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { stops?: Array<{ name?: string; coordinates?: Coordinate }> };
    const stops = (body.stops ?? []).map((stop) => ({ name: stop.name?.trim() || "Selected point", coordinates: stop.coordinates }));

    if (
      stops.length < 2 ||
      stops.length > 3 ||
      stops.some((stop) => !Array.isArray(stop.coordinates) || stop.coordinates.length !== 2 || !stop.coordinates.every(Number.isFinite))
    ) {
      return NextResponse.json({ error: "Provide two or three valid route stops." }, { status: 400 });
    }

    return routeStops(request, stops as Array<{ name: string; coordinates: Coordinate }>);
  } catch {
    return NextResponse.json({ error: "Invalid route request." }, { status: 400 });
  }
}

async function routeStops(
  request: NextRequest,
  stops: Array<{ name: string; coordinates: Coordinate }>,
) {
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index - 1].coordinates[0] === stops[index].coordinates[0] && stops[index - 1].coordinates[1] === stops[index].coordinates[1]) {
      return NextResponse.json({ error: "Choose different points for each stop." }, { status: 400 });
    }
  }

  const startedAt = Date.now();
  try {
    const graphResult = await buildMultiStopRoute(stops);
    const response = NextResponse.json({
      vehicle: { id: "golf_cart_lsv", maxRoadSpeedMph: LSV_MAX_SPEED_MPH },
      from: stops[0],
      to: stops[stops.length - 1],
      stops,
      route: graphResult,
    });
    response.headers.set("x-can-we-cart-version", process.env.VERCEL_GIT_COMMIT_SHA ?? "local");
    response.headers.set("x-can-we-cart-route-ms", String(Date.now() - startedAt));
    return response;
  } catch (error) {
    console.error("Can We Cart route error", {
      error: error instanceof Error ? error.message : String(error),
      stops,
      elapsedMs: Date.now() - startedAt,
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    });
    const message = error instanceof Error ? error.message : "Routing is temporarily unavailable.";
    return NextResponse.json({ error: message }, { status: message.startsWith("No LSV route") ? 404 : 502 });
  }
}
