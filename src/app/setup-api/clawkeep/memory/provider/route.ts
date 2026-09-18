import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { readEmbeddingPlacement, switchToLocalEmbeddings } from "@/lib/memory-shard";
import { noteOwnerChoice } from "@/lib/clawai-cloud-choice";
import { invalidateMemoryStatusCache } from "@/lib/clawkeep-memory";
// The PURE half of the cloud-defaults rule (client-safe, one type import
// behind it): the server half is loaded lazily below with the probe it owns.
import { resolveClawaiCloudDefaults } from "@/lib/clawai-cloud-defaults-state";
import {
  LOCAL_EMBEDDING_ENGINE,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
  type EmbedderChoiceStatus,
  type EmbeddingSource,
} from "@/lib/memory-shard-state";

export const dynamic = "force-dynamic";

/**
 * Where the memory index is embedded — the ClawBox AI cloud or the model on
 * this box — and the owner's switch between the two.
 *
 * The gap this first filled: `memory.search` had no route and no TypeScript
 * caller in the whole product — only a boot script wrote it, and on a box where
 * that script failed nothing the owner could click would move memory off the
 * cloud embedder. Since 2026-09-15 it is a real switch in both directions (the
 * owner's ask: a cloud/local choice in Memory Shard's settings, and a wizard
 * that uses the cloud model when the box has a ClawBox AI plan instead of
 * downloading 640 MB).
 *
 * The status cache is invalidated after a write because the write changes the
 * index identity: the next reading must come from the core, not from a
 * two-minute cache that still names the other embedder. The REBUILD that
 * identity change needs is the caller's to ask for — the wizard and the
 * settings card both post a full pass right after.
 */

/**
 * GET → `EmbedderChoiceStatus`. Not owner-gated: it says where the index is
 * embedded and whether the other place is on offer, nothing more, and the
 * middleware already requires a session or the device bearer.
 */
