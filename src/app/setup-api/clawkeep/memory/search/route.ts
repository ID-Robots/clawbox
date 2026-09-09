import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import { searchLocalMemory } from "@/lib/memory-index-local";

export const dynamic = "force-dynamic";

/** Cap on what one call may return. */
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;

/**
 * Search the index ClawBox built out of the owner's own folders.
 *
 * WHY THIS EXISTS AND THE OPENCLAW SIDE HAS NO EQUIVALENT: there, the index is
 * OpenClaw's and OpenClaw searches it as part of a turn, so ClawBox never
 * needed a way in. Here ClawBox owns the index, and an index nothing can read
 * is a panel with counts on it. This is what makes the feature a feature: the
 * agent can answer "what did that lease say about the deposit?" out of the
 * owner's own PDFs.
 *
 * DELIBERATELY NOT OWNER-ONLY, and that is the one exception on this route
 * family rather than an oversight. Every other memory route is a WRITE that
 * changes what the box does — which folders are read, whether indexing runs at
 * all — and the agent must not be able to widen any of them, so they refuse the
 * MCP bearer. This one is a READ, and the agent is the intended caller: the
 * whole point is that it can search mid-conversation. The consent it rides on
 * is the one already given — the owner switched Memory Shard on and chose the
 * folders — which is exactly the consent under which the index was built in the
 * first place.
 *
 * Switched off means switched off (409), not "answer from an index the owner
 * stopped": `memory_shard_enabled` is read on every call.
 *
 * It answers DISPLAY names, never the absolute path a file sits at. `/home/…`
 * is not information the agent needs to quote a document, and it is the kind
 * that ends up in a message to somebody else.
 */
export async function GET(request: NextRequest) {
  if (!openclawIsAbsent()) {
    // Where there is an OpenClaw, the index is OpenClaw's — ClawBox has built
    // nothing here to read. Worded as what is TRUE of the box rather than as
    // "the assistant searches it itself", which is right on the OpenClaw SKU
    // and wrong on a `dual` box running Hermes: there OpenClaw's index is still
    // the one that exists, and the Hermes agent cannot reach it.
    return NextResponse.json(
      { error: "This box's memory index belongs to OpenClaw; ClawBox does not search it.", code: "edition" },
      { status: 409 },
    );
  }
  if (!(await getMemoryShardEnabled())) {
    return NextResponse.json(
      { error: "Memory Shard is switched off on this box.", code: "disabled", kind: "disabled" },
      { status: 409 },
    );
  }

  const params = request.nextUrl.searchParams;
  const query = (params.get("q") ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "What should it search for?", code: "no_query" }, { status: 400 });
  }
  const asked = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(asked) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(asked))) : DEFAULT_LIMIT;

  try {
    const results = await searchLocalMemory(query, limit, request.signal);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The embedder not answering is the one failure worth naming: it is the
    // same "check the model" the index run reports, and it is transient — the
    // unit sleeps and the wake can be refused while the box is busy.
    console.warn(`[memory-shard] search failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "The memory index could not be searched right now.", code: "search_failed" },
      { status: 503 },
    );
  }
}
