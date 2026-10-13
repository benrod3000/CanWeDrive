export type RoadSpeedStatus = "eligible" | "assumed" | "unknown" | "blocked";

export type RoadSpeedMetadata = {
  id: number;
  highway_type: string | null;
  lsv_status: string;
  lsv_reason: string | null;
  maxspeed_mph: number | null;
  maxspeed_conditional: string | null;
  osm_maxspeed_raw: string | null;
  osm_maxspeed_forward_raw: string | null;
  osm_maxspeed_backward_raw: string | null;
};

export function roadSpeedStatus(
  row: { edge_status: string; maxspeed_mph: number | null; geom_geojson: { coordinates?: [number, number][] } | null },
  metadata?: RoadSpeedMetadata,
): RoadSpeedStatus {
  if (row.edge_status === "restricted" || row.edge_status === "verified_blocked" || (row.maxspeed_mph !== null && row.maxspeed_mph > 35)) return "blocked";
  if (row.edge_status === "verified_eligible" && row.maxspeed_mph !== null) return "eligible";
  if (row.edge_status !== "unknown" || row.maxspeed_mph !== null || !metadata) return "unknown";

  // Limit this display assumption to our North County, California service area.
  // A missing OSM tag is not evidence that a street has no posted speed sign.
  const coordinates = row.geom_geojson?.coordinates ?? [];
  const inServiceArea = coordinates.length >= 2 && coordinates.every(([lon, lat]) =>
    lon >= -117.6 && lon <= -117.0 && lat >= 32.9 && lat <= 33.4);
  const hasSpeedTag = [metadata.maxspeed_conditional, metadata.osm_maxspeed_raw,
    metadata.osm_maxspeed_forward_raw, metadata.osm_maxspeed_backward_raw].some((tag) => tag?.trim());
  return inServiceArea && metadata.highway_type === "residential" &&
    metadata.lsv_status === "unknown" && metadata.lsv_reason === "no usable posted speed tag" &&
    metadata.maxspeed_mph === null && !hasSpeedTag ? "assumed" : "unknown";
}

export function speedCoverage(distanceMiles: number, unknownMiles: number, assumedMiles: number) {
  const percent = (miles: number) => distanceMiles > 0 ? Math.max(0, Math.min(100, Math.round(miles / distanceMiles * 100))) : 0;
  return {
    status: unknownMiles > 0 ? "unknown" as const : assumedMiles > 0 ? "assumed" as const : "eligible" as const,
    unknownMiles,
    assumedMiles,
    mappedSpeedPercent: percent(distanceMiles - unknownMiles - assumedMiles),
    unknownSpeedPercent: percent(unknownMiles),
    speedDataAvailable: unknownMiles === 0 && assumedMiles === 0,
  };
}
