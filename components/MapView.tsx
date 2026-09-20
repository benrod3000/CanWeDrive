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
  selectedStop: Coordinate | null;
  userLocation: Coordinate | null;
  pickMode: "from" | "to" | "stop";
  onMapPick: (coordinates: Coordinate) => void;
};

const ROUTE_COLORS = {
  eligible: "#ff3b30",
  unknown: "#00a6ff",
  blocked: "#111111",
};

export default function MapView({
  route,
  selectedFrom,
  selectedTo,
  selectedStop,
  userLocation,
  pickMode,
  onMapPick,
}: MapViewProps) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onMapPickRef = useRef(onMapPick);
  const routeRef = useRef(route);
  const selectedFromRef = useRef(selectedFrom);
  const selectedToRef = useRef(selectedTo);
  const selectedStopRef = useRef(selectedStop);
  const userLocationRef = useRef(userLocation);

  useEffect(() => {
    onMapPickRef.current = onMapPick;
  }, [onMapPick]);

  useEffect(() => {
    routeRef.current = route;
    selectedFromRef.current = selectedFrom;
    selectedToRef.current = selectedTo;
    selectedStopRef.current = selectedStop;
    userLocationRef.current = userLocation;

    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    updateRouteLayers(
      map,
      route,
      selectedFrom,
      selectedTo,
      selectedStop,
      userLocation,
    );
  }, [route, selectedFrom, selectedTo, selectedStop, userLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route || !map.isStyleLoaded()) return;

    const bounds = new maplibregl.LngLatBounds();
    route.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate));
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 55,
        maxZoom: 16.5,
        duration: 700,
      });
    }
  }, [route]);

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

      map.addSource("user-location", {
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
        id: "route-casing",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#111111",
          "line-width": 11,
          "line-opacity": 0.55,
        },
      });

      map.addLayer({
        id: "route-eligible",
        type: "line",
        source: "route",
        filter: ["==", ["get", "status"], "eligible"],
        paint: {
          "line-color": ROUTE_COLORS.eligible,
          "line-width": 6.5,
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
        id: "user-location",
        type: "circle",
        source: "user-location",
        paint: {
          "circle-radius": 7,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#007aff",
          "circle-stroke-width": 3,
        },
      });

      map.addLayer({
        id: "route-start-end",
        type: "circle",
        source: "route-points",
        paint: {
          "circle-radius": 9,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#111111",
          "circle-stroke-width": 3,
        },
      });

      map.addLayer({
        id: "route-start",
        type: "circle",
        source: "route-points",
        filter: ["==", ["get", "role"], "from"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#111111",
        },
      });

      map.addLayer({
        id: "route-end",
        type: "circle",
        source: "route-points",
        filter: ["==", ["get", "role"], "to"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#f5e642",
        },
      });

      map.addLayer({
        id: "route-stop",
        type: "circle",
        source: "route-points",
        filter: ["==", ["get", "role"], "stop"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
        },
      });

      updateRouteLayers(
        map,
        routeRef.current,
        selectedFromRef.current,
        selectedToRef.current,
        selectedStopRef.current,
        userLocationRef.current,
      );
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  function fitRoute() {
    const map = mapRef.current;
    if (!map || !routeRef.current) return;
    const bounds = new maplibregl.LngLatBounds();
    routeRef.current.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate));
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 55, maxZoom: 16.5, duration: 700 });
  }

  const previousSelectionsRef = useRef<{
    from: string | null;
    to: string | null;
    stop: string | null;
  }>({ from: null, to: null, stop: null });

  useEffect(() => {
    const previous = previousSelectionsRef.current;
    const current = {
      from: selectedFrom ? selectedFrom.join(",") : null,
      to: selectedTo ? selectedTo.join(",") : null,
      stop: selectedStop ? selectedStop.join(",") : null,
    };

    const changedTarget =
      current.from !== previous.from
        ? selectedFrom
        : current.to !== previous.to
          ? selectedTo
          : current.stop !== previous.stop
            ? selectedStop
            : null;

    previousSelectionsRef.current = current;

    const map = mapRef.current;
    if (!map || !changedTarget) return;

    const focus = () => {
      map.flyTo({
        center: changedTarget,
        zoom: Math.max(map.getZoom(), 14.5),
        duration: 700,
        essential: true,
      });
    };

    if (map.isStyleLoaded()) {
      focus();
    } else {
      map.once("load", focus);
    }
  }, [selectedFrom, selectedTo, selectedStop]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = "crosshair";
  }, [pickMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = "crosshair";
  }, [pickMode]);

  return (
    <>
      <div className="map-tools">
        <button type="button" onClick={fitRoute} disabled={!route} aria-label="Fit route on map">
          FIT ROUTE
        </button>
      </div>
      <div ref={mapNode} className="map" aria-label="Can We Cart route map" />
    </>
  );
}

function updateRouteLayers(
  map: maplibregl.Map,
  route: RouteData | null,
  selectedFrom: Coordinate | null,
  selectedTo: Coordinate | null,
  selectedStop: Coordinate | null,
  userLocation: Coordinate | null,
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
      ...(selectedStop
        ? [{
            type: "Feature" as const,
            properties: { role: "stop" },
            geometry: { type: "Point" as const, coordinates: selectedStop },
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

  const locationSource = map.getSource("user-location") as maplibregl.GeoJSONSource | undefined;
  if (locationSource) {
    locationSource.setData({
      type: "FeatureCollection",
      features: userLocation
        ? [{
            type: "Feature" as const,
            properties: { role: "current" },
            geometry: { type: "Point" as const, coordinates: userLocation },
          }]
        : [],
    });
  }

}
