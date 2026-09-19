type Coordinate = [number, number];

export type TerrainStats = {
  elevationGainFeet: number;
  elevationLossFeet: number;
  maxUphillGradePercent: number;
  maxDownhillGradePercent: number;
  source: "Open-Meteo / Copernicus DEM";
};

const MAX_POINTS_PER_REQUEST = 100;
const SAMPLE_SPACING_METERS = 90;
const NOISE_THRESHOLD_METERS = 2;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function haversineMeters(start: Coordinate, end: Coordinate) {
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(end[1] - start[1]);
  const dLon = toRadians(end[0] - start[0]);
  const lat1 = toRadians(start[1]);
  const lat2 = toRadians(end[1]);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sampleRoute(coordinates: Coordinate[]) {
  if (coordinates.length <= MAX_POINTS_PER_REQUEST) return coordinates;

  const samples: Coordinate[] = [coordinates[0]];
  let distanceSinceSample = 0;

  for (let i = 1; i < coordinates.length - 1; i += 1) {
    const distance = haversineMeters(coordinates[i - 1], coordinates[i]);
    distanceSinceSample += distance;

    if (distanceSinceSample >= SAMPLE_SPACING_METERS) {
      samples.push(coordinates[i]);
      distanceSinceSample = 0;
    }
  }

  samples.push(coordinates[coordinates.length - 1]);

  if (samples.length <= MAX_POINTS_PER_REQUEST) return samples;

  const stride = Math.ceil((samples.length - 1) / (MAX_POINTS_PER_REQUEST - 1));
  const reduced = samples.filter(
    (_, index) => index === 0 || index === samples.length - 1 || index % stride === 0,
  );

  return reduced.slice(0, MAX_POINTS_PER_REQUEST);
}

async function fetchElevations(coordinates: Coordinate[]) {
  const chunks: Coordinate[][] = [];

  for (let i = 0; i < coordinates.length; i += MAX_POINTS_PER_REQUEST) {
    chunks.push(coordinates.slice(i, i + MAX_POINTS_PER_REQUEST));
  }

  const elevations: number[] = [];

  for (const chunk of chunks) {
    const latitude = chunk.map(([, lat]) => lat.toFixed(6)).join(",");
    const longitude = chunk.map(([lon]) => lon.toFixed(6)).join(",");
    const url =
      `https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        "User-Agent": "CanWeDrive/0.3 (LSV routing research tool)",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Elevation service returned ${response.status}`);
    }

    const payload = (await response.json()) as { elevation?: number[] };

    if (!Array.isArray(payload.elevation) || payload.elevation.length !== chunk.length) {
      throw new Error("Elevation service returned incomplete terrain data.");
    }

    elevations.push(...payload.elevation);
  }

  return elevations;
}

export async function getRouteTerrain(
  coordinates: Coordinate[],
): Promise<TerrainStats | null> {
  if (coordinates.length < 2) return null;

  try {
    const samples = sampleRoute(coordinates);
    const elevations = await fetchElevations(samples);

    let elevationGainMeters = 0;
    let elevationLossMeters = 0;
    let maxUphillGrade = 0;
    let maxDownhillGrade = 0;

    for (let i = 1; i < samples.length; i += 1) {
      const horizontalMeters = haversineMeters(samples[i - 1], samples[i]);
      if (horizontalMeters < 1) continue;

      const elevationDelta = elevations[i] - elevations[i - 1];
      const gradePercent = (elevationDelta / horizontalMeters) * 100;

      if (elevationDelta >= NOISE_THRESHOLD_METERS) {
        elevationGainMeters += elevationDelta;
      } else if (elevationDelta <= -NOISE_THRESHOLD_METERS) {
        elevationLossMeters += Math.abs(elevationDelta);
      }

      if (gradePercent > maxUphillGrade) maxUphillGrade = gradePercent;
      if (gradePercent < maxDownhillGrade) maxDownhillGrade = gradePercent;
    }

    return {
      elevationGainFeet: Math.round(elevationGainMeters * 3.28084),
      elevationLossFeet: Math.round(elevationLossMeters * 3.28084),
      maxUphillGradePercent: Math.round(maxUphillGrade * 10) / 10,
      maxDownhillGradePercent: Math.round(Math.abs(maxDownhillGrade) * 10) / 10,
      source: "Open-Meteo / Copernicus DEM",
    };
  } catch (error) {
    console.warn("CanWeDrive terrain lookup failed", error);
    return null;
  }
}
