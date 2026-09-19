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
      coordinates: Coordinate[];
      status: "eligible" | "blocked" | "unknown";
      speedMph: number | null;
      source: "OpenStreetMap" | null;
    }>;
    speedDataAvailable: boolean;
    terrain: {
      elevationGainFeet: number;
      elevationLossFeet: number;
      maxUphillGradePercent: number;
      maxDownhillGradePercent: number;
      source: string;
    } | null;
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
  const [searchResults, setSearchResults] = useState<{
    type: "from" | "to";
    results: Array<{ name: string; coordinates: Coordinate }>;
  } | null>(null);

  const activeFrom = fromPoint;
  const activeTo = toPoint;

  async function searchAddress(type: "from" | "to") {
    const query = (type === "from" ? fromQuery : toQuery).trim();
    if (!query) return;
    setSearching(type);
    setError("");
    setSearchResults(null);
    try {
      const response = await fetch("/api/geocode?q=" + encodeURIComponent(query));
      const payload = (await response.json()) as {
        results?: Array<{ name: string; coordinates: Coordinate }>;
        error?: string;
      };
      if (!response.ok || !payload.results?.length) {
        throw new Error(payload.error ?? "No matching address found.");
      }
      const results = payload.results ?? [];
      setSearchResults({ type, results: results.slice(0, 4) });
      if (results.length === 1) {
        selectSearchResult(type, results[0]);
      }
      setRoute(null);
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Address search failed.");
    } finally {
      setSearching(null);
    }
  }

  function selectSearchResult(
    type: "from" | "to",
    result: { name: string; coordinates: Coordinate },
  ) {
    const point = { coordinates: result.coordinates, name: result.name };
    if (type === "from") {
      setFromPoint(point);
      setFromQuery(result.name);
      setPickMode("to");
    } else {
      setToPoint(point);
      setToQuery(point.name);
    }
    setSearchResults(null);
    setRoute(null);
    setError("");
  }

  function handleMapPick(coordinates: Coordinate) {
    const point: SelectedPoint = {
      coordinates,
      name: coordinates[1].toFixed(5) + ", " + coordinates[0].toFixed(5),
    };

    if (pickMode === "from") {
      setFromPoint(point);
      setFromQuery(point.name);
      setPickMode("to");
    } else {
      setToPoint(point);
      setToQuery(point.name);
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

  const speedBuckets = route
    ? route.segments.reduce(
        (totals, segment) => {
          const miles = segment.coordinates.reduce((sum, coordinate, index, coordinates) => {
            if (index === 0) return sum;
            const [lon1, lat1] = coordinates[index - 1];
            const [lon2, lat2] = coordinate;
            const toRadians = (value: number) => (value * Math.PI) / 180;
            const dLat = toRadians(lat2 - lat1);
            const dLon = toRadians(lon2 - lon1);
            const a =
              Math.sin(dLat / 2) ** 2 +
              Math.cos(toRadians(lat1)) *
                Math.cos(toRadians(lat2)) *
                Math.sin(dLon / 2) ** 2;
            const miles = 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return sum + miles;
          }, 0);

          if (segment.speedMph === null) totals.unknown += miles;
          else if (segment.speedMph <= 25) totals.under25 += miles;
          else if (segment.speedMph <= 30) totals.at30 += miles;
          else if (segment.speedMph <= 35) totals.at35 += miles;
          return totals;
        },
        { under25: 0, at30: 0, at35: 0, unknown: 0 },
      )
    : null;

  const verifiedPercent = route
    ? Math.round(((route.distanceMiles - route.unknownMiles) / route.distanceMiles) * 100)
    : 0;

  return (
    <main className="shell">
      <aside className="panel">
        <div className="brand">
          <div className="eyebrow">NORTH COUNTY · CALIFORNIA</div>
          <h1>CanWeDrive?</h1>
          <p>LSV routing without the guessing.</p>
        </div>

        <div className="route-box">
          <div className="address-stack">
            <div className="route-step">
              <div className="route-marker from-marker">A</div>
              <label>
                <span>FROM</span>
                <div className="address-row">
                  <input
                    value={fromQuery}
                    onChange={(event) => {
                      setFromQuery(event.target.value);
                      setFromPoint(null);
                      setSearchResults(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchAddress("from");
                    }}
                    placeholder="Enter starting address"
                    aria-label="Starting address"
                  />
                  <button type="button" className="search-button" onClick={() => void searchAddress("from")} disabled={searching !== null}>
                    {searching === "from" ? "..." : "SEARCH"}
                  </button>
                </div>
              </label>
            </div>

            <div className="route-rail" aria-hidden="true" />

            <div className="route-step">
              <div className="route-marker to-marker">B</div>
              <label>
                <span>TO</span>
                <div className="address-row">
                  <input
                    value={toQuery}
                    onChange={(event) => {
                      setToQuery(event.target.value);
                      setToPoint(null);
                      setSearchResults(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchAddress("to");
                    }}
                    placeholder="Enter destination address"
                    aria-label="Destination address"
                  />
                  <button type="button" className="search-button" onClick={() => void searchAddress("to")} disabled={searching !== null}>
                    {searching === "to" ? "..." : "SEARCH"}
                  </button>
                </div>
              </label>
            </div>
          </div>

          {searchResults && (
            <div className="search-results" aria-label="Address search results">
              <div className="search-results-label">CHOOSE A MATCH</div>
              {searchResults.results.map((result, index) => (
                <button
                  key={result.name + result.coordinates.join(",")}
                  type="button"
                  className="search-result"
                  onClick={() => selectSearchResult(searchResults.type, result)}
                >
                  <span>{index + 1}</span>
                  <strong>{result.name}</strong>
                </button>
              ))}
            </div>
          )}

          <div className="route-actions">
            <button
              className={pickMode === "from" ? "pick-button active" : "pick-button"}
              onClick={() => setPickMode("from")}
              type="button"
            >
              PICK A ON MAP
            </button>
            <button
              className={pickMode === "to" ? "pick-button active" : "pick-button"}
              onClick={() => setPickMode("to")}
              type="button"
            >
              PICK B ON MAP
            </button>
            <button
              className="swap-button"
              type="button"
              onClick={() => {
                const nextFrom = toPoint;
                const nextTo = fromPoint;
                setFromPoint(nextFrom);
                setToPoint(nextTo);
                setFromQuery(nextFrom?.name ?? "");
                setToQuery(nextTo?.name ?? "");
                setSearchResults(null);
                setRoute(null);
                setPickMode("from");
              }}
              disabled={!fromPoint && !toPoint}
              aria-label="Swap starting point and destination"
              title="Swap FROM and TO"
            >
              SWAP A ↕ B
            </button>
          </div>

          <p className="map-help">
            Search an address, choose the matching place, or drop A/B directly on the map.
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
                {100 - verifiedPercent}% of this route has no usable posted-speed data in OpenStreetMap. That means we cannot verify those streets from the map data we have.
              </p>
            )}

            <div className="route-section">
              <div className="section-label">TRIP SNAPSHOT</div>
              <div className="trip-stats route-facts">
                <span>
                  <strong>{route.distanceMiles.toFixed(1)} MI</strong>
                  TOTAL ROUTE
                </span>
                <span>
                  <strong>{route.terrain ? `↑ ${route.terrain.elevationGainFeet} FT` : "—"}</strong>
                  CLIMB
                </span>
                <span>
                  <strong>{route.terrain ? `↓ ${route.terrain.elevationLossFeet} FT` : "—"}</strong>
                  DESCENT
                </span>
                <span>
                  <strong>
                    {route.terrain
                      ? `↑ ${route.terrain.maxUphillGradePercent.toFixed(1)}% / ↓ ${route.terrain.maxDownhillGradePercent.toFixed(1)}%`
                      : "—"}
                  </strong>
                  STEEPEST GRADE
                </span>
              </div>
            </div>

            <div className="route-section">
              <div className="section-label">SPEED EXPOSURE</div>
              <div className="speed-bars">
                <div><span>≤25 MPH</span><strong>{speedBuckets?.under25.toFixed(1) ?? "—"} MI</strong></div>
                <div><span>30 MPH</span><strong>{speedBuckets?.at30.toFixed(1) ?? "—"} MI</strong></div>
                <div><span>35 MPH</span><strong>{speedBuckets?.at35.toFixed(1) ?? "—"} MI</strong></div>
                <div><span>UNKNOWN</span><strong>{speedBuckets?.unknown.toFixed(1) ?? "—"} MI</strong></div>
              </div>
              <div className="verification-line">
                <strong>{verifiedPercent}%</strong>
                <span>OF THE ROUTE HAS USABLE SPEED DATA</span>
              </div>
            </div>

            <div className="route-section">
              <div className="section-label">THINGS TO KNOW</div>
              <div className="route-flags">
                {route.terrain && route.terrain.maxUphillGradePercent >= 5 && (
                  <div>
                    <strong>HILLS</strong>
                    <span>Route reaches a {route.terrain.maxUphillGradePercent.toFixed(1)}% uphill grade.</span>
                  </div>
                )}
                {speedBuckets && speedBuckets.at35 > 0 && (
                  <div>
                    <strong>35 MPH ROAD</strong>
                    <span>{speedBuckets.at35.toFixed(1)} miles are mapped at the maximum LSV speed.</span>
                  </div>
                )}
                {route.unknownMiles > 0 && (
                  <div>
                    <strong>UNVERIFIED</strong>
                    <span>{route.unknownMiles.toFixed(1)} miles have no usable posted-speed data.</span>
                  </div>
                )}
                {route.terrain && route.terrain.maxUphillGradePercent < 5 && route.unknownMiles === 0 && (!speedBuckets || speedBuckets.at35 === 0) && (
                  <div>
                    <strong>NO FLAGS</strong>
                    <span>No additional route conditions were identified from the available data.</span>
                  </div>
                )}
              </div>
            </div>

            <p className="terrain-note">
              {route.terrain
                ? "Terrain is estimated from a 90 m elevation model. Hills can increase energy use, especially on longer climbs."
                : "Terrain data was unavailable for this route."}
            </p>

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

      <section className={`map-wrap${route ? " has-route" : ""}${!route && pickMode === "to" ? " pick-to" : ""}`}>
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
