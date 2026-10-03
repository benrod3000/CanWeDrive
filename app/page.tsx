"use client";

import { useEffect, useState } from "react";
import MapView from "../components/MapView";

type Coordinate = [number, number];

type SelectedPoint = { coordinates: Coordinate; name: string };

type RouteResult = {
  route: {
    status: "eligible" | "blocked" | "unknown";
    distanceMiles: number;
    unknownMiles: number;
    durationMinutes: number | null;
    geometry: { type: "LineString"; coordinates: Coordinate[] };
    segments: Array<{ coordinates: Coordinate[]; status: "eligible" | "blocked" | "unknown"; speedMph: number | null; source: "OpenStreetMap" | null }>;
    speedDataAvailable: boolean;
    terrain: { elevationGainFeet: number; elevationLossFeet: number; maxUphillGradePercent: number; maxDownhillGradePercent: number; longestClimbMiles: number; profile: Array<{ distanceMiles: number; elevationFeet: number }>; source: string } | null;
  };
  from: { name: string; coordinates: Coordinate };
  to: { name: string; coordinates: Coordinate };
  stops?: Array<{ name: string; coordinates: Coordinate }>;
};

const STATUS_COPY = {
  eligible: { label: "ROUTE FOUND", title: "We found a route with mapped speeds of 35 MPH or less.", tone: "eligible" },
  unknown: { label: "PARTIALLY VERIFIED", title: "We found a route, but some streets have no usable speed data.", tone: "unknown" },
  blocked: { label: "OVER 35 MPH", title: "This route includes a street mapped above the 35 MPH LSV limit.", tone: "blocked" },
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
  const [searchResults, setSearchResults] = useState<{ type: "from" | "to" | "stop"; results: Array<{ name: string; subtitle?: string; coordinates: Coordinate }> } | null>(null);

  const activeFrom = fromPoint;
  const activeTo = toPoint;
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
          const response = await fetch("/api/geocode?lat=" + encodeURIComponent(String(coordinates[1])) + "&lon=" + encodeURIComponent(String(coordinates[0])));
          const payload = (await response.json()) as { name?: string };
          const point = { coordinates, name: payload.name ?? "Your current location" };
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
    let cancelled = false;
    if (!navigator.geolocation) return;

    if (navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((permission) => {
          if (cancelled || permission.state === "denied") return;
          void useMyLocation();
        })
        .catch(() => {
          if (!cancelled) void useMyLocation();
        });
    } else {
      void useMyLocation();
    }

    return () => {
      cancelled = true;
    };
  }, []);

  async function searchAddress(type: "from" | "to" | "stop") {
    const query = (type === "from" ? fromQuery : type === "to" ? toQuery : stopQuery).trim();
    if (!query) return;
    setSearching(type);
    setError("");
    setSearchResults(null);
    try {
      const locationParam = userLocation ? "&lat=" + encodeURIComponent(String(userLocation[1])) + "&lon=" + encodeURIComponent(String(userLocation[0])) : "";
      const response = await fetch("/api/geocode?q=" + encodeURIComponent(query) + locationParam);
      const payload = (await response.json()) as { results?: Array<{ name: string; subtitle?: string; coordinates: Coordinate }>; error?: string };
      if (!response.ok || !payload.results?.length) throw new Error(payload.error ?? "No matching address found.");
      const results = payload.results ?? [];
      setSearchResults({ type, results: results.slice(0, 4) });
      if (results.length === 1) selectSearchResult(type, results[0]);
      setRoute(null);
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
    const point: SelectedPoint = { coordinates, name: coordinates[1].toFixed(5) + ", " + coordinates[0].toFixed(5) };
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
