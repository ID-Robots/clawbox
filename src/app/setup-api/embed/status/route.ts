export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEmbedProvisioningStatus, readActiveLocalEmbeddingModel, EMBED_UNIT } from "@/lib/embed-server";
import { readUnitState } from "@/lib/local-models";
import { localEmbeddingModelOptions } from "@/lib/local-embedding-model";
import { DEFAULT_LOCAL_EMBEDDING_MODEL_ID } from "@/lib/embed-runtime-ids";
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
  const [provisioning, unit, active, models] = await Promise.all([
    getEmbedProvisioningStatus().catch(() => null),
    readUnitState(EMBED_UNIT, "system").catch(() => null),
    readActiveLocalEmbeddingModel().catch(() => null),
    localEmbeddingModelOptions().catch(() => []),
  ]);
  const activeId = active?.id ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID;
  return NextResponse.json(
    {
      supported: true,
      installed: !!provisioning?.installed,
      binaryAvailable: !!provisioning?.binaryAvailable,
      modelAvailable: !!provisioning?.modelAvailable,
      modelBytes: provisioning?.modelBytes ?? null,
      // The model the embedder runs (TASK-2411): the default slot's name as
      // it always was, or the catalog id the owner picked.
      model: activeId === DEFAULT_LOCAL_EMBEDDING_MODEL_ID ? LOCAL_EMBEDDING_MODEL : activeId,
      modelId: activeId,
      quant: active?.quant ?? null,
      // Every catalog model, with whether this box can run it and why not.
      models,
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
