import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NORTH_COUNTY_VIEWBOX = "-117.40,33.30,-117.23,32.98";
const NORTH_COUNTY_CITIES = [
  "carlsbad",
  "encinitas",
  "oceanside",
  "vista",
  "san marcos",
  "solana beach",
  "del mar",
  "escondido",
];

const NORTH_COUNTY_CITY_POINTS: Array<{ name: string; coordinates: [number, number] }> = [
  { name: "carlsbad", coordinates: [-117.3506, 33.1581] },
  { name: "encinitas", coordinates: [-117.2919, 33.0370] },
  { name: "oceanside", coordinates: [-117.3267, 33.1959] },
  { name: "vista", coordinates: [-117.2425, 33.2000] },
  { name: "san marcos", coordinates: [-117.1661, 33.1434] },
  { name: "solana beach", coordinates: [-117.2713, 32.9912] },
  { name: "del mar", coordinates: [-117.2653, 32.9595] },
  { name: "escondido", coordinates: [-117.0842, 33.1192] },
];

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  category?: string;
  importance?: number;
  osm_id?: number;
  osm_type?: string;
  name?: string;
  namedetails?: Record<string, string>;
  address?: Record<string, string>;
};

type SearchResult = {
  name: string;
  subtitle: string;
  coordinates: [number, number];
  score: number;
  category: string;
};

