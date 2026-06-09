import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STORE_API = "https://openclawhardware.dev/api/store/apps";
// Upstream caps any response at 200; reject anything outside [1, 200] rather
// than forwarding arbitrary/malformed values to ClawHub.
const MAX_LIMIT = 200;

// Thin authenticated proxy to ClawHub so the desktop never talks to it directly.
async function proxy(target: string, failMsg: string) {
  try {
    const res = await fetch(target, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Store API error" }, { status: res.status });
    }
    return NextResponse.json(await res.json(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[apps/store] proxy failed:", err);
    return NextResponse.json({ error: failMsg }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Per-skill detail (richer metadata the list omits: featured, updatedAt,
  // installsAllTime, executesCode, clawhubUrl).
  const slug = url.searchParams.get("slug");
  if (slug) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
      return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    }
    return proxy(`${STORE_API}/${slug}`, "Failed to fetch app");
  }

  const params = new URLSearchParams();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }
  params.set("limit", String(limit));
  const category = url.searchParams.get("category");
  if (category) params.set("category", category);
  const q = url.searchParams.get("q");
  if (q) params.set("q", q);

  return proxy(`${STORE_API}?${params}`, "Failed to fetch store");
}
