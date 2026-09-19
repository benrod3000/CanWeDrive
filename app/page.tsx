"use client";

import { useState } from "react";
import MapView from "../components/MapView";
import { PLACES, type PlaceId } from "../lib/locations";

type RouteResult = {
  route: {
    status: "eligible" | "blocked" | "unknown";
    distanceMiles: number;
    durationMinutes: number | null;
    geometry: {
      type: "LineString";
      coordinates: [number, number][];
    };
    segments: Array<{
      coordinates: [[number, number], [number, number]];
      status: "eligible" | "blocked" | "unknown";
    }>;
    speedDataAvailable: boolean;
  };
  from: { name: string; coordinates: [number, number] };
  to: { name: string; coordinates: [number, number] };
};

const STATUS_COPY = {
  eligible: {
    label: "LSV-FRIENDLY DATA",
    title: "No freeways. Mapped route speeds stay at 35 MPH or less.",
    tone: "eligible",
  },
  unknown: {
    label: "NOT FULLY VERIFIED",
    title: "No freeways. Some streets have no usable posted-speed data.",
    tone: "unknown",
  },
  blocked: {
    label: "OVER 35 MPH",
    title: "No freeways, but this route still includes a road mapped above 35 MPH.",
    tone: "blocked",
  },
} as const;

export default function Home() {
  const [from, setFrom] = useState<PlaceId>("carlsbad-village");
  const [to, setTo] = useState<PlaceId>("encinitas");
  const [route, setRoute] = useState<RouteResult["route"] | null>(null);
  const [searchedFrom, setSearchedFrom] = useState("");
  const [searchedTo, setSearchedTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function checkRoute() {
    if (from === to) {
      setError("Pick two different locations.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );

      const payload = (await response.json()) as RouteResult & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Route lookup failed.");
      }

      setRoute(payload.route);
      setSearchedFrom(payload.from.name);
      setSearchedTo(payload.to.name);
    } catch (lookupError) {
      setRoute(null);
      setError(
        lookupError instanceof Error
          ? lookupError.message
          : "Route lookup failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  const status = route ? STATUS_COPY[route.status] : null;

  return (
    <main className="shell">
      <aside className="panel">
        <div className="brand">
          <div className="eyebrow">NORTH COUNTY · CALIFORNIA</div>
          <h1>CanWeDrive?</h1>
          <p>LSV routing without the guessing.</p>
        </div>

        <div className="route-box">
          <label>
            <span>FROM</span>
            <select
              value={from}
              onChange={(event) => setFrom(event.target.value as PlaceId)}
            >
              {PLACES.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>TO</span>
            <select
              value={to}
              onChange={(event) => setTo(event.target.value as PlaceId)}
            >
              {PLACES.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="drive-button"
            onClick={checkRoute}
            disabled={loading}
          >
            {loading ? "CHECKING ROUTE..." : "CAN WE DRIVE THERE?"}
          </button>
        </div>

        <div className="vehicle">
          <div>
            <span className="label">VEHICLE</span>
            <strong>Street-legal LSV</strong>
          </div>
          <div className="speed">≤ 35 MPH</div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {route && status && (
          <section className={`result ${status.tone}`}>
            <div className="status">{status.label}</div>
            <h2>{status.title}</h2>
            <div className="trip-stats">
              <span>
                <strong>{route.distanceMiles} MI</strong>
                ROUTE
              </span>
              <span>
                <strong>NO</strong>
                FREEWAYS
              </span>
              {route.unknownMiles > 0 && (
                <span>
                  <strong>{route.unknownMiles} MI</strong>
                  UNKNOWN
                </span>
              )}
            </div>
            <p>
              {searchedFrom} → {searchedTo}
            </p>
            <div className="notice">
              <strong>IMPORTANT</strong>
              <span>
                Freeways are excluded from route planning. Speed data comes from
                OpenStreetMap tags. Posted signs and local restrictions can
                override the map. This is not a legal determination.
              </span>
            </div>
          </section>
        )}

        <footer>
          <span>CanWeDrive v0.2</span>
          <span>OSM + POSTGIS + PGROUTING</span>
        </footer>
      </aside>

      <section className="map-wrap">
        <MapView
          route={
            route
              ? {
                  geometry: route.geometry,
                  segments: route.segments,
                  from: PLACES.find((place) => place.id === from)!,
                  to: PLACES.find((place) => place.id === to)!,
                }
              : null
          }
        />
        <div className="legend">
          <span><i className="ok" /> ≤ 35 mph</span>
          <span><i className="unknown" /> Unknown</span>
          <span><i className="blocked" /> &gt; 35 mph</span>
        </div>
      </section>
    </main>
  );
}
