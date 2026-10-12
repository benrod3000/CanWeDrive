import type { Coordinate } from "./map-camera";

export function getCurrentLocation(geolocation: Geolocation | undefined): Promise<Coordinate> {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new Error("Location is not available in this browser. Enter an address instead."));
      return;
    }
    geolocation.getCurrentPosition(
      ({ coords }) => resolve([coords.longitude, coords.latitude]),
      (error) => reject(new Error(error.code === 1
        ? "Location permission is off. Allow location access in your browser, or enter an address instead."
        : "We couldn't find your location. Try USE MY LOCATION again, or enter an address instead.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}