function haversineMiles(a: [number, number], b: [number, number]) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function clean(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchTerms(query: string) {
  return clean(query).split(/\s+/).filter((term) => term.length > 1);
}

function placeNameFallback(query: string) {
  const normalized = clean(query);

  for (const city of NORTH_COUNTY_CITIES) {
    if (normalized.endsWith(` ${city}`) && normalized !== city) {
      const name = normalized.slice(0, -(city.length + 1)).trim();
      if (name.length >= 2) return { name, city };
    }
  }

  return null;
}

function nearestNorthCountyCity(currentLocation: [number, number] | null) {
  if (!currentLocation) return "carlsbad";

  return NORTH_COUNTY_CITY_POINTS.reduce((closest, city) => {
    const closestDistance = haversineMiles(currentLocation, closest.coordinates);
    const cityDistance = haversineMiles(currentLocation, city.coordinates);
    return cityDistance < closestDistance ? city : closest;
  }).name;
}

function formatResult(result: NominatimResult): SearchResult {
  const address = result.address ?? {};
  const name =
    result.name ||
    result.namedetails?.name ||
    result.display_name.split(",")[0];

  const street = [address.house_number, address.road].filter(Boolean).join(" ");
  const locality =
    address.city ||
    address.town ||
    address.village ||
    address.suburb ||
    address.neighbourhood ||
    "";

  const subtitle = [street, locality, address.state]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(", ");

  return {
    name,
    subtitle: subtitle || result.display_name,
    coordinates: [Number(result.lon), Number(result.lat)],
    score: result.importance ?? 0,
    category: result.category || result.type || "place",
  };
}

function scoreResult(
  query: string,
  result: NominatimResult,
  currentLocation: [number, number] | null,
  preferredCity: string | null = null,
) {
  const q = clean(query);
  const terms = searchTerms(query);
  const candidateName = clean(
    [
      result.name,
      result.namedetails?.name,
      result.namedetails?.brand,
      result.namedetails?.official_name,
      result.display_name.split(",")[0],
    ]
      .filter(Boolean)
      .join(" "),
  );
  const candidateAddress = clean(result.display_name);
  let score = (result.importance ?? 0) * 20;

  if (preferredCity) {
    const city = clean(preferredCity);
    const address = result.address ?? {};
    const resultCity = clean(
      address.city ||
        address.town ||
        address.village ||
        address.suburb ||
        address.neighbourhood ||
        "",
    );

    if (resultCity === city || candidateAddress.includes(city)) score += 90;
    else score -= 35;
  }

  if (candidateName === q) score += 100;
  else if (candidateName.startsWith(q)) score += 60;
  else if (candidateName.includes(q)) score += 35;

  const matchedTerms = terms.filter(
    (term) => candidateName.includes(term) || candidateAddress.includes(term),
  ).length;
  score += matchedTerms * 10;

  if (terms.length && matchedTerms === terms.length) score += 25;
  if (candidateAddress.includes(q)) score += 20;

  const category = result.category ?? "";
  const type = result.type ?? "";
  if (category === "shop" || category === "amenity" || category === "tourism") {
    score += 10;
  }
  if (type === "house" || type === "building" || type === "residential") {
    score += 5;
  }

  const coordinates: [number, number] = [Number(result.lon), Number(result.lat)];
  if (currentLocation) {
    const distance = haversineMiles(currentLocation, coordinates);
    score += Math.max(0, 20 - Math.min(20, distance * 1.25));
  }

  return score;
}

async function searchNominatim(
  query: string,
  currentLocation: [number, number] | null,
  bounded: boolean,
) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "10");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("viewbox", NORTH_COUNTY_VIEWBOX);
  if (bounded) url.searchParams.set("bounded", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("accept-language", "en-US");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Can We Cart/0.5 (LSV routing research tool)",
      "Referer": "https://canwedrive.vercel.app/",
      "Accept-Language": "en-US,en;q=0.8",
    },
    cache: "no-store",
  });

  if (!response.ok) throw new Error("Geocoder unavailable.");
  return (await response.json()) as NominatimResult[];
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim();
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));

  if (
    !query &&
    params.has("lat") &&
    params.has("lon") &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");
    url.searchParams.set("accept-language", "en-US");

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Can We Cart/0.5 (LSV routing research tool)",
          "Referer": "https://canwedrive.vercel.app/",
          "Accept-Language": "en-US,en;q=0.8",
        },
        cache: "no-store",
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: "Location lookup is temporarily unavailable." },
          { status: 502 },
        );
      }

      const result = (await response.json()) as NominatimResult;
      return NextResponse.json({
        name: result.display_name || "Your current location",
        coordinates: [lon, lat] as [number, number],
      });
    } catch {
      return NextResponse.json({
        name: "Your current location",
        coordinates: [lon, lat] as [number, number],
      });
    }
  }

  if (!query) {
    return NextResponse.json(
      { error: "Enter an address or place." },
      { status: 400 },
    );
  }

  const currentLocation =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? ([lon, lat] as [number, number])
      : null;

  try {
    let rawResults = await searchNominatim(query, currentLocation, true);
    if (!rawResults.length) {
      rawResults = await searchNominatim(query, currentLocation, false);
    }

    const placeFallback = placeNameFallback(query);
    if (!rawResults.length && placeFallback) {
      rawResults = await searchNominatim(placeFallback.name, currentLocation, true);
      if (!rawResults.length) {
        rawResults = await searchNominatim(placeFallback.name, currentLocation, false);
      }
    }

    // Business names such as "HomeGoods" are often indexed in OSM only when
    // paired with a locality. If the plain place search misses, retry once
    // using the nearest North County city instead of requiring the user to
    // know the city name.
    if (!rawResults.length && !placeFallback) {
      const fallbackCity = nearestNorthCountyCity(currentLocation);
      rawResults = await searchNominatim(
        `${query} ${fallbackCity} California`,
        currentLocation,
        true,
      );
      if (!rawResults.length) {
        rawResults = await searchNominatim(
          `${query} ${fallbackCity} California`,
          currentLocation,
          false,
        );
      }
    }

    const preferredCity = placeFallback?.city ?? null;
    const deduped = new Map<string, SearchResult>();
    for (const result of rawResults) {
      const formatted = formatResult(result);
      if (!formatted.coordinates.every(Number.isFinite)) continue;

      const key = [
        result.osm_type ?? "",
        result.osm_id ?? "",
        formatted.coordinates.join(","),
      ].join(":");

      const scored = {
        ...formatted,
        score: scoreResult(query, result, currentLocation, preferredCity),
      };

      const existing = deduped.get(key);
      if (!existing || scored.score > existing.score) {
        deduped.set(key, scored);
      }
    }

    const results = [...deduped.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ name, subtitle, coordinates, category }) => ({
        name,
        subtitle,
        coordinates,
        category,
      }));

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      { error: "Address search is temporarily unavailable." },
      { status: 502 },
    );
  }
}
