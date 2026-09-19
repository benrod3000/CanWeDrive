#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const inputPath = process.argv[2];
const outputDir = process.argv[3] ?? "data/road-import";

if (!inputPath) {
  console.error("Usage: node scripts/build-road-import.mjs <roads.geojsonseq> [outputDir]");
  process.exit(1);
}

const INCLUDED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
]);

const EXCLUDED_HIGHWAYS = new Set([
  "construction",
  "proposed",
  "abandoned",
  "path",
  "footway",
  "cycleway",
  "bridleway",
  "steps",
  "pedestrian",
  "corridor",
  "raceway",
]);

const HARD_BLOCK_ACCESS = new Set(["no", "private"]);
const RESTRICTED_ACCESS = new Set(["customers", "destination", "delivery"]);

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n\r\t]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(",") + "\n";
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineMeters(a, b) {
  const earthRadiusMeters = 6371008.8;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function segmentLengthMeters(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    total += haversineMeters(coordinates[i - 1], coordinates[i]);
  }
  return total;
}

function normalizeAttribute(properties, name) {
  return properties?.[`@${name}`] ?? properties?.[name] ?? null;
}

function parseSpeedMph(value) {
  if (!value || typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "signals" ||
    normalized === "walk" ||
    normalized.includes("variable")
  ) {
    return null;
  }

  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const speed = Number(match[0]);

  if (normalized.includes("km/h") || normalized.includes("kph")) {
    return speed / 1.609344;
  }

  // This importer is California-specific. Bare OSM speed values are
  // interpreted as MPH so the stored network can be evaluated consistently.
  return speed;
}

function getOnewayDirection(tags) {
  const value = (tags.oneway ?? "").toLowerCase();

  if (value === "-1") return "backward";
  if (value === "yes" || value === "true" || value === "1") return "forward";
  if (tags.junction === "roundabout") return "forward";

  return "both";
}

function accessStatus(tags, highway, speedMph, conditionalSpeed) {
  if (highway === "motorway" || highway === "motorway_link") {
    return {
      status: "verified_blocked",
      reason: `highway=${highway}`,
    };
  }

  if (tags.motorroad === "yes") {
    return {
      status: "verified_blocked",
      reason: "motorroad=yes",
    };
  }

  if (
    HARD_BLOCK_ACCESS.has(tags.access) ||
    HARD_BLOCK_ACCESS.has(tags.vehicle) ||
    HARD_BLOCK_ACCESS.has(tags.motor_vehicle) ||
    HARD_BLOCK_ACCESS.has(tags.motorcar)
  ) {
    return {
      status: "verified_blocked",
      reason: "explicit motor-vehicle access prohibition",
    };
  }

  if (
    RESTRICTED_ACCESS.has(tags.access) ||
    RESTRICTED_ACCESS.has(tags.vehicle) ||
    RESTRICTED_ACCESS.has(tags.motor_vehicle) ||
    RESTRICTED_ACCESS.has(tags.motorcar)
  ) {
    return {
      status: "restricted",
      reason: `access=${tags.access ?? tags.vehicle ?? tags.motor_vehicle ?? tags.motorcar}`,
    };
  }

  if (conditionalSpeed) {
    return {
      status: "unknown",
      reason: "conditional speed data requires time-aware routing",
    };
  }

  if (speedMph === null) {
    return {
      status: "unknown",
      reason: "no usable posted speed tag",
    };
  }

  if (speedMph > 35) {
    return {
      status: "verified_blocked",
      reason: `maxspeed=${Math.round(speedMph * 10) / 10} mph`,
    };
  }

  return {
    status: "verified_eligible",
    reason: `maxspeed=${Math.round(speedMph * 10) / 10} mph`,
  };
}

function wktLineString(coordinates) {
  return `LINESTRING(${coordinates
    .map(([lon, lat]) => `${lon.toFixed(7)} ${lat.toFixed(7)}`)
    .join(",")})`;
}

fs.mkdirSync(outputDir, { recursive: true });

const nodesPath = `${outputDir}/nodes.csv`;
const edgesPath = `${outputDir}/edges.csv`;

const nodesStream = fs.createWriteStream(nodesPath);
const edgesStream = fs.createWriteStream(edgesPath);

const nodeMap = new Map();
const highwayCounts = new Map();

nodesStream.write("osm_node_id,lon,lat\n");
edgesStream.write([
  "osm_way_id",
  "osm_segment_index",
  "direction",
  "source_osm_node_id",
  "target_osm_node_id",
  "geom_wkt",
  "length_m",
  "name",
  "ref",
  "highway_type",
  "oneway",
  "maxspeed_mph",
  "maxspeed_forward_mph",
  "maxspeed_backward_mph",
  "maxspeed_conditional",
  "access",
  "vehicle",
  "motor_vehicle",
  "motorcar",
  "motorroad",
  "lsv_status",
  "lsv_reason",
  "speed_source",
].join(",") + "\n");

let wayCount = 0;
let segmentCount = 0;

