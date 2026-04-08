import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STORE_API = "https://openclawhardware.dev/api/store/apps";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = new URLSearchParams();

  const limit = url.searchParams.get("limit") || "50";
  params.set("limit", limit);

  const category = url.searchParams.get("category");
  if (category) params.set("category", category);

  const q = url.searchParams.get("q");
  if (q) params.set("q", q);

  try {
    const res = await fetch(`${STORE_API}?${params}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Store API error" }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (err) {
    console.error("[apps/store] proxy failed:", err);
    return NextResponse.json({ error: "Failed to fetch store" }, { status: 502 });
  }
}
