import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NominatimResult = {
  display_name: string;
  lat: string;
  lon: string;
};

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();

  if (!query) {
    return NextResponse.json({ error: "Enter an address." }, { status: 400 });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query + ", California");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("viewbox", "-117.40,33.30,-117.23,32.98");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("addressdetails", "1");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "CanWeDrive/0.3 (LSV routing research tool)",
        "Accept-Language": "en-US,en;q=0.8",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Address search is temporarily unavailable." }, { status: 502 });
    }

    const results = (await response.json()) as NominatimResult[];

    return NextResponse.json({
      results: results.map((result) => ({
        name: result.display_name,
        coordinates: [Number(result.lon), Number(result.lat)] as [number, number],
      })),
    });
  } catch {
    return NextResponse.json({ error: "Address search is temporarily unavailable." }, { status: 502 });
  }
}