function ensureNode(osmNodeId, coordinate) {
  if (nodeMap.has(osmNodeId)) return;

  const [lon, lat] = coordinate;
  nodeMap.set(osmNodeId, true);
  nodesStream.write(csvLine([osmNodeId, lon, lat]));
}

async function processLine(line) {
  const trimmed = line.replace(/^\u001e/, "").trim();
  if (!trimmed) return;

  let feature;
  try {
    feature = JSON.parse(trimmed);
  } catch {
    return;
  }

  const properties = feature.properties ?? {};
  const geometry = feature.geometry;

  if (!geometry || geometry.type !== "LineString") return;

  const highway = properties.highway;
  if (!highway || !INCLUDED_HIGHWAYS.has(highway) || EXCLUDED_HIGHWAYS.has(highway)) {
    return;
  }

  const osmWayId = Number(normalizeAttribute(properties, "id"));
  const wayNodes = normalizeAttribute(properties, "way_nodes");
  const coordinates = geometry.coordinates;

  if (
    !Number.isSafeInteger(osmWayId) ||
    !Array.isArray(wayNodes) ||
    wayNodes.length !== coordinates.length ||
    coordinates.length < 2
  ) {
    return;
  }

  const tags = properties;
  const maxspeed = parseSpeedMph(tags.maxspeed);
  const maxspeedForward = parseSpeedMph(tags["maxspeed:forward"]);
  const maxspeedBackward = parseSpeedMph(tags["maxspeed:backward"]);
  const conditionalSpeed = tags["maxspeed:conditional"] ?? null;
  const speedSource = tags["source:maxspeed"] ?? "OpenStreetMap";
  const direction = getOnewayDirection(tags);
  const oneway =
    direction !== "both" || String(tags.oneway ?? "").toLowerCase() === "yes";

  highwayCounts.set(highway, (highwayCounts.get(highway) ?? 0) + 1);
  wayCount += 1;

  for (let i = 1; i < coordinates.length; i += 1) {
    const sourceOsmNodeId = Number(wayNodes[i - 1]);
    const targetOsmNodeId = Number(wayNodes[i]);

    if (!Number.isSafeInteger(sourceOsmNodeId) || !Number.isSafeInteger(targetOsmNodeId)) {
      continue;
    }

    ensureNode(sourceOsmNodeId, coordinates[i - 1]);
    ensureNode(targetOsmNodeId, coordinates[i]);

    const forwardSpeed = maxspeedForward ?? maxspeed;
    const backwardSpeed = maxspeedBackward ?? maxspeed;

    if (direction !== "backward") {
      const rule = accessStatus(tags, highway, forwardSpeed, conditionalSpeed);
      edgesStream.write(csvLine([
        osmWayId,
        i - 1,
        "forward",
        sourceOsmNodeId,
        targetOsmNodeId,
        wktLineString([coordinates[i - 1], coordinates[i]]),
        segmentLengthMeters([coordinates[i - 1], coordinates[i]]),
        tags.name ?? null,
        tags.ref ?? null,
        highway,
        oneway,
        forwardSpeed,
        maxspeedForward,
        maxspeedBackward,
        conditionalSpeed,
        tags.access ?? null,
        tags.vehicle ?? null,
        tags.motor_vehicle ?? null,
        tags.motorcar ?? null,
        tags.motorroad ?? null,
        rule.status,
        rule.reason,
        speedSource,
      ]));
      segmentCount += 1;
    }

    if (direction !== "forward") {
      const rule = accessStatus(tags, highway, backwardSpeed, conditionalSpeed);
      edgesStream.write(csvLine([
        osmWayId,
        i - 1,
        "backward",
        targetOsmNodeId,
        sourceOsmNodeId,
        wktLineString([coordinates[i], coordinates[i - 1]]),
        segmentLengthMeters([coordinates[i - 1], coordinates[i]]),
        tags.name ?? null,
        tags.ref ?? null,
        highway,
        oneway,
        backwardSpeed,
        maxspeedForward,
        maxspeedBackward,
        conditionalSpeed,
        tags.access ?? null,
        tags.vehicle ?? null,
        tags.motor_vehicle ?? null,
        tags.motorcar ?? null,
        tags.motorroad ?? null,
        rule.status,
        rule.reason,
        speedSource,
      ]));
      segmentCount += 1;
    }
  }
}

const input = fs.createReadStream(inputPath);
const rl = readline.createInterface({
  input,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  await processLine(line);
}

await Promise.all([
  new Promise((resolve, reject) => {
    nodesStream.end(resolve);
    nodesStream.on("error", reject);
  }),
  new Promise((resolve, reject) => {
    edgesStream.end(resolve);
    edgesStream.on("error", reject);
  }),
]);

const metadata = {
  wayCount,
  segmentCount,
  nodeCount: nodeMap.size,
  highwayCounts: Object.fromEntries(
    [...highwayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  ),
};

fs.writeFileSync(
  `${outputDir}/manifest.json`,
  JSON.stringify(metadata, null, 2) + "\n",
);

console.log(JSON.stringify(metadata, null, 2));
