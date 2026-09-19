import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = "https://bsnspyjsirfayypcvpmc.supabase.co";
const SUPABASE_KEY = "sb_publishable_8GiFIyTV438cg8WbL_qV4Q_uj8COv_O";

export async function GET() {
  const startedAt = Date.now();

  try {
    const supabaseResponse = await fetch(
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

    if (!supabaseResponse.ok) {
      throw new Error(`Supabase returned HTTP ${supabaseResponse.status}`);
    }

    const rows = (await supabaseResponse.json()) as Array<{ id: number }>;

    const healthResponse = NextResponse.json({
      ok: rows.length > 0,
      service: "Can We Cart",
      supabase: "connected",
      roadNetwork: rows.length > 0 ? "loaded" : "empty",
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
      latencyMs: Date.now() - startedAt,
    });
    healthResponse.headers.set(
      "x-can-we-cart-version",
      process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    );
    return healthResponse;
  } catch (error) {
    console.error("Can We Cart health check failed", error);

    return NextResponse.json(
      {
        ok: false,
        service: "Can We Cart",
        supabase: "unavailable",
        version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
        latencyMs: Date.now() - startedAt,
      },
      { status: 503 },
    );
  }
}
