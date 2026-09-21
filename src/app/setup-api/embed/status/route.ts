export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEmbedProvisioningStatus, EMBED_UNIT } from "@/lib/embed-server";
import { readUnitState } from "@/lib/local-models";
import { LOCAL_EMBEDDING_ENGINE, LOCAL_EMBEDDING_MODEL } from "@/lib/memory-shard-state";

/**
 * GET /setup-api/embed/status → the memory-search embedder on this box.
 *
 * What the Memory Shard wizard asks before it decides whether to fetch the
 * model: is the GGUF on disk, is llama-server there, and what is the unit
 * doing. Measured, never claimed from a config file — the same rule the Local
 * AI inventory keeps. The same object on every path, so a caller never has to
 * tell "not installed" from "could not ask".
 */
export async function GET() {
  // Always measured now. This used to answer `supported: false` with every
  // field null on the Hermes SKU, because the index the model fed was
  // OpenClaw's; ClawBox owns one on that edition too, so the embedder is real
  // on every box. The field stays in the shape — the wizard reads it, and an
  // older client would take its absence for `false`.
  const [provisioning, unit] = await Promise.all([
    getEmbedProvisioningStatus().catch(() => null),
    readUnitState(EMBED_UNIT, "system").catch(() => null),
  ]);
  return NextResponse.json(
    {
      supported: true,
      installed: !!provisioning?.installed,
      binaryAvailable: !!provisioning?.binaryAvailable,
      modelAvailable: !!provisioning?.modelAvailable,
      modelBytes: provisioning?.modelBytes ?? null,
      model: LOCAL_EMBEDDING_MODEL,
      engine: LOCAL_EMBEDDING_ENGINE,
      unit: {
        present: !!unit?.present,
        active: !!unit?.active,
        failed: !!unit?.failed,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
