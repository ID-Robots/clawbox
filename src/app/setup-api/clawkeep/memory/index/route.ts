import { NextRequest, NextResponse } from "next/server";

import { getMemoryStatus, startMemoryIndex } from "@/lib/clawkeep-memory";

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
  const mode = (body as { mode?: unknown }).mode === "full" ? "full" : "incremental";
  try {
    const { accepted, run } = await startMemoryIndex(mode, "manual");
    if (!accepted) {
      return NextResponse.json(
        { accepted: false, run, status: await getMemoryStatus() },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { accepted: true, run, status: await getMemoryStatus() },
      { headers: { "Cache-Control": "no-store" } },
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
