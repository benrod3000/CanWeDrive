"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

type Coordinate = [number, number];

type RouteData = {
  geometry: {
    type: "LineString";
    coordinates: Coordinate[];
  };
  segments: Array<{
    coordinates: Coordinate[];
    status: "eligible" | "blocked" | "unknown";
  }>;
  from: { coordinates: Coordinate };
  to: { coordinates: Coordinate };
};

type MapViewProps = {
  route: RouteData | null;
  selectedFrom: Coordinate | null;
  selectedTo: Coordinate | null;
  pickMode: "from" | "to";
  onMapPick: (coordinates: Coordinate) => void;
};

const ROUTE_COLORS = {
  eligible: "#f5e642",
  unknown: "#8e8e8e",
  blocked: "#111111",
};

export default function MapView({
  route,
  selectedFrom,
  selectedTo,
  pickMode,
  onMapPick,
}: MapViewProps) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onMapPickRef = useRef(onMapPick);
  const routeRef = useRef(route);
  const selectedFromRef = useRef(selectedFrom);
  const selectedToRef = useRef(selectedTo);

  useEffect(() => {
    onMapPickRef.current = onMapPick;
  }, [onMapPick]);

  useEffect(() => {
    routeRef.current = route;
    selectedFromRef.current = selectedFrom;
    selectedToRef.current = selectedTo;

    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    updateRouteLayers(map, route, selectedFrom, selectedTo);
  }, [route, selectedFrom, selectedTo]);

  useEffect(() => {
    if (!mapNode.current) return;

    const map = new maplibregl.Map({
      container: mapNode.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-117.318, 33.097],
      zoom: 11.2,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("click", (event) => {
      onMapPickRef.current([event.lngLat.lng, event.lngLat.lat]);
    });

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addSource("route-points", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addLayer({
        id: "route-eligible",
        type: "line",
        source: "route",
        filter: ["==", ["get", "status"], "eligible"],
        paint: {
          "line-color": ROUTE_COLORS.eligible,
          "line-width": 6,
          "line-opacity": 0.98,
        },
      });

      map.addLayer({
        id: "route-unknown",
        type: "line",
        source: "route",
        filter: ["==", ["get", "status"], "unknown"],
        paint: {
          "line-color": ROUTE_COLORS.unknown,
          "line-width": 6,
          "line-opacity": 0.98,
          "line-dasharray": [1.5, 1],
        },
      });

      map.addLayer({
        id: "route-blocked",
        type: "line",
        source: "route",
        filter: ["==", ["get", "status"], "blocked"],
        paint: {
          "line-color": ROUTE_COLORS.blocked,
          "line-width": 7,
          "line-opacity": 0.98,
        },
      });

      map.addLayer({
        id: "route-start-end",
        type: "circle",
        source: "route-points",
        paint: {
          "circle-radius": 7,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#111111",
          "circle-stroke-width": 3,
        },
      });

      updateRouteLayers(
        map,
        routeRef.current,
        selectedFromRef.current,
        selectedToRef.current,
      );
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = "crosshair";
  }, [pickMode]);

  return <div ref={mapNode} className="map" aria-label="CanWeDrive route map" />;
}

function updateRouteLayers(
  map: maplibregl.Map,
  route: RouteData | null,
  selectedFrom: Coordinate | null,
  selectedTo: Coordinate | null,
) {
  const routeSource = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  const pointSource = map.getSource("route-points") as maplibregl.GeoJSONSource | undefined;

  if (!routeSource || !pointSource) return;

  routeSource.setData({
    type: "FeatureCollection",
    features:
      route?.segments.map((segment, index) => ({
        type: "Feature",
        properties: {
          status: segment.status,
          index,
        },
        geometry: {
          type: "LineString",
          coordinates: segment.coordinates,
        },
      })) ?? [],
  });

  pointSource.setData({
    type: "FeatureCollection",
    features: [
      ...(selectedFrom
        ? [{
            type: "Feature" as const,
            properties: { role: "from" },
            geometry: { type: "Point" as const, coordinates: selectedFrom },
          }]
        : []),
      ...(selectedTo
        ? [{
            type: "Feature" as const,
            properties: { role: "to" },
            geometry: { type: "Point" as const, coordinates: selectedTo },
          }]
        : []),
    ],
  });

  if (!route) return;

  const bounds = new maplibregl.LngLatBounds();
  for (const coordinate of route.geometry.coordinates) {
    bounds.extend(coordinate);
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding: {
        top: 70,
        right: 70,
        bottom: 70,
        left: 70,
      },
      duration: 700,
      maxZoom: 14.5,
    });
  }
}