export async function GET() {
  try {
    return NextResponse.json(await readEmbedderChoice(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // Never "local" over a read that failed: a card that believed it would
    // skip the very request that moves a cloud index back onto the box.
    console.error("[memory-shard] where the index is embedded could not be read:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Where the memory index is embedded could not be read from this box's config.", kind: "unreadable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

async function readEmbedderChoice(): Promise<EmbedderChoiceStatus> {
  // Loaded here rather than at the top: they pull the cloud-defaults resolver,
  // the embedder probe and the provisioning check, and the POST's local path —
  // the one every older caller takes — needs none of them.
  const [{ getEmbedProvisioningStatus }, { readCloudDefaultsFacts }] = await Promise.all([
    import("@/lib/embed-server"),
    import("@/lib/clawai-cloud-defaults"),
  ]);
  const [provisioning, facts] = await Promise.all([
    getEmbedProvisioningStatus().catch(() => null),
    // The resolver's own facts, so "the cloud model is on offer here" means the
    // same thing it means to the default that puts a box on it: linked, a paid
    // plan, and a probe the cloud embedder answered.
    readCloudDefaultsFacts().catch(() => null),
  ]);
  // The SAME verdict the automatic default acts on, reasons and all, rather
  // than a second reading of one of its facts: `embeddingsRouteReady` alone
  // answered false to a box with no credential, an unpaid plan and a proxy that
  // did not answer alike, and the switch could only say "not available on this
  // box right now" to all three.
  const verdict = facts && resolveClawaiCloudDefaults(facts).embeddings;
  // And the same verdict again as the DEFAULT for a box nobody has pinned, so
  // the card cannot say "the cloud is on offer" over a box that is already
  // embedding there — the owner's ruling of 2026-09-18: with no choice made,
  // the cloud IS the embedder wherever the subscription covers it.
  const placement = await readEmbeddingPlacement(verdict?.source);
  return {
    source: placement.source,
    // Every edition can reach the ClawBox AI endpoint now; the fence that made
    // this false is two allowed addresses rather than one (`memory-embedder.ts`).
    cloudSupported: true,
    cloudAvailable: verdict?.source === "cloud",
    // Null, never a guess, when the facts could not be read at all.
    cloudReason: verdict?.reason ?? null,
    localInstalled: provisioning?.installed === true,
  };
}

/**
 * POST `{ source?: "cloud" | "local" }` → point the index there. No body, or
 * no `source`, is the model on this box — the call every caller made before
 * the cloud half existed.
 *
 * OWNER ONLY: it changes where the owner's memories are embedded. And OUR PAGE
 * ONLY, the same guard the wizard's other write (embed/install) keeps: the
 * owner's browser attaches the session cookie to a POST any other site's page
 * fires at the box, and a page refused the model download must not be able to
 * move the index onto a model that is not there — or off the box.
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
  const source = await requestedSource(request);
  if (source === null) {
    return NextResponse.json({ error: 'Invalid body. Expected { source: "cloud" | "local" }.', kind: "invalid" }, { status: 400 });
  }

  try {
    if (source === "cloud") return await switchCloud();
    // The owner pinned the embedder on the box: the ClawBox AI cloud default
    // must not move the index back at the next boot, which would cost a full
    // reindex nobody asked for. BEFORE the switch, because the two orders fail
    // differently — a mark that landed over a switch that did not honours an
    // intent the owner expressed, while a switch that landed with no mark is
    // one the next boot could undo. Both halves are idempotent, so the 500 a
    // failure here answers asks for a retry that costs nothing.
    await noteOwnerChoice("embeddings");
    await switchToLocalEmbeddings();
    invalidateMemoryStatusCache();
    console.error(
      `[memory-shard] embedding provider set to ${LOCAL_EMBEDDING_PROVIDER}/${LOCAL_EMBEDDING_MODEL} (${LOCAL_EMBEDDING_ENGINE}) by the owner`,
    );
    return NextResponse.json({
      source: "local",
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

async function requestedSource(request: Request): Promise<EmbeddingSource | null> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return "local";
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = (body as { source?: unknown }).source;
    if (value === undefined) return "local";
    return value === "cloud" || value === "local" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Onto the ClawBox AI cloud embedder — on either edition, since 2026-09-18.
 * Refused where it cannot work rather than written and left to fail: a box the
 * cloud embedder does not answer would report a healthy index that finds
 * nothing.
 */
async function switchCloud(): Promise<NextResponse> {
  const [{ readCloudDefaultsFacts }, { resolveClawaiToken }, cloud, { switchToCloudEmbeddings }] = await Promise.all([
    import("@/lib/clawai-cloud-defaults"),
    import("@/lib/harness/credentials"),
    import("@/lib/clawai-cloud-embeddings"),
    import("@/lib/memory-shard"),
  ]);
  const facts = await readCloudDefaultsFacts();
  const token = facts.embeddingsRouteReady ? await resolveClawaiToken() : null;
  if (!token) {
    return NextResponse.json(
      {
        error: "The ClawBox AI cloud model is not available on this box right now: it needs a ClawBox AI plan and a reachable service.",
        kind: "cloud_unavailable",
      },
      { status: 409 },
    );
  }
  await noteOwnerChoice("embeddings");
  await switchToCloudEmbeddings(cloud.cloudEmbeddingsUrl(), token);
  invalidateMemoryStatusCache();
  console.error(
    `[memory-shard] embedding provider set to ${cloud.CLOUD_EMBEDDING_PROVIDER}/${cloud.CLOUD_EMBEDDING_MODEL} (${cloud.CLOUD_EMBEDDING_ENGINE}) by the owner`,
  );
  return NextResponse.json({
    source: "cloud",
    provider: cloud.CLOUD_EMBEDDING_PROVIDER,
    model: cloud.CLOUD_EMBEDDING_MODEL,
    engine: cloud.CLOUD_EMBEDDING_ENGINE,
  });
}
