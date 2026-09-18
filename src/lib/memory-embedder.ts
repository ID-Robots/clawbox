/**
 * WHICH embedder Memory Shard's own index uses, on the edition where ClawBox is
 * the indexer — and the two places it is allowed to send the owner's text.
 *
 * SERVER ONLY.
 *
 * The OpenClaw edition has had this since 2026-09-15 and keeps it in OpenClaw's
 * own `memory.search` config, because there the CORE is the embedding client.
 * Here ClawBox is the client (`memory-index-local.ts`), so the same choice lives
 * in ClawBox's own store — one key, one copy, and never a second store beside
 * the one that governs.
 *
 * THE DEFAULT IS THE CLOUD (the owner's ruling of 2026-09-18: "the default
 * should be cloud, always"). Nothing stored means the box follows the SAME
 * cloud-defaults verdict the OpenClaw arm follows — linked, a paid plan and a
 * cloud embedder that answered a probe — and the model on this box is what the
 * owner opts IN to from the settings card. A box that cannot reach the cloud
 * indexes on itself and the card names the reason, in the resolver's own
 * vocabulary.
 *
 * WHAT IS STORED IS A WORD AND NEVER AN ADDRESS, the same rule
 * `CLAWAI_CLOUD_EMBEDDINGS_KEY` is written around: everything the owner has
 * indexed becomes the body of these requests, and `data/config.json` is reachable
 * by a restored backup and by a hand edit. Where the cloud embedder IS comes from
 * the environment the image was built with, every time, and the loopback proxy's
 * address comes from the embed runtime. Anything the key holds that is not one of
 * the two words is ignored, which lands on the default rule above.
 */

import { get as configGet, set as configSet } from "@/lib/config-store";
import { cloudEmbeddingsUrl, embeddingsBaseUrlOf, CLOUD_EMBEDDING_MODEL, CLOUD_EMBEDDING_PROVIDER } from "@/lib/clawai-cloud-embeddings";
import { getEmbedProxyBaseUrl } from "@/lib/embed-server";
import { isLoopbackBaseUrl } from "@/lib/embed-runtime-ids";
import { resolveClawaiToken } from "@/lib/harness/credentials";
import { resolveClawaiCloudDefaults } from "@/lib/clawai-cloud-defaults-state";
import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
  MEMORY_SHARD_EMBEDDER_KEY,
  type EmbeddingSource,
} from "@/lib/memory-shard-state";

/**
 * One embedder, fully resolved: who it is, where the request goes, and what it
 * is allowed to carry.
 *
 * `baseUrl` is the endpoint WITHOUT `/embeddings`, because that is the string
 * the index identity is built from and the one OpenClaw stores as
 * `memory.search.remote.baseUrl` — the two editions describe an embedder the
 * same way, so a box that swaps harnesses does not silently change what its
 * index belongs to.
 */
export interface ResolvedEmbedder {
  source: EmbeddingSource;
  provider: string;
  model: string;
  /** Identity and fence: the endpoint with no `/embeddings` on the end. */
  baseUrl: string;
  /** Exactly where the POST goes. */
  requestUrl: string;
  /**
   * The bearer. Null only on the cloud arm of a box that holds no ClawBox AI
   * credential — a state {@link embedderUsable} answers for, rather than one
   * that throws inside a status read.
   */
  token: string | null;
  /**
   * Label each input `query`/`document`.
   *
   * ONLY on the loopback proxy, which is what reads the label and restores
   * Qwen3's query instruction (`embed-query-instruction.ts`) before dropping it.
   * The cloud route is OpenAI-shaped and `input_type` is an unknown field there
   * — the same reason `switchToCloudEmbeddings` UNSETS `queryInputType`/
   * `documentInputType` on the OpenClaw edition rather than leaving them.
   */
  labelInputs: boolean;
}

/** Is this embedder in a state that can actually embed? */
export function embedderUsable(embedder: ResolvedEmbedder): boolean {
  return embedder.source === "local" || embedder.token !== null;
}

/** The word in the store, or null for a box nobody has pinned. */
export async function readEmbedderPin(): Promise<EmbeddingSource | null> {
  const stored = await configGet(MEMORY_SHARD_EMBEDDER_KEY);
  return stored === "cloud" || stored === "local" ? stored : null;
}

/** Record where the index is embedded. A word: see the module docblock. */
export async function writeEmbedderPin(source: EmbeddingSource): Promise<void> {
  await configSet(MEMORY_SHARD_EMBEDDER_KEY, source);
}

