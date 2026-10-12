export type Coordinate = [number, number];

export type CameraRoute = { geometry: { coordinates: Coordinate[] } };
export type MapSnapshot = {
  route: CameraRoute | null;
  from: Coordinate | null;
  to: Coordinate | null;
  stop: Coordinate | null;
  user: Coordinate | null;
};
type CameraAction = { type: "route"; coordinates: Coordinate[] } | { type: "focus"; center: Coordinate; zoom: number };

export function routeCoordinates(snapshot: MapSnapshot): Coordinate[] {
  return [
    ...(snapshot.route?.geometry.coordinates ?? []),
    ...[snapshot.from, snapshot.to, snapshot.stop].filter((point): point is Coordinate => point !== null),
  ];
}

// Call only when the map is ready, so an early result cannot lose its camera update.
export function createMapCamera() {
  let previous: MapSnapshot = { route: null, from: null, to: null, stop: null, user: null };
  let located = false;
  return (current: MapSnapshot): CameraAction | null => {
    const last = previous;
    previous = current;
    const firstLocation = Boolean(current.user && !located);
    if (current.user) located = true;

    // A route always wins over GPS or point updates arriving in the same render.
    if (current.route) {
      return current.route !== last.route ? { type: "route", coordinates: routeCoordinates(current) } : null;
    }
    const changed = (["from", "to", "stop"] as const).find((key) =>
      current[key] && current[key]?.join(",") !== last[key]?.join(","),
    );
    if (changed) return { type: "focus", center: current[changed]!, zoom: 15.5 };
    if (firstLocation && !current.from && !current.to && !current.stop) {
      return { type: "focus", center: current.user!, zoom: 15.5 };
    }
    return null;
  };
}
