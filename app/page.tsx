"use client";

import { useEffect, useState } from "react";
import MapView from "../components/MapView";

type Coordinate = [number, number];

type SelectedPoint = { coordinates: Coordinate; name: string };

type Direction = { instruction: string; roadName: string; distanceMiles: number };

type RouteResult = {
  route: {
    status: "eligible" | "blocked" | "unknown";
    distanceMiles: number;
    unknownMiles: number;
    durationMinutes: number | null;
    geometry: { type: "LineString"; coordinates: Coordinate[] };
    segments: Array<{
      coordinates: Coordinate[];
      status: "eligible" | "blocked" | "unknown";
      speedMph: number | null;
      source: string | null;
    }>;
    directions: Direction[];
    terrain: {
      elevationGainFeet: number;
      elevationLossFeet: number;
      maxUphillGradePercent: number;
      maxDownhillGradePercent: number;
      longestClimbMiles: number;
      profile: Array<{ distanceMiles: number; elevationFeet: number }>;
      source: string;
    } | null;
  };
  from: { name: string; coordinates: Coordinate };
  to: { name: string; coordinates: Coordinate };
  stops?: Array<{ name: string; coordinates: Coordinate }>;
};

const STATUS_COPY = {
  eligible: { label: "ROUTE FOUND", title: "Mapped road speeds on this route are at or below 35 MPH.", tone: "eligible" },
  unknown: { label: "SPEED DATA INCOMPLETE", title: "A route was found, but some speed-limit data is missing.", tone: "unknown" },
  blocked: { label: "OVER 35 MPH", title: "This route includes a road mapped above 35 MPH.", tone: "blocked" },
} as const;

