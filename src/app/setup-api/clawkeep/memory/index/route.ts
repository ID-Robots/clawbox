import { NextRequest, NextResponse } from "next/server";

import { hasOwnerSession } from "@/lib/owner-session";
import { startMemoryIndex } from "@/lib/clawkeep-memory";

export const dynamic = "force-dynamic";

/**
 * Start one indexing pass.
 *
 * `mode: "full"` forces a full reindex, which is what the customer needs after
 * the embedding model changes; anything else is incremental. A run that is
 * declined because one is already going answers 409 rather than pretending to
 * have started a second one — single-flight lives in `startMemoryIndex`, and
 * this route must not paper over its answer.
 *
 * OWNER ONLY. Middleware admits the MCP bearer on every /setup-api route and
 * the agent holds it, so until this check existed the assistant could start a
 * full reindex of the owner's memory on its own — an expensive, hours-long pass
 * that re-embeds everything. Reading the status stays open; starting work does
 * not.
 */
export async function POST(request: NextRequest) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Starting an index run needs a signed-in browser session.", kind: "owner_only" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await request.json().catch(() => ({}));
  // `request.json()` resolves a literal `null` body to null, which the cast
  // does not change — reading `.mode` off it threw and the outer catch turned
  // that into a 500.
  const requested = (body as { mode?: unknown } | null)?.mode === "full" ? "full" : "incremental";
  try {
    // The mode asked for, not a resolved one: on a box with no index yet an
    // incremental pass cannot succeed, and startMemoryIndex settles that
    // AFTER declining a caller that overlaps a run — resolving it here first
    // made that caller wait on the CLI probe and then start a second run.
    // The run reports the mode it actually used.
    const { accepted, run } = await startMemoryIndex(requested, "manual");
    // The run state only. The panel adopts it at once and refetches the status
    // straight after this resolves anyway.
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
