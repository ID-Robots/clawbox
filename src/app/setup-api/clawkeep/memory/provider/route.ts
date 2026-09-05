import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { switchToLocalEmbeddings } from "@/lib/memory-shard";
import { invalidateMemoryStatusCache } from "@/lib/clawkeep-memory";
import {
  LOCAL_EMBEDDING_ENGINE,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
} from "@/lib/memory-shard-state";

export const dynamic = "force-dynamic";

/**
 * Point the memory index at the embedding model on this box.
 *
 * The gap this fills: `memory.search` had no route and no TypeScript caller in
 * the whole product — only a boot script wrote it, and on a box where that
 * script failed (it can, and it logs a non-fatal warning when it does) nothing
 * the owner could click would move memory off the cloud embedder. The wizard's
 * provisioning step calls this once the model is on disk.
 *
 * The status cache is invalidated here because the write changes the index
 * identity: the next reading must come from the core, not from a two-minute
 * cache that still says "ollama".
 *
 * OWNER ONLY: it changes where the owner's memories are embedded.
 *
 * And OUR PAGE ONLY, the same guard the wizard's other write (embed/install)
 * keeps: the owner's browser attaches the session cookie to a POST any other
 * site's page fires at the box, and the two routes are one flow — a page that
 * is refused the model download must not be able to move the index onto a
 * model that is not there.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the embedding provider needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Changing the embedding provider only works from this ClawBox's own pages.", kind: "cross_origin" },
      { status: 403 },
    );
  }

  try {
    await switchToLocalEmbeddings();
    invalidateMemoryStatusCache();
    console.error(
      `[memory-shard] embedding provider set to ${LOCAL_EMBEDDING_PROVIDER}/${LOCAL_EMBEDDING_MODEL} (${LOCAL_EMBEDDING_ENGINE}) by the owner`,
    );
    return NextResponse.json({
      provider: LOCAL_EMBEDDING_PROVIDER,
      model: LOCAL_EMBEDDING_MODEL,
      engine: LOCAL_EMBEDDING_ENGINE,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Could not set the embedding model.",
        kind: "failed",
      },
      { status: 500 },
    );
  }
}
