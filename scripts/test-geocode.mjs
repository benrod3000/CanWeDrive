import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const routeUrl = new URL("../app/api/geocode/route.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(routeUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

// Exercise the real handler with isolated module state and fixture responses.
// No requests reach the public geocoder, and throttle delays are skipped.
function geocoderFixture(respond) {
  const exports = {};
  const requests = [];
  runInNewContext(outputText, {
    exports,
    require: createRequire(routeUrl),
    URL,
    setTimeout: (callback) => callback(),
    fetch: async (input) => {
      const url = new URL(input);
      requests.push(url);
      return Response.json(respond(url));
    },
  }, { filename: routeUrl.pathname });
  return {
    requests,
    get: (params) => exports.GET(new Request(`https://example.test/api/geocode?${params}`)),
  };
}

function target(city, coordinates, id) {
  return {
    name: "Target",
    display_name: `Target, ${city}, California, United States`,
    lat: String(coordinates[1]),
    lon: String(coordinates[0]),
    osm_type: "way",
    osm_id: id,
    category: "shop",
    address: { city, state: "California" },
  };
}

// Deliberately start with the farthest result from the requested Carlsbad center.
const targets = [
  target("Encinitas", [-117.2651064, 33.0625709], 1),
  target("Oceanside", [-117.293228, 33.247039], 2),
  target("Oceanside", [-117.3302607, 33.1841832], 3),
];

test("a named city ranks nearby alternatives ahead of the device's city", async () => {
  const { get, requests } = geocoderFixture(() => targets);
  const response = await get("q=Target+Carlsbad&lat=33.0370&lon=-117.2919");
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.deepEqual(results.map((result) => result.coordinates), [
    [-117.3302607, 33.1841832],
    [-117.293228, 33.247039],
    [-117.2651064, 33.0625709],
  ]);
  assert.ok(requests.every((url) => url.pathname === "/search"));
});

test("a named city also controls distance ranking without device location", async () => {
  const { get } = geocoderFixture(() => targets);
  const { results } = await (await get("q=Target+Carlsbad")).json();
  assert.deepEqual(results[0].coordinates, [-117.3302607, 33.1841832]);
});

test("matches inside the requested city keep their city preference", async () => {
  const inCarlsbad = target("Carlsbad", [-117.25, 33.10], 4);
  const { get } = geocoderFixture(() => [...targets, inCarlsbad]);
  const { results } = await (await get("q=Target+Carlsbad&lat=33.0370&lon=-117.2919")).json();
  assert.deepEqual(results[0].coordinates, [-117.25, 33.10]);
});

test("a business query without a city still prefers the device location", async () => {
  const { get } = geocoderFixture(() => targets);
  const { results } = await (await get("q=Target&lat=33.0370&lon=-117.2919")).json();
  assert.deepEqual(results[0].coordinates, [-117.2651064, 33.0625709]);
  assert.equal(results.length, 3, "duplicate POI results should still be deduplicated");
});

test("missing or partial location uses the default fallback city", async () => {
  for (const params of ["q=Target", "q=Target&lat=33.0370", "q=Target&lon=-117.2919"]) {
    const { get, requests } = geocoderFixture((url) =>
      url.searchParams.has("bounded") ? [] : targets,
    );
    const response = await get(params);
    assert.equal(response.status, 200);
    assert.equal(requests.at(-1).searchParams.get("q"), "Target carlsbad California");
  }
});

test("coordinates without a query still reverse geocode", async () => {
  const { get, requests } = geocoderFixture(() => ({ display_name: "Carlsbad Village" }));
  const response = await get("lat=33.1581&lon=-117.3506");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: "Carlsbad Village",
    coordinates: [-117.3506, 33.1581],
  });
  assert.equal(requests[0].pathname, "/reverse");
});
