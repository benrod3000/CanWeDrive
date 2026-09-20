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
  const [stopPoint, setStopPoint] = useState<SelectedPoint | null>(null);
  const [route, setRoute] = useState<RouteResult["route"] | null>(null);
  const [searchedFrom, setSearchedFrom] = useState("");
  const [searchedTo, setSearchedTo] = useState("");
  const [searchedStops, setSearchedStops] = useState<SelectedPoint[]>([]);
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickMode, setPickMode] = useState<"from" | "to">("from");
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [stopQuery, setStopQuery] = useState("");
  const [searching, setSearching] = useState<"from" | "to" | "stop" | null>(null);
  const [searchResults, setSearchResults] = useState<{
    type: "from" | "to" | "stop";
    results: Array<{ name: string; subtitle?: string; coordinates: Coordinate }>;
  } | null>(null);

  const activeFrom = fromPoint;
  const activeTo = toPoint;
  const activeStop = stopPoint;

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setLocationMessage("Location is not available in this browser.");
      return;
    }

    setLocating(true);
    setLocationMessage("");

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const coordinates: Coordinate = [
          position.coords.longitude,
          position.coords.latitude,
        ];
        setUserLocation(coordinates);
        try {
          const response = await fetch(
            "/api/geocode?lat=" +
              encodeURIComponent(String(coordinates[1])) +
              "&lon=" +
              encodeURIComponent(String(coordinates[0])),
          );
          const payload = (await response.json()) as { name?: string };
          const point = {
            coordinates,
            name: payload.name ?? "Your current location",
          };
          setFromPoint(point);
          setFromQuery(point.name);
          setPickMode("to");
          setRoute(null);
        } catch {
          setFromPoint({ coordinates, name: "Your current location" });
          setFromQuery("Your current location");
          setPickMode("to");
          setRoute(null);
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocationMessage("Location access was unavailable. You can enter an address instead.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }

  useEffect(() => {
    if (!navigator.permissions?.query) return;
    void navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((permission) => {
        if (permission.state === "granted") void useMyLocation();
      })
      .catch(() => {});
  }, []);

  async function searchAddress(type: "from" | "to" | "stop") {
    const query = (
      type === "from" ? fromQuery : type === "to" ? toQuery : stopQuery
    ).trim();
    if (!query) return;
    setSearching(type);
    setError("");
    setSearchResults(null);
    try {
      const locationParam = userLocation
        ? "&lat=" +
          encodeURIComponent(String(userLocation[1])) +
          "&lon=" +
          encodeURIComponent(String(userLocation[0]))
        : "";
      const response = await fetch(
        "/api/geocode?q=" + encodeURIComponent(query) + locationParam,
      );
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
    const point: SelectedPoint = {
      coordinates,
      name: coordinates[1].toFixed(5) + ", " + coordinates[0].toFixed(5),
    };

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
    if (!activeFrom || !activeTo) {
      setError("Enter a starting point and destination first.");
      return;
    }

    const stops = [activeFrom, activeTo, ...(activeStop ? [activeStop] : [])];
    for (let index = 1; index < stops.length; index += 1) {
      if (
        stops[index - 1].coordinates[0] === stops[index].coordinates[0] &&
        stops[index - 1].coordinates[1] === stops[index].coordinates[1]
      ) {
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
        body: JSON.stringify({
          stops: stops.map((stop) => ({
            name: stop.name,
            coordinates: stop.coordinates,
          })),
        }),
      });
      const payload = (await response.json()) as RouteResult & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Route lookup failed.");
      }

      setRoute(payload.route);
      setSearchedFrom(payload.from.name);
      setSearchedTo(payload.to.name);
      setSearchedStops(payload.stops?.slice(1, -1) ?? []);
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

  const elevationPath = route?.terrain?.profile?.length
    ? (() => {
        const points = route.terrain.profile;
        const minElevation = Math.min(...points.map((point) => point.elevationFeet));
        const maxElevation = Math.max(...points.map((point) => point.elevationFeet));
        const elevationRange = Math.max(1, maxElevation - minElevation);
        const width = 640;
        const height = 150;
        const padX = 4;
        const padY = 12;
        const innerWidth = width - padX * 2;
        const innerHeight = height - padY * 2;
        const maxDistance = Math.max(0.1, points[points.length - 1].distanceMiles);
        const coordinates = points.map((point) => {
          const x = padX + (point.distanceMiles / maxDistance) * innerWidth;
          const y = height - padY - ((point.elevationFeet - minElevation) / elevationRange) * innerHeight;
          return [x, y] as const;
        });
        const line = coordinates.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const area = [
          ...coordinates,
          [coordinates[coordinates.length - 1][0], height - padY] as const,
          [coordinates[0][0], height - padY] as const,
        ]
          .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
          .join(" ");
        return { line, area, minElevation, maxElevation, maxDistance };
      })()
    : null;

  return (
    <main className="shell">
      <aside className="panel">
        <div className="brand">
          <div className="eyebrow">NORTH COUNTY · CALIFORNIA</div>
          <h1>Can We Cart?</h1>
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
                  <button type="button" className="location-button" onClick={() => void useMyLocation()} disabled={locating}>
                    {locating ? "LOCATING..." : "USE MY LOCATION"}
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
                        <div className="route-step">
              <div className="route-marker stop-marker">C</div>
              <label>
                <span>STOP</span>
                <div className="address-row">
                  <input
                    value={stopQuery}
                    onChange={(event) => {
                      setStopQuery(event.target.value);
                      setStopPoint(null);
                      setSearchResults(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchAddress("stop");
                    }}
                    placeholder="Add an optional stop"
                    aria-label="Optional stop"
                  />
                  <button type="button" className="search-button" onClick={() => void searchAddress("stop")} disabled={searching !== null}>
                    {searching === "stop" ? "..." : "SEARCH"}
                  </button>
                </div>
              </label>
            </div>
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
                  <div>
                    <strong>{result.name}</strong>
                    {"subtitle" in result && result.subtitle ? <small>{result.subtitle}</small> : null}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="route-actions">
            <button className={pickMode === "from" ? "pick-button active" : "pick-button"} onClick={() => setPickMode("from")} type="button">PICK A</button>
            <button className={pickMode === "to" ? "pick-button active" : "pick-button"} onClick={() => setPickMode("to")} type="button">PICK B</button>
            <button className={pickMode === "stop" ? "pick-button active" : "pick-button"} onClick={() => setPickMode("stop")} type="button">PICK C</button>
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
            {stopPoint && (
              <button
                className="remove-stop-button"
                type="button"
                onClick={() => {
                  setStopPoint(null);
                  setStopQuery("");
                  setSearchResults(null);
                  setRoute(null);
                  setPickMode("to");
                }}
              >
                REMOVE C
              </button>
            )}
          </div>

          <p className="map-help">
            Search an address, choose a place, or pick A/B/C directly on the map.
          </p>
          {locationMessage && <div className="location-message">{locationMessage}</div>}

          <button
            className="drive-button"
            onClick={checkRoute}
            disabled={loading}
          >
            {loading ? "CHECKING ROUTE..." : "CAN WE CART THERE?"}
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
              <div className="primary-trip-facts">
                <div className="trip-time">
                  <strong>
                    {route.durationMinutes === null
                      ? "—"
                      : route.durationMinutes >= 60
                        ? `${Math.floor(route.durationMinutes / 60)}H ${route.durationMinutes % 60}M`
                        : `${route.durationMinutes} MIN`}
                  </strong>
                  <span>EST. TRIP TIME</span>
                </div>
                <div className="trip-distance">
                  <strong>{route.distanceMiles.toFixed(1)} MI</strong>
                  <span>TOTAL ROUTE</span>
                </div>
              </div>
              <div className="trip-stats route-facts">
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

            {route.terrain && elevationPath && (
              <div className="route-section">
                <div className="section-label">ELEVATION PROFILE</div>
                <div className="elevation-profile">
                  <svg viewBox="0 0 640 150" role="img" aria-label="Route elevation profile">
                    <polygon points={elevationPath.area} />
                    <polyline points={elevationPath.line} />
                  </svg>
                  <div className="elevation-labels">
                    <span>{elevationPath.minElevation} FT</span>
                    <span>{elevationPath.maxDistance.toFixed(1)} MI</span>
                    <span>{elevationPath.maxElevation} FT</span>
                  </div>
                </div>
                <div className="climb-callout">
                  <strong>{route.terrain.longestClimbMiles.toFixed(1)} MI</strong>
                  <span>LONGEST CONTINUOUS CLIMB</span>
                </div>
              </div>
            )}

            <div className="route-section">
              <div className="section-label">SPEED EXPOSURE</div>
              <div className="speed-bars">
                <div><span>≤25 MPH</span><strong>{speedBuckets?.under25.toFixed(1) ?? "—"} MI</strong></div>
                <div><span>26–30 MPH</span><strong>{speedBuckets?.at30.toFixed(1) ?? "—"} MI</strong></div>
                <div><span>31–35 MPH</span><strong>{speedBuckets?.at35.toFixed(1) ?? "—"} MI</strong></div>
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
                    <span>{speedBuckets.at35.toFixed(1)} miles are mapped between 31 and 35 MPH.</span>
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

            <p className="eta-note">
              Estimated using mapped speed limits. Streets without usable speed data are estimated at 25 MPH.
            </p>
            <p className="terrain-note">
              {route.terrain
                ? "Terrain is estimated from a 90 m elevation model. Hills can increase energy use, especially on longer climbs."
                : "Terrain data was unavailable for this route."}
            </p>

            <div className="result-endpoints">
              <div><span>FROM</span><strong>{searchedFrom}</strong></div>
              {searchedStops.map((stop, index) => (
                <div key={stop.name + index}><span>STOP {String.fromCharCode(67 + index - 1)}</span><strong>{stop.name}</strong></div>
              ))}
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
          <span>Can We Cart v0.3</span>
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
          selectedStop={activeStop?.coordinates ?? null}
          userLocation={userLocation}
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
