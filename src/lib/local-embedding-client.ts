/**
 * The browser's half of switching the model on this box (TASK-2411), for
 * Settings → Local AI's memory-search card: the switch, then the FULL pass
 * every change of embedder needs — the index belongs to the model that wrote
 * it. Memory Shard's embedder card keeps its own `choose`, because there the
 * same steps are one flow with the cloud/local switch (a download first, its
 * phases on the card); both cards share the reason sentences below.
 *
 * Client-safe: fetch only.
 */

import type { LocalEmbeddingModelId } from "@/lib/embed-runtime-ids";
import type { LocalModelUnavailableReason } from "@/lib/local-embedding-gating";

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "";
}

/**
 * Point the index at `model` on this box and start the full pass. Throws with
 * the route's own sentence when it refuses (a model this box cannot run, one
 * not downloaded yet). A 409 from the pass is one already running or a
 * switched-off feature: the switch itself has landed either way.
 */
export async function switchLocalEmbeddingModel(model: LocalEmbeddingModelId, fallbackError: string): Promise<void> {
  const res = await fetch("/setup-api/clawkeep/memory/provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "local", localModel: model }),
  });
  if (!res.ok) throw new Error((await refusal(res)) || fallbackError);
  const index = await fetch("/setup-api/clawkeep/memory/index", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "full" }),
  });
  if (!index.ok && index.status !== 409) throw new Error(fallbackError);
}

/** The translated sentence for why this box cannot run a model. */
export function unavailableReasonKey(reason: LocalModelUnavailableReason | null): string {
  switch (reason) {
    case "jetson": return "localModels.embed.unavailable.jetson";
    case "not_x86": return "localModels.embed.unavailable.notX86";
    case "no_gpu": return "localModels.embed.unavailable.noGpu";
    default: return "localModels.embed.unavailable.gpuMemory";
  }
}
