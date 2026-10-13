import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(relativePath, globals = {}) {
  const url = new URL(relativePath, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  runInNewContext(outputText, { exports, ...globals }, { filename: url.pathname });
  return exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const { createMapCamera, routeCoordinates } = load("../lib/map-camera.ts");
const { getCurrentLocation } = load("../lib/current-location.ts");
const user = [-117.3, 33.1];
const destination = [-117.4, 33.2];
const route = { geometry: { coordinates: [user, [-117.5, 33.3], destination] } };
const empty = { route: null, from: null, to: null, stop: null, user: null };

test("initial location centers once, including when location arrives before map load", () => {
  const camera = createMapCamera();
  const snapshot = { ...empty, user };
  assert.deepEqual(plain(camera(snapshot)), { type: "focus", center: user, zoom: 15.5 });
  assert.equal(camera({ ...snapshot, user: [...user] }), null);
});

test("a route already available at map load takes priority over all points and GPS", () => {
  const camera = createMapCamera();
  const snapshot = { ...empty, route, from: user, to: destination, user };
  assert.equal(camera(snapshot).type, "route");
  assert.equal(camera(snapshot), null);
});

test("finding a route fits the entire geometry, endpoints, and optional stop", () => {
  const camera = createMapCamera();
  camera({ ...empty, user, from: user });
  camera({ ...empty, user, from: user, to: destination });
  const stop = [-117.6, 33.4];
  const action = camera({ ...empty, user, route, from: user, to: destination, stop });
  assert.equal(action.type, "route");
  assert.deepEqual(plain(action.coordinates), [...route.geometry.coordinates, user, destination, stop]);
  assert.deepEqual(plain(routeCoordinates({ ...empty, route })), route.geometry.coordinates);
});

test("late GPS and new point objects cannot steal the camera from an existing route", () => {
  const camera = createMapCamera();
  camera({ ...empty, route, from: user, to: destination });
  assert.equal(camera({ ...empty, route, user, from: [...user], to: [...destination] }), null);
});

test("a newly calculated route is fitted and editing resumes point focus", () => {
  const camera = createMapCamera();
  camera({ ...empty, route });
  assert.equal(camera({ ...empty, route: { ...route } }).type, "route");
  assert.deepEqual(plain(camera({ ...empty, to: destination })), { type: "focus", center: destination, zoom: 15.5 });
});

test("late GPS does not interrupt a manually selected destination", () => {
  const camera = createMapCamera();
  camera({ ...empty, to: destination });
  assert.equal(camera({ ...empty, to: destination, user }), null);
});

test("location works without a Permissions API and uses longitude/latitude order", async () => {
  let options;
  const result = await getCurrentLocation({ getCurrentPosition(success, _failure, config) {
    options = config;
    success({ coords: { longitude: user[0], latitude: user[1] } });
  } });
  assert.deepEqual(plain(result), user);
  assert.equal(options.timeout, 10000);
  assert.equal(options.enableHighAccuracy, true);
});

test("denied, timed-out, and unsupported location have actionable fallbacks", async () => {
  await assert.rejects(getCurrentLocation(undefined), /not available.*Enter an address/);
  for (const code of [1, 2, 3]) {
    await assert.rejects(getCurrentLocation({ getCurrentPosition(_success, failure) { failure({ code }); } }),
      code === 1 ? /permission is off/ : /Try USE MY LOCATION again/);
  }
});

// Render the real page with minimal hook fixtures: no browser/GPS/network needed.
function pageFixture(initialRoute = null) {
  const slots = [];
  slots[4] = initialRoute;
  let cursor = 0;
  let effects = [];
  let gps;
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback(fn) { const index = cursor++; return slots[index] ??= fn; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) effects.push(fn);
      slots[index] = deps;
    },
  };
  const jsx = (type, props) => ({ type, props });
  const { default: Page } = load("../app/page.tsx", {
    require: (name) => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../components/MapView") return { default: "MapView" };
      if (name === "../lib/current-location") return { getCurrentLocation };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    navigator: { geolocation: { getCurrentPosition(success, failure) { gps = { success, failure }; } } },
    window: { matchMedia: () => ({ matches: false }) },
  });
  return {
    render() {
      cursor = 0;
      effects = [];
      const tree = Page();
      effects.forEach((effect) => effect());
      return tree;
    },
    async locate() {
      gps.success({ coords: { longitude: user[0], latitude: user[1] } });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

test("page automatically locates and immediately uses the position as the starting point", async () => {
  const page = pageFixture();
  page.render();
  await page.locate();
  const tree = page.render();
  const map = find(tree, (node) => node.type === "MapView");
  assert.deepEqual(plain(map.props.userLocation), user);
  assert.deepEqual(plain(map.props.selectedFrom), user);
  assert.equal(find(tree, (node) => node.props?.["aria-label"] === "Starting address").props.value, "Your current location");
});

test("page retains a typed origin when GPS finishes late while still showing the user marker", async () => {
  const page = pageFixture();
  const tree = page.render();
  find(tree, (node) => node.props?.["aria-label"] === "Starting address").props.onChange({ target: { value: "My chosen address" } });
  await page.locate();
  const updated = page.render();
  const map = find(updated, (node) => node.type === "MapView");
  assert.deepEqual(plain(map.props.userLocation), user);
  assert.equal(map.props.selectedFrom, null);
  assert.equal(find(updated, (node) => node.props?.["aria-label"] === "Starting address").props.value, "My chosen address");
});

test("residential assumptions have their own warning, exposure category, and legend", () => {
  const result = {
    status: "assumed", distanceMiles: 1, assumedMiles: 1, unknownMiles: 0,
    mappedSpeedPercent: 0, unknownSpeedPercent: 0, durationMinutes: 3, terrain: null,
    directions: [], geometry: route.geometry,
    segments: [{ coordinates: route.geometry.coordinates, status: "assumed", speedMph: null }],
  };
  const tree = pageFixture(result).render();
  const content = (node) => typeof node !== "object" || !node ? String(node ?? "") : [node.props?.children].flat(Infinity).map(content).join(" ");
  const warning = find(tree, (node) => node.props?.className === "verification-warning residential-warning");
  assert.match(content(warning), /RESIDENTIAL · ASSUMED 25 MPH/);
  assert.match(content(warning), /not a verified posted limit/);
  assert.match(content(tree), /RESIDENTIAL SPEED ASSUMED/);
  assert.doesNotMatch(content(tree), /% UNKNOWN SPEED DATA/);
  const legend = find(tree, (node) => node.props?.className === "legend");
  assert.match(content(legend), /Mapped ≤35.*Assumed 25.*Unknown/);
  const mixed = pageFixture({ ...result, status: "unknown", unknownMiles: 0.3, unknownSpeedPercent: 30 }).render();
  assert.match(content(mixed), /30 % UNKNOWN SPEED DATA/);
  assert.match(content(mixed), /RESIDENTIAL · ASSUMED 25 MPH/);
});
