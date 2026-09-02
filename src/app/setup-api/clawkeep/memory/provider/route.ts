import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { switchToLocalEmbeddings } from "@/lib/memory-shard";
import { LOCAL_EMBEDDING_MODEL } from "@/lib/memory-shard-state";

export const dynamic = "force-dynamic";

/**
 * Point the memory index at the embedding model on this box.
 *
 * The gap this fills: `agents.defaults.memorySearch` had no route and no
 * TypeScript caller in the whole product — only a boot script wrote it, and on
 * a box where that script failed (it can, and it logs a non-fatal warning when
 * it does) nothing the owner could click would move memory off the cloud
 * embedder. The wizard's provisioning step calls this after Ollama is up and
 * the model is pulled.
 *
 * OWNER ONLY: it changes where the owner's memories are embedded.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the embedding provider needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  try {
    await switchToLocalEmbeddings();
    console.error(`[memory-shard] embedding provider set to ollama/${LOCAL_EMBEDDING_MODEL} by the owner`);
    return NextResponse.json({ provider: "ollama", model: LOCAL_EMBEDDING_MODEL });
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
