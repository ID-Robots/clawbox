import { NextRequest, NextResponse } from "next/server";

import { resolveIndexMode, startMemoryIndex } from "@/lib/clawkeep-memory";

export const dynamic = "force-dynamic";

/**
 * Start one indexing pass.
 *
 * `mode: "full"` forces a full reindex, which is what the customer needs after
 * the embedding model changes; anything else is incremental. A run that is
 * declined because one is already going answers 409 rather than pretending to
 * have started a second one — single-flight lives in `startMemoryIndex`, and
 * this route must not paper over its answer.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  // `request.json()` resolves a literal `null` body to null, which the cast
  // does not change — reading `.mode` off it threw and the outer catch turned
  // that into a 500.
  const requested = (body as { mode?: unknown } | null)?.mode === "full" ? "full" : "incremental";
  try {
    // On a box with no index yet, an incremental pass cannot succeed — see
    // resolveIndexMode. The run reports the mode it actually used.
    const { accepted, run } = await startMemoryIndex(await resolveIndexMode(requested), "manual");
    // The run state only. Attaching the status here made the accept path pay
    // for a fresh `openclaw memory status --deep` probe — startMemoryIndex
    // invalidates the cache as it spawns, so it always missed — and that probe
    // is bounded at 90s and would compete with the indexing child it had just
    // started, on a box with 8 GB. The panel refetches the status straight
    // after this resolves anyway.
    return NextResponse.json(
      { accepted, run },
      { status: accepted ? 200 : 409, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Deliberately a fixed string: the underlying failure can carry a path or
    // a provider error, and neither belongs in front of a customer.
    return NextResponse.json(
      { error: "Indexing could not be started. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
