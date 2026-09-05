export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { openclawIsAbsent } from "@/lib/openclaw-config";
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
  const supported = !openclawIsAbsent();
  const [provisioning, unit] = supported
    ? await Promise.all([
        getEmbedProvisioningStatus().catch(() => null),
        readUnitState(EMBED_UNIT, "system").catch(() => null),
      ])
    : [null, null];
  return NextResponse.json(
    {
      supported,
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
