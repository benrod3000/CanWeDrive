import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, globals = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  runInNewContext(outputText, { exports, ...globals }, { filename: url.pathname });
  return exports;
}
const speed = load("../lib/road-speed.ts");
const edge = (id = 1, overrides = {}) => ({
  path_seq: id, edge_id: id, edge_name: "Neighborhood street", edge_status: "unknown",
  maxspeed_mph: null, speed_source: null, length_m: 160.9344,
  geom_geojson: { type: "LineString", coordinates: [[-117.26, 33.06], [-117.259, 33.06]] },
  ...overrides,
});
const residential = (id = 1, overrides = {}) => ({
  id, highway_type: "residential", lsv_status: "unknown", lsv_reason: "no usable posted speed tag",
  maxspeed_mph: null, maxspeed_conditional: null, osm_maxspeed_raw: null,
  osm_maxspeed_forward_raw: null, osm_maxspeed_backward_raw: null, ...overrides,
});

test("only untagged residential roads in the California service area receive the assumption", () => {
  assert.equal(speed.roadSpeedStatus(edge(), residential()), "assumed");
  for (const highway_type of ["tertiary", "secondary", "service", "living_street", null]) {
    assert.equal(speed.roadSpeedStatus(edge(), residential(1, { highway_type })), "unknown");
  }
  assert.equal(speed.roadSpeedStatus(edge()), "unknown");
  assert.equal(speed.roadSpeedStatus(edge(1, { geom_geojson: null }), residential()), "unknown");
  assert.equal(speed.roadSpeedStatus(edge(1, { geom_geojson: { coordinates: [[-73, 40], [-73.01, 40]] } }), residential()), "unknown");
});

test("mapped limits, restrictions, conditional and unparsed tags never become assumed 25", () => {
  assert.equal(speed.roadSpeedStatus(edge(1, { edge_status: "verified_eligible", maxspeed_mph: 35 }), residential()), "eligible");
  for (const overrides of [{ maxspeed_mph: 40 }, { edge_status: "verified_blocked" }, { edge_status: "restricted" }]) {
    assert.equal(speed.roadSpeedStatus(edge(1, overrides), residential()), "blocked");
  }
  for (const overrides of [
    { maxspeed_conditional: "40 @ (Mo-Fr)" }, { osm_maxspeed_raw: "signals" },
    { osm_maxspeed_forward_raw: "40 mph" }, { osm_maxspeed_backward_raw: "40 mph" },
    { maxspeed_mph: 40 }, { lsv_status: "restricted" }, { lsv_reason: "restricted access" },
  ]) assert.equal(speed.roadSpeedStatus(edge(), residential(1, overrides)), "unknown");
  assert.equal(speed.roadSpeedStatus(edge(1, { maxspeed_mph: 25 }), residential()), "unknown");
});

function fixture(legs, metadata = [], failMetadata = false) {
  const requests = [];
  let legIndex = 0;
  const route = load("../app/api/route/route.ts", {
    require(name) {
      if (name === "next/server") return { NextResponse: Response };
      if (name === "@/lib/road-speed") return speed;
      if (name === "@/lib/locations") return { getPlace: () => null };
      if (name === "@/lib/terrain") return { getRouteTerrain: async () => null };
      throw new Error(`Unexpected dependency ${name}`);
    },
    fetch: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname.endsWith("/route_lsv_candidate_with_source")) return Response.json(legs[legIndex++]);
      assert.equal(url.pathname, "/rest/v1/road_edges");
      if (failMetadata) return new Response("unavailable", { status: 503 });
      const ids = url.searchParams.get("id").slice(4, -1).split(",").map(Number);
      return Response.json(metadata.filter((item) => ids.includes(item.id)));
    },
    AbortSignal, URLSearchParams, process: { env: {} }, console: { warn() {}, error() {} },
  });
  return {
    requests,
    post: (count = 2) => route.POST(new Request("https://example.test/api/route", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stops: Array.from({ length: count }, (_, i) => ({ name: `Stop ${i}`, coordinates: [-117.26 + i * 0.001, 33.06] })) }),
    })),
    get: () => route.GET({ nextUrl: new URL("https://example.test/api/route?fromLon=-117.26&fromLat=33.06&toLon=-117.259&toLat=33.06") }),
  };
}

test("GET and POST separate assumed, mapped, and unknown distance without changing graph constraints", async () => {
  for (const method of ["get", "post"]) {
    const f = fixture([[edge(1), edge(2, { edge_status: "verified_eligible", maxspeed_mph: 35 }), edge(3)]], [residential()]);
    const response = await f[method]();
    assert.equal(response.status, 200);
    const { route } = await response.json();
    assert.equal(route.status, "unknown");
    assert.equal(route.assumedMiles, 0.1);
    assert.equal(route.unknownMiles, 0.1);
    assert.equal(route.mappedSpeedPercent, 33);
    assert.equal(route.unknownSpeedPercent, 33);
    assert.equal(route.speedDataAvailable, false);
    assert.deepEqual(route.segments.map((segment) => segment.status), ["assumed", "eligible", "unknown"]);
    assert.equal(route.segments[0].speedMph, null, "do not fabricate a mapped speed");
    assert.equal(route.segments[0].assumedSpeedMph, 25);
    assert.equal(route.segments[0].source, "california_residential_default");
    assert.equal(JSON.parse(f.requests[0].options.body).allow_unknown, true);
    assert.equal(f.requests[1].url.searchParams.get("id"), "in.(1,3)");
  }
});

test("multi-stop routes retain full-precision coverage and do not count assumptions as mapped", async () => {
  const f = fixture([[edge(1, { length_m: 80.4672 })], [edge(2, { length_m: 80.4672 })]], [residential(1), residential(2)]);
  const { route } = await (await f.post(3)).json();
  assert.equal(route.distanceMiles, 0.1, "sum distances before rounding the display");
  assert.equal(route.assumedMiles, 0.1);
  assert.equal(route.mappedSpeedPercent, 0);
  assert.equal(route.status, "assumed");
  assert.equal(route.speedDataAvailable, false);
});

test("metadata failures keep the route usable but unknown; mapped-only routes skip enrichment", async () => {
  const failed = fixture([[edge()]], [], true);
  const { route } = await (await failed.post()).json();
  assert.equal(route.status, "unknown");
  assert.equal(route.assumedMiles, 0);
  const mapped = fixture([[edge(1, { edge_status: "verified_eligible", maxspeed_mph: 25 })]]);
  const payload = await (await mapped.post()).json();
  assert.equal(payload.route.status, "eligible");
  assert.equal(payload.route.mappedSpeedPercent, 100);
  assert.equal(mapped.requests.length, 1);
});

test("metadata requests deduplicate and batch long routes", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => edge(i + 1));
  const f = fixture([[...rows, rows[0]]], rows.map((row) => residential(row.edge_id)));
  const { route } = await (await f.post()).json();
  assert.equal(route.status, "assumed");
  const batches = f.requests.slice(1).map(({ url }) => url.searchParams.get("id").slice(4, -1).split(","));
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
});

test("a blocked edge returned by the graph is rejected rather than relabeled unknown", async () => {
  const f = fixture([[edge(1, { edge_status: "verified_blocked", maxspeed_mph: 40 })]]);
  const response = await f.post();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /restricted or over-35/);
});
