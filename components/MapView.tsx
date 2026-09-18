"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

export default function MapView() {
  const mapNode = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mapNode.current) return;

    const map = new maplibregl.Map({
      container: mapNode.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-117.292, 33.090],
      zoom: 11.2,
      attributionControl: true,
    });

    map.addControl(new maplibregl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      map.addSource("demo-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [-117.350, 33.158],
              [-117.320, 33.145],
              [-117.300, 33.125],
              [-117.290, 33.105],
              [-117.275, 33.085],
            ],
          },
        },
      });

      map.addLayer({
        id: "demo-route-casing",
        type: "line",
        source: "demo-route",
        paint: {
          "line-color": "#111111",
          "line-width": 8,
          "line-opacity": 0.9,
        },
      });

      map.addLayer({
        id: "demo-route",
        type: "line",
        source: "demo-route",
        paint: {
          "line-color": "#f5e642",
          "line-width": 5,
        },
      });
    });

    return () => map.remove();
  }, []);

  return <div ref={mapNode} className="map" aria-label="CanWeDrive map" />;
}
