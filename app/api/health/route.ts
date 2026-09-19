import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = "https://bsnspyjsirfayypcvpmc.supabase.co";
const SUPABASE_KEY = "sb_publishable_8GiFIyTV438cg8WbL_qV4Q_uj8COv_O";

export async function GET() {
  const startedAt = Date.now();

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/road_edges?select=id&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(`Supabase returned HTTP ${response.status}`);
    }

    const rows = (await response.json()) as Array<{ id: number }>;

    return NextResponse.json({
      ok: rows.length > 0,
      service: "CanWeDrive",
      supabase: "connected",
      roadNetwork: rows.length > 0 ? "loaded" : "empty",
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("CanWeDrive health check failed", error);

    return NextResponse.json(
      {
        ok: false,
        service: "CanWeDrive",
        supabase: "unavailable",
        version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
        latencyMs: Date.now() - startedAt,
      },
      { status: 503 },
    );
  }
}
