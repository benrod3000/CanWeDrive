"use client";

import { useState } from "react";
import MapView from "../components/MapView";

type Coordinate = [number, number];

type SelectedPoint = {
  coordinates: Coordinate;
  name: string;
};

type RouteResult = {
  route: {
    status: "eligible" | "blocked" | "unknown";
    distanceMiles: number;
    unknownMiles: number;
    durationMinutes: number | null;
    geometry: {
      type: "LineString";
      coordinates: Coordinate[];
    };
    segments: Array<{
      coordinates: [Coordinate, Coordinate];
      status: "eligible" | "blocked" | "unknown";
    }>;
    speedDataAvailable: boolean;
  };
  from: { name: string; coordinates: Coordinate };
  to: { name: string; coordinates: Coordinate };
};

const STATUS_COPY = {
  eligible: {
    label: "ROUTE FOUND",
    title: "We found a route with mapped speeds of 35 MPH or less.",
    tone: "eligible",
  },
  unknown: {
    label: "PARTIALLY VERIFIED",
    title: "We found a route, but some streets have no usable speed data.",
    tone: "unknown",
  },
  blocked: {
    label: "OVER 35 MPH",
    title: "This route includes a street mapped above the 35 MPH LSV limit.",
    tone: "blocked",
  },
} as const;

export default function Home() {
  const [fromPoint, setFromPoint] = useState<SelectedPoint | null>(null);
  const [toPoint, setToPoint] = useState<SelectedPoint | null>(null);
  const [route, setRoute] = useState<RouteResult["route"] | null>(null);
  const [searchedFrom, setSearchedFrom] = useState("");
  const [searchedTo, setSearchedTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickMode, setPickMode] = useState<"from" | "to">("from");
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [searching, setSearching] = useState<"from" | "to" | null>(null);

  const activeFrom = fromPoint;
  const activeTo = toPoint;

  async function searchAddress(type: "from" | "to") {
    const query = (type === "from" ? fromQuery : toQuery).trim();
    if (!query) return;
    setSearching(type);
    setError("");
    try {
      const response = await fetch("/api/geocode?q=" + encodeURIComponent(query));
      const payload = (await response.json()) as {
        results?: Array<{ name: string; coordinates: Coordinate }>;
        error?: string;
      };
      if (!response.ok || !payload.results?.length) {
        throw new Error(payload.error ?? "No matching address found.");
      }
      const result = payload.results[0];
      const point = { coordinates: result.coordinates, name: result.name };
      if (type === "from") {
        setFromPoint(point);
        setFromQuery(result.name);
        setPickMode("to");
      } else {
        setToPoint(point);
        setToQuery(result.name);
      }
      setRoute(null);
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Address search failed.");
    } finally {
      setSearching(null);
    }
  }

  function handleMapPick(coordinates: Coordinate) {
    const point: SelectedPoint = {
      coordinates,
      name: coordinates[1].toFixed(5) + ", " + coordinates[0].toFixed(5),
    };

    if (pickMode === "from") {
      setFromPoint(point);
      setPickMode("to");
    } else {
      setToPoint(point);
    }

    setRoute(null);
    setError("");
  }

  async function checkRoute() {
    if (
      activeFrom &&
      activeTo &&
      activeFrom.coordinates[0] === activeTo.coordinates[0] &&
      activeFrom.coordinates[1] === activeTo.coordinates[1]
    ) {
      setError("Pick two different points.");
      return;
    }

    if (!activeFrom || !activeTo) {
      setError("Enter both a starting address and destination first.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        fromLon: String(activeFrom.coordinates[0]),
        fromLat: String(activeFrom.coordinates[1]),
        toLon: String(activeTo.coordinates[0]),
        toLat: String(activeTo.coordinates[1]),
        fromName: activeFrom.name,
        toName: activeTo.name,
      });

      const response = await fetch("/api/route?" + params.toString());
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
            <div className="address-row">
              <input
                value={fromQuery}
                onChange={(event) => {
                  setFromQuery(event.target.value);
                  setFromPoint(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchAddress("from");
                }}
                placeholder="Enter starting address"
              />
              <button type="button" className="search-button" onClick={() => void searchAddress("from")} disabled={searching !== null}>
                {searching === "from" ? "..." : "SEARCH"}
              </button>
            </div>
          </label>

          <label>
            <span>TO</span>
            <div className="address-row">
              <input
                value={toQuery}
                onChange={(event) => {
                  setToQuery(event.target.value);
                  setToPoint(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchAddress("to");
                }}
                placeholder="Enter destination address"
              />
              <button type="button" className="search-button" onClick={() => void searchAddress("to")} disabled={searching !== null}>
                {searching === "to" ? "..." : "SEARCH"}
              </button>
            </div>
          </label>

          <div className="map-pick-controls">
            <button
              className={pickMode === "from" ? "pick-button active" : "pick-button"}
              onClick={() => setPickMode("from")}
              type="button"
            >
              PICK FROM ON MAP
            </button>
            <button
              className={pickMode === "to" ? "pick-button active" : "pick-button"}
              onClick={() => setPickMode("to")}
              type="button"
            >
              PICK TO ON MAP
            </button>
          </div>

          <p className="map-help">
            Enter an address and search, or use the map to drop a pin. Start with FROM, then TO.
          </p>

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
            {route.status === "unknown" && (
              <p className="result-explanation">
                About {route.unknownMiles.toFixed(2)} miles of this route has no usable posted-speed data in OpenStreetMap. We cannot verify those streets from the map data we have. It does not mean the streets are illegal for an LSV.
              </p>
            )}
            <div className={route.unknownMiles > 0 ? "trip-stats has-unknown" : "trip-stats"}>
              <span>
                <strong>{route.distanceMiles.toFixed(1)} MI</strong>
                TOTAL ROUTE
              </span>
              <span>
                <strong>0</strong>
                FREEWAYS
              </span>
              {route.unknownMiles > 0 && (
                <span>
                  <strong>{route.unknownMiles.toFixed(2)} MI</strong>
                  NEEDS VERIFICATION
                </span>
              )}
            </div>
            <div className="result-endpoints">
              <div><span>FROM</span><strong>{searchedFrom}</strong></div>
              <div><span>TO</span><strong>{searchedTo}</strong></div>
            </div>
            <div className="notice">
              <strong>IMPORTANT</strong>
              <span>
                We exclude freeways from LSV route planning. Speed information comes from OpenStreetMap and may be missing or outdated. Local signs and restrictions can override the map data. Use this as a routing research tool, not as a legal determination.
              </span>
            </div>
          </section>
        )}

        <footer>
          <span>CanWeDrive v0.3</span>
          <span>OSM + POSTGIS + PGROUTING</span>
        </footer>
      </aside>

      <section className={route ? "map-wrap has-route" : "map-wrap"}>
        <MapView
          route={
            route
              ? {
                  geometry: route.geometry,
                  segments: route.segments,
                  from: { coordinates: activeFrom?.coordinates ?? [0, 0] },
                  to: { coordinates: activeTo?.coordinates ?? [0, 0] },
                }
              : null
          }
          selectedFrom={activeFrom?.coordinates ?? null}
          selectedTo={activeTo?.coordinates ?? null}
          pickMode={pickMode}
          onMapPick={handleMapPick}
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
