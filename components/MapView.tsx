"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { createMapCamera, routeCoordinates, type Coordinate } from "../lib/map-camera";

type RouteData = {
  geometry: { type: "LineString"; coordinates: Coordinate[] };
  segments: Array<{ coordinates: Coordinate[]; status: "eligible" | "blocked" | "unknown" }>;
};

type MapViewProps = {
  route: RouteData | null;
  selectedFrom: Coordinate | null;
  selectedTo: Coordinate | null;
  selectedStop: Coordinate | null;
  userLocation: Coordinate | null;
  pickMode: "from" | "to" | "stop";
  onMapPick: (coordinates: Coordinate) => void;
};

const ROUTE_COLORS = { eligible: "#ff3b30", unknown: "#00a6ff", blocked: "#111111" };
const animationDuration = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700;

function fitCoordinates(map: maplibregl.Map, coordinates: Coordinate[], duration = animationDuration()) {
  const bounds = new maplibregl.LngLatBounds();
  coordinates.forEach((coordinate) => bounds.extend(coordinate));
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding: { top: 110, bottom: 75, left: 45, right: 65 },
      maxZoom: 15.8,
      bearing: 0,
      pitch: 0,
      duration,
    });
  }
}

export default function MapView({ route, selectedFrom, selectedTo, selectedStop, userLocation, pickMode, onMapPick }: MapViewProps) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onMapPickRef = useRef(onMapPick);
  const snapshotRef = useRef({ route, from: selectedFrom, to: selectedTo, stop: selectedStop, user: userLocation });
  const syncMapRef = useRef<(() => void) | null>(null);

  useEffect(() => { onMapPickRef.current = onMapPick; }, [onMapPick]);

  useEffect(() => {
    snapshotRef.current = { route, from: selectedFrom, to: selectedTo, stop: selectedStop, user: userLocation };
    syncMapRef.current?.();
  }, [route, selectedFrom, selectedTo, selectedStop, userLocation]);

  useEffect(() => {
    if (!mapNode.current) return;
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-117.318, 33.097],
      zoom: 12.2,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    map.getCanvas().style.cursor = "crosshair";
    map.on("click", (event) => onMapPickRef.current([event.lngLat.lng, event.lngLat.lat]));

    let ready = false;
    let locationMarker: maplibregl.Marker | null = null;
    const nextCamera = createMapCamera();
    const syncMap = () => {
      if (!ready) return;
      const snapshot = snapshotRef.current;
      updateRouteLayers(map, snapshot.route, snapshot.from, snapshot.to, snapshot.stop);
      if (snapshot.user) {
        if (!locationMarker) {
          const element = document.createElement("div");
          element.className = "user-location-marker";
          element.setAttribute("role", "img");
          element.setAttribute("aria-label", "Your current location");
          element.title = "Your current location";
          const label = document.createElement("span");
          label.textContent = "YOU ARE HERE";
          element.append(label);
          // DOM markers sit above map layers, including the starting-point dot.
          locationMarker = new maplibregl.Marker({ element }).setLngLat(snapshot.user).addTo(map);
        } else locationMarker.setLngLat(snapshot.user);
      } else {
        locationMarker?.remove();
        locationMarker = null;
      }
      const action = nextCamera(snapshot);
      if (action?.type === "route") fitCoordinates(map, action.coordinates);
      if (action?.type === "focus") map.flyTo({ center: action.center, zoom: action.zoom, duration: animationDuration() });
    };
    syncMapRef.current = syncMap;

    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("route-points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#111111", "line-width": 11, "line-opacity": 0.55 } });
      map.addLayer({ id: "route-eligible", type: "line", source: "route", filter: ["==", ["get", "status"], "eligible"], paint: { "line-color": ROUTE_COLORS.eligible, "line-width": 6.5, "line-opacity": 0.98 } });
      map.addLayer({ id: "route-unknown", type: "line", source: "route", filter: ["==", ["get", "status"], "unknown"], paint: { "line-color": ROUTE_COLORS.unknown, "line-width": 6, "line-opacity": 0.98, "line-dasharray": [1.5, 1] } });
      map.addLayer({ id: "route-blocked", type: "line", source: "route", filter: ["==", ["get", "status"], "blocked"], paint: { "line-color": ROUTE_COLORS.blocked, "line-width": 7, "line-opacity": 0.98 } });
      map.addLayer({ id: "route-start-end", type: "circle", source: "route-points", paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-stroke-color": "#111111", "circle-stroke-width": 3 } });
      map.addLayer({ id: "route-start", type: "circle", source: "route-points", filter: ["==", ["get", "role"], "from"], paint: { "circle-radius": 5, "circle-color": "#111111" } });
      map.addLayer({ id: "route-end", type: "circle", source: "route-points", filter: ["==", ["get", "role"], "to"], paint: { "circle-radius": 5, "circle-color": "#f5e642" } });
      map.addLayer({ id: "route-stop", type: "circle", source: "route-points", filter: ["==", ["get", "role"], "stop"], paint: { "circle-radius": 5, "circle-color": "#ffffff" } });
      ready = true;
      syncMap();
    });

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
      if (ready && snapshotRef.current.route) fitCoordinates(map, routeCoordinates(snapshotRef.current), 0);
    });
    resizeObserver.observe(mapNode.current);
    return () => {
      resizeObserver.disconnect();
      syncMapRef.current = null;
      mapRef.current = null;
      locationMarker?.remove();
      map.remove();
    };
  }, []);

  function fitRoute() {
    if (mapRef.current && snapshotRef.current.route) fitCoordinates(mapRef.current, routeCoordinates(snapshotRef.current));
  }

  function centerOnUser() {
    if (mapRef.current && userLocation) mapRef.current.flyTo({ center: userLocation, zoom: 15.5, duration: animationDuration() });
  }

  return (
    <>
      <div className="map-tools">
        <button type="button" onClick={centerOnUser} disabled={!userLocation} aria-label="Center map on your location">MY LOCATION</button>
        <button type="button" onClick={fitRoute} disabled={!route} aria-label="Fit route on map">FIT ROUTE</button>
      </div>
      <div ref={mapNode} className="map" aria-label={`Can We Cart route map, picking ${pickMode}`} />
    </>
  );
}

function updateRouteLayers(map: maplibregl.Map, route: RouteData | null, selectedFrom: Coordinate | null, selectedTo: Coordinate | null, selectedStop: Coordinate | null) {
  const routeSource = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  const pointSource = map.getSource("route-points") as maplibregl.GeoJSONSource | undefined;
  if (!routeSource || !pointSource) return;
  routeSource.setData({
    type: "FeatureCollection",
    features: route?.segments.map((segment, index) => ({ type: "Feature", properties: { status: segment.status, index }, geometry: { type: "LineString", coordinates: segment.coordinates } })) ?? [],
  });
  pointSource.setData({
    type: "FeatureCollection",
    features: [
      ...(selectedFrom ? [{ type: "Feature" as const, properties: { role: "from" }, geometry: { type: "Point" as const, coordinates: selectedFrom } }] : []),
      ...(selectedStop ? [{ type: "Feature" as const, properties: { role: "stop" }, geometry: { type: "Point" as const, coordinates: selectedStop } }] : []),
      ...(selectedTo ? [{ type: "Feature" as const, properties: { role: "to" }, geometry: { type: "Point" as const, coordinates: selectedTo } }] : []),
    ],
  });
}