/**
 * What a box nobody has pinned uses: the cloud-defaults resolver's own verdict.
 *
 * The SAME rule and the same facts the OpenClaw edition's automatic default acts
 * on — linked, a paid plan, a cloud embedder that answered — so "the default is
 * cloud" means one thing on both editions. Facts that cannot be read at all are
 * the model on this box: an index that cannot be embedded at all is worse than
 * one embedded slowly, and the next read tries again.
 *
 * THE PIN IS WHAT RECORDS A CHOICE HERE, and deliberately not
 * `memory_embeddings_choice_source`. Every box that finished the wizard before
 * this change carries `owner` in that key — the wizard's last step POSTed the
 * model on this box because it was the only thing the route could offer on this
 * SKU, and the route marks every pick as the owner's. Reading that mark as "the
 * owner asked for the model on this box" would keep every one of those boxes off
 * the subscription it pays for, for good, which is the opposite of the ruling
 * above. What it still governs is the automatic PROMOTION (`readOwnerChoices`),
 * which writes; this only reads.
 */
export async function defaultEmbedderSource(): Promise<EmbeddingSource> {
  // Lazily, and only here: the server half pulls the probe, the OpenClaw CLI and
  // the memory index, and this module is imported by the index itself.
  const { readCloudDefaultsFacts } = await import("@/lib/clawai-cloud-defaults");
  const facts = await readCloudDefaultsFacts().catch(() => null);
  if (!facts) return "local";
  return resolveClawaiCloudDefaults(facts).embeddings.source;
}

function localEmbedder(): ResolvedEmbedder {
  const baseUrl = getEmbedProxyBaseUrl();
  return {
    source: "local",
    provider: LOCAL_EMBEDDING_PROVIDER,
    model: LOCAL_EMBEDDING_MODEL,
    baseUrl,
    requestUrl: `${baseUrl}/embeddings`,
    // The proxy holds the per-install service token; read at request time by the
    // caller, which is why it is not carried here.
    token: null,
    labelInputs: true,
  };
}

async function cloudEmbedder(): Promise<ResolvedEmbedder> {
  const endpoint = cloudEmbeddingsUrl();
  return {
    source: "cloud",
    provider: CLOUD_EMBEDDING_PROVIDER,
    model: CLOUD_EMBEDDING_MODEL,
    baseUrl: embeddingsBaseUrlOf(endpoint),
    requestUrl: endpoint,
    token: await resolveClawaiToken(),
    labelInputs: false,
  };
}

/**
 * The embedder this box indexes and searches with right now.
 *
 * @param fallback what an unpinned box uses, when the caller has already worked
 *   the cloud-defaults verdict out and would otherwise pay for it twice.
 */
export async function resolveMemoryEmbedder(fallback?: EmbeddingSource): Promise<ResolvedEmbedder> {
  const pinned = await readEmbedderPin();
  const source = pinned ?? fallback ?? (await defaultEmbedderSource());
  return source === "cloud" ? await cloudEmbedder() : localEmbedder();
}

/** Trailing slashes are not part of an address. */
function normalised(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * THE FENCE. The owner's own documents are the body of these requests, so there
 * are exactly two addresses this box will send them to and nothing composes a
 * third:
 *
 *  - the loopback proxy in front of the embedder on this device, and
 *  - the ClawBox AI embeddings endpoint the image was built with, which is the
 *    box's own subscription account.
 *
 * Checked at the moment the socket is opened and not only where the choice was
 * made — a fence with one gate is a fence. Off either of them the index would be
 * quietly shipping the customer's files to a third party, so it refuses instead.
 */
export function embedEndpointAllowed(source: EmbeddingSource, baseUrl: string): boolean {
  if (source === "local") return isLoopbackBaseUrl(baseUrl);
  return normalised(baseUrl) === normalised(embeddingsBaseUrlOf(cloudEmbeddingsUrl()));
}

/**
 * Refuse an endpoint that is neither, in the words the switch shows.
 *
 * Its own function because two callers need the same refusal for the same
 * reason: the index before it embeds, and `switchToCloudEmbeddings` before it
 * records a cloud that is not ClawBox AI.
 */
export function assertEmbedEndpointAllowed(source: EmbeddingSource, baseUrl: string): void {
  if (embedEndpointAllowed(source, baseUrl)) return;
  throw new Error(
    source === "local"
      ? "The embedder endpoint is not on this device."
      : "The embedder endpoint is not this box's ClawBox AI account.",
  );
}