export default function Home() {
  const [fromPoint, setFromPoint] = useState<SelectedPoint | null>(null);
  const [toPoint, setToPoint] = useState<SelectedPoint | null>(null);
  const [stopPoint, setStopPoint] = useState<SelectedPoint | null>(null);
  const [stopEnabled, setStopEnabled] = useState(false);
  const [route, setRoute] = useState<RouteResult["route"] | null>(null);
  const [searchedFrom, setSearchedFrom] = useState("");
  const [searchedTo, setSearchedTo] = useState("");
  const [searchedStops, setSearchedStops] = useState<SelectedPoint[]>([]);
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickMode, setPickMode] = useState<"from" | "to" | "stop">("from");
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [stopQuery, setStopQuery] = useState("");
  const [searching, setSearching] = useState<"from" | "to" | "stop" | null>(null);
  const [searchResults, setSearchResults] = useState<{
    type: "from" | "to" | "stop";
    results: Array<{ name: string; subtitle?: string; coordinates: Coordinate }>;
  } | null>(null);

  const activeStop = stopEnabled ? stopPoint : null;

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setLocationMessage("Location is not available in this browser.");
      return;
    }
    setLocating(true);
    setLocationMessage("");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const coordinates: Coordinate = [position.coords.longitude, position.coords.latitude];
        setUserLocation(coordinates);
        try {
          const response = await fetch(`/api/geocode?lat=${coordinates[1]}&lon=${coordinates[0]}`);
          const payload = (await response.json()) as { name?: string };
          const name = payload.name ?? "Your current location";
          setFromPoint({ coordinates, name });
          setFromQuery(name);
        } catch {
          setFromPoint({ coordinates, name: "Your current location" });
          setFromQuery("Your current location");
        } finally {
          setPickMode("to");
          setRoute(null);
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocationMessage("Location access was unavailable. Enter an address instead.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }

  useEffect(() => {
    if (!navigator.permissions?.query) return;
    void navigator.permissions.query({ name: "geolocation" as PermissionName }).then((permission) => {
      if (permission.state === "granted") void useMyLocation();
    }).catch(() => {});
  }, []);

  async function searchAddress(type: "from" | "to" | "stop") {
    const query = (type === "from" ? fromQuery : type === "to" ? toQuery : stopQuery).trim();
    if (!query) return;
    setSearching(type);
    setSearchResults(null);
    setError("");
    try {
      const locationParam = userLocation ? `&lat=${userLocation[1]}&lon=${userLocation[0]}` : "";
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}${locationParam}`);
      const payload = (await response.json()) as {
        results?: Array<{ name: string; subtitle?: string; coordinates: Coordinate }>;
        error?: string;
      };
      if (!response.ok || !payload.results?.length) throw new Error(payload.error ?? "No matching address found.");
      const results = payload.results.slice(0, 4);
      setSearchResults({ type, results });
      if (results.length === 1) selectSearchResult(type, results[0]);
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Address search failed.");
    } finally {
      setSearching(null);
    }
  }

  function selectSearchResult(type: "from" | "to" | "stop", result: { name: string; coordinates: Coordinate }) {
    const point = { coordinates: result.coordinates, name: result.name };
    if (type === "from") {
      setFromPoint(point);
      setFromQuery(point.name);
      setPickMode("to");
    } else if (type === "to") {
      setToPoint(point);
      setToQuery(point.name);
    } else {
      setStopPoint(point);
      setStopQuery(point.name);
    }
    setSearchResults(null);
    setRoute(null);
    setError("");
  }

  function handleMapPick(coordinates: Coordinate) {
    const point = { coordinates, name: `${coordinates[1].toFixed(5)}, ${coordinates[0].toFixed(5)}` };
    if (pickMode === "from") {
      setFromPoint(point);
      setFromQuery(point.name);
      setPickMode("to");
    } else if (pickMode === "to") {
      setToPoint(point);
      setToQuery(point.name);
    } else {
      setStopPoint(point);
      setStopQuery(point.name);
    }
    setRoute(null);
    setError("");
  }

  async function checkRoute() {
    if (!fromPoint || !toPoint) {
      setError("Enter a starting point and destination first.");
      return;
    }
    const stops = activeStop ? [fromPoint, activeStop, toPoint] : [fromPoint, toPoint];
    for (let index = 1; index < stops.length; index += 1) {
      if (stops[index - 1].coordinates.join(",") === stops[index].coordinates.join(",")) {
        setError("Pick different points for each stop.");
        return;
      }
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stops: stops.map((stop) => ({ name: stop.name, coordinates: stop.coordinates })) }),
      });
      const payload = (await response.json()) as RouteResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Route lookup failed.");
      setRoute(payload.route);
      setSearchedFrom(payload.from.name);
      setSearchedTo(payload.to.name);
      setSearchedStops(payload.stops?.slice(1, -1) ?? []);
    } catch (lookupError) {
      setRoute(null);
      setError(lookupError instanceof Error ? lookupError.message : "Route lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  function swapPoints() {
    const nextFrom = toPoint;
    const nextTo = fromPoint;
    setFromPoint(nextFrom);
    setToPoint(nextTo);
    setFromQuery(nextFrom?.name ?? "");
    setToQuery(nextTo?.name ?? "");
    setPickMode("from");
    setRoute(null);
  }

  const status = route ? STATUS_COPY[route.status] : null;
  const mappedSpeedPercent = route && route.distanceMiles > 0
    ? Math.round(((route.distanceMiles - route.unknownMiles) / route.distanceMiles) * 100)
    : 0;

  const speedExposure = route
    ? route.segments.reduce((total, segment) => {
        const miles = segment.coordinates.reduce((sum, coordinate, index, coordinates) => {
          if (index === 0) return sum;
          const [lon1, lat1] = coordinates[index - 1];
          const [lon2, lat2] = coordinate;
          const toRadians = (value: number) => (value * Math.PI) / 180;
          const dLat = toRadians(lat2 - lat1);
          const dLon = toRadians(lon2 - lon1);
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
          return sum + 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }, 0);
        const key = segment.speedMph === null ? "unknown" : segment.speedMph <= 25 ? "under25" : segment.speedMph <= 30 ? "at30" : "at35";
        total[key] += miles;
        return total;
      }, { under25: 0, at30: 0, at35: 0, unknown: 0 })
    : null;

  return (
    <main className="shell">
      <aside className="panel">
        <header className="brand">
          <div className="eyebrow">NORTH COUNTY · CALIFORNIA</div>
          <h1>Can We Cart?</h1>
          <p>LSV routing without the guessing.</p>
        </header>

        <section className="route-box" aria-label="Route planner">
          <div className="route-inputs">
            <div className="route-input">
              <span className="route-letter from-marker">A</span>
              <label>
                <span>FROM</span>
                <div className="address-row">
                  <input
                    value={fromQuery}
                    onChange={(event) => { setFromQuery(event.target.value); setFromPoint(null); setRoute(null); }}
                    onKeyDown={(event) => { if (event.key === "Enter") void searchAddress("from"); }}
                    placeholder="Starting address"
                    aria-label="Starting address"
                  />
                  <button type="button" className="search-button" onClick={() => void searchAddress("from")} disabled={searching !== null}>{searching === "from" ? "…" : "SEARCH"}</button>
                </div>
              </label>
            </div>

            <div className="route-rail" aria-hidden="true" />

            <div className="route-input">
              <span className="route-letter to-marker">B</span>
              <label>
                <span>TO</span>
                <div className="address-row">
                  <input
                    value={toQuery}
                    onChange={(event) => { setToQuery(event.target.value); setToPoint(null); setRoute(null); }}
                    onKeyDown={(event) => { if (event.key === "Enter") void searchAddress("to"); }}
                    placeholder="Destination"
                    aria-label="Destination address"
                  />
                  <button type="button" className="search-button" onClick={() => void searchAddress("to")} disabled={searching !== null}>{searching === "to" ? "…" : "SEARCH"}</button>
                </div>
              </label>
            </div>

            {stopEnabled && (
              <div className="route-input">
                <span className="route-letter stop-marker">C</span>
                <label>
                  <span>STOP</span>
                  <div className="address-row">
                    <input
                      value={stopQuery}
                      onChange={(event) => { setStopQuery(event.target.value); setStopPoint(null); setRoute(null); }}
                      onKeyDown={(event) => { if (event.key === "Enter") void searchAddress("stop"); }}
                      placeholder="Optional stop"
                      aria-label="Optional stop"
                    />
                    <button type="button" className="search-button" onClick={() => void searchAddress("stop")} disabled={searching !== null}>{searching === "stop" ? "…" : "SEARCH"}</button>
                  </div>
                </label>
              </div>
            )}
          </div>

          {searchResults && (
            <div className="search-results" aria-label="Address search results">
              <div className="search-results-label">CHOOSE A MATCH</div>
              {searchResults.results.map((result, index) => (
                <button key={result.name + result.coordinates.join(",")} type="button" className="search-result" onClick={() => selectSearchResult(searchResults.type, result)}>
                  <strong>{index + 1}</strong>
                  <span><b>{result.name}</b>{result.subtitle ? <small>{result.subtitle}</small> : null}</span>
                </button>
              ))}
            </div>
          )}

          <div className="planner-tools">
            <button type="button" className={pickMode === "from" ? "tool-button active" : "tool-button"} onClick={() => setPickMode("from")}>PICK A</button>
            <button type="button" className={pickMode === "to" ? "tool-button active" : "tool-button"} onClick={() => setPickMode("to")}>PICK B</button>
            <button type="button" className="tool-button" onClick={swapPoints} disabled={!fromPoint || !toPoint}>SWAP</button>
            <button type="button" className="tool-button location-tool" onClick={() => void useMyLocation()} disabled={locating}>{locating ? "LOCATING…" : "USE MY LOCATION"}</button>
            {!stopEnabled ? (
              <button type="button" className="secondary-action" onClick={() => { setStopEnabled(true); setPickMode("stop"); setRoute(null); }}>+ ADD STOP</button>
            ) : (
              <button type="button" className="secondary-action" onClick={() => { setStopEnabled(false); setStopPoint(null); setStopQuery(""); setPickMode("to"); setRoute(null); }}>REMOVE STOP</button>
            )}
          </div>

          {locationMessage && <p className="location-message">{locationMessage}</p>}
          <p className="map-help">Search an address or click the map to set A and B. Add a stop only when you need one.</p>

          <button className="drive-button" onClick={checkRoute} disabled={loading}>
            {loading ? "CHECKING ROUTE…" : "CAN WE CART THERE?"}
          </button>
        </section>

        <div className="vehicle-row">
          <div><span>VEHICLE</span><strong>Street-legal LSV</strong></div>
          <strong>≤ 35 MPH</strong>
        </div>

        {error && <div className="error-box">{error}</div>}

        {route && status && (
          <section className={`result ${status.tone}`}>
            <div className="result-header">
              <div>
                <span className="status">{status.label}</span>
                <h2>{status.title}</h2>
              </div>
              <button type="button" className="edit-route" onClick={() => setRoute(null)}>EDIT</button>
            </div>

            {route.status === "unknown" && (
              <div className="verification-warning">
                <strong>{100 - mappedSpeedPercent}% UNKNOWN SPEED DATA</strong>
                <span>{route.unknownMiles.toFixed(1)} miles have no usable posted-speed data.</span>
              </div>
            )}

            <div className="trip-summary">
              <div><strong>{route.durationMinutes === null ? "—" : `${route.durationMinutes} MIN`}</strong><span>EST. TIME</span></div>
              <div><strong>{route.distanceMiles.toFixed(1)} MI</strong><span>DISTANCE</span></div>
              <div><strong>{mappedSpeedPercent}%</strong><span>MAPPED SPEED DATA</span></div>
            </div>

            <div className="directions-section">
              <div className="section-heading">
                <span>TURN-BY-TURN</span>
                <small>{route.directions.length} steps</small>
              </div>
              <ol className="directions-list">
                {route.directions.map((direction, index) => (
                  <li key={`${direction.roadName}-${index}`}>
                    <span className="direction-number">{index + 1}</span>
                    <div><strong>{direction.instruction}</strong><small>{direction.distanceMiles < 0.1 ? "Less than 0.1 mi" : `${direction.distanceMiles.toFixed(1)} mi`}</small></div>
                  </li>
                ))}
                <li className="arrival"><span className="direction-number">✓</span><div><strong>Arrive at your destination</strong><small>{searchedTo}</small></div></li>
              </ol>
            </div>

            <details className="route-details">
              <summary>ROUTE DETAILS <span>Speed, terrain & data quality</span></summary>
              <div className="details-body">
                <div className="detail-grid">
                  <div><span>CLIMB</span><strong>{route.terrain ? `↑ ${route.terrain.elevationGainFeet} FT` : "—"}</strong></div>
                  <div><span>DESCENT</span><strong>{route.terrain ? `↓ ${route.terrain.elevationLossFeet} FT` : "—"}</strong></div>
                  <div><span>STEEPEST</span><strong>{route.terrain ? `${route.terrain.maxUphillGradePercent.toFixed(1)}%` : "—"}</strong></div>
                  <div><span>LONGEST CLIMB</span><strong>{route.terrain ? `${route.terrain.longestClimbMiles.toFixed(1)} MI` : "—"}</strong></div>
                </div>

                {speedExposure && (
                  <div className="speed-summary">
                    <div><span>≤25 MPH</span><strong>{speedExposure.under25.toFixed(1)} mi</strong></div>
                    <div><span>26–30 MPH</span><strong>{speedExposure.at30.toFixed(1)} mi</strong></div>
                    <div><span>31–35 MPH</span><strong>{speedExposure.at35.toFixed(1)} mi</strong></div>
                    <div><span>UNKNOWN</span><strong>{speedExposure.unknown.toFixed(1)} mi</strong></div>
                  </div>
                )}

                <div className="route-endpoints">
                  <div><span>FROM</span><strong>{searchedFrom}</strong></div>
                  {searchedStops.map((stop, index) => <div key={stop.name + index}><span>STOP {String.fromCharCode(67 + index)}</span><strong>{stop.name}</strong></div>)}
                  <div><span>TO</span><strong>{searchedTo}</strong></div>
                </div>

                <p className="data-note">Estimated using mapped speed data. The mapped-data percentage is not a field verification of road signs. Streets without usable speed data are estimated at 25 MPH. Freeways are excluded from LSV route planning. Local signs and restrictions can override map data.</p>
              </div>
            </details>
          </section>
        )}

        <footer><span>Can We Cart v0.3</span><span>OSM + POSTGIS + PGROUTING</span></footer>
      </aside>

      <section className={`map-wrap${route ? " has-route" : ""}${!route && pickMode === "to" ? " pick-to" : ""}${!route && pickMode === "stop" ? " pick-stop" : ""}`}>
        <MapView
          route={route ? { geometry: route.geometry, segments: route.segments, from: { coordinates: fromPoint?.coordinates ?? [0, 0] }, to: { coordinates: toPoint?.coordinates ?? [0, 0] } } : null}
          selectedFrom={fromPoint?.coordinates ?? null}
          selectedTo={toPoint?.coordinates ?? null}
          selectedStop={activeStop?.coordinates ?? null}
          userLocation={userLocation}
          pickMode={pickMode}
          onMapPick={handleMapPick}
        />
        <div className="legend">
          <span><i className="ok" /> ≤35 MPH</span>
          <span><i className="unknown" /> Unknown</span>
          <span><i className="blocked" /> &gt;35 MPH</span>
        </div>
      </section>
    </main>
  );
}
