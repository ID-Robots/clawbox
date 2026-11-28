import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/same-origin";
import { readEmbeddingPlacement, switchToLocalEmbeddings } from "@/lib/memory-shard";
import { noteOwnerChoice } from "@/lib/clawai-cloud-choice";
import { getMemoryStatus, invalidateMemoryStatusCache } from "@/lib/clawkeep-memory";
import { estimateFullReindex } from "@/lib/memory-reindex-advice";
import { confirmRequired, memoryShardWriter, type MemoryShardWriter } from "@/lib/memory-shard-writer";
// The PURE half of the cloud-defaults rule (client-safe, one type import
// behind it): the server half is loaded lazily below with the probe it owns.
import { resolveClawaiCloudDefaults } from "@/lib/clawai-cloud-defaults-state";
import {
  LOCAL_EMBEDDING_BYTES,
  LOCAL_EMBEDDING_ENGINE,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
  type EmbedderChoiceStatus,
  type EmbeddingSource,
} from "@/lib/memory-shard-state";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  isLocalEmbeddingModelId,
  localEmbeddingModelSpec,
  localEmbeddingVariant,
  type LocalEmbeddingModelId,
} from "@/lib/embed-runtime-ids";
import type { LocalEmbeddingSelection } from "@/lib/embed-server";
import type { LocalEmbeddingModelOption } from "@/lib/local-embedding-gating";

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
  const [{ getEmbedProvisioningStatus, readActiveLocalEmbeddingModel }, { readCloudDefaultsFacts }, { localEmbeddingModelOptions }] = await Promise.all([
    import("@/lib/embed-server"),
    import("@/lib/clawai-cloud-defaults"),
    import("@/lib/local-embedding-model"),
  ]);
  const [provisioning, facts, active, localModels] = await Promise.all([
    getEmbedProvisioningStatus().catch(() => null),
    // The resolver's own facts, so "the cloud model is on offer here" means the
    // same thing it means to the default that puts a box on it: linked, a paid
    // plan, and a probe the cloud embedder answered.
    readCloudDefaultsFacts().catch(() => null),
    // Which model on this box, and what else this box could run (TASK-2411).
    // A failed read names the default rather than failing the whole answer:
    // the 0.6B is what every box ran before the choice existed.
    readActiveLocalEmbeddingModel().catch(() => null),
    localEmbeddingModelOptions().catch((): LocalEmbeddingModelOption[] => []),
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
  // the cloud IS the embedder wherever the subscription covers it. Where the
  // facts could not be read at all, `local` is passed EXPLICITLY rather than
  // left to `readEmbeddingPlacement`'s own second reading, which pays for the
  // probe again and can answer differently: that is how one GET came back
  // `source: "cloud"` beside `cloudAvailable: false` — a card saying the index
  // is embedded somewhere it has just said is not on offer.
  const placement = await readEmbeddingPlacement(verdict?.source ?? "local");
  return {
    source: placement.source,
    // Is that WRITTEN DOWN, or the default rule speaking? The wizard's cloud
    // path needs the difference: with the cloud as the default, `source`
    // already says "cloud" on a box that has recorded nothing, and a wizard
    // that read that as "nothing to do" finished without the pin — leaving the
    // next boot's promotion to write it and rebuild a correct index.
    recorded: placement.recorded,
    // Every edition can reach the ClawBox AI endpoint now; the fence that made
    // this false is two allowed addresses rather than one (`memory-embedder.ts`).
    cloudSupported: true,
    cloudAvailable: verdict?.source === "cloud",
    // Null, never a guess, when the facts could not be read at all.
    cloudReason: verdict?.reason ?? null,
    localInstalled: provisioning?.installed === true,
    localModel: active?.id ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
    localModels,
  };
}

/**
 * POST `{ source?: "cloud" | "local", localModel?: id, confirm?: true }` →
 * point the index there. No body, or no `source`, is the model on this box —
 * the call every caller made before the cloud half existed.
 *
 * `localModel` (TASK-2411) picks WHICH model on this box: one of the catalog
 * ids in embed-runtime-ids.ts, and only with `source: "local"`. Refused with
 * 409 `local_model_unavailable` where this box cannot run it (a Jetson, a PC
 * without an NVIDIA GPU or without 6 GB of free GPU memory — the reason is in
 * `reason` and `error`), and with 409 `local_not_installed` while its GGUF is
 * not on disk: the owner downloads it first (embed/install with `model`). A
 * change of model is a change of embedder: from the assistant it takes the
 * same estimate-then-`confirm: true` as a change of place, and every caller
 * posts the full pass after it.
 *
 * WHO: a signed-in person or the box's assistant (`memoryShardWriter`). It
 * changes where the owner's memories are embedded, and a change of place means
 * every file is embedded again — so from the assistant a change needs
 * `confirm: true`, and without it the answer is 409 `confirm_required` with
 * what that re-embed would cost. The assistant is also refused a move onto the
 * on-box model while it is not downloaded: the owner's card downloads it first
 * (embed/install, 640 MB, the owner's own), and an index pointed at a model
 * that is not there finds nothing.
 *
 * And OUR PAGE ONLY, the same guard the wizard's other write (embed/install)
 * keeps: the owner's browser attaches the session cookie to a POST any other
 * site's page fires at the box, and a page refused the model download must not
 * be able to move the index onto a model that is not there — or off the box.
 * The MCP server sends no Origin, which that guard admits.
 */
export async function POST(request: Request) {
  const writer = await memoryShardWriter(request, "Changing the embedding provider");
  if (!writer.ok) return writer.response;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Changing the embedding provider only works from this ClawBox's own pages.", kind: "cross_origin" },
      { status: 403 },
    );
  }
  const change = await requestedChange(request);
  if (change === null) {
    return NextResponse.json({ error: 'Invalid body. Expected { source: "cloud" | "local" }.', kind: "invalid" }, { status: 400 });
  }
  const { source } = change;

  try {
    // Which model on this box, checked for EVERY writer: the owner's page
    // never offers a model this box cannot run, but the route is the boundary.
    let selection: LocalEmbeddingSelection | undefined;
    if (change.localModel) {
      const picked = await localModelSelection(change.localModel);
      if (picked instanceof NextResponse) return picked;
      selection = picked;
    }
    // The local-only AI lock (TASK-2501) answers first, for the assistant too:
    // its gate below would otherwise say "not available" about a box whose
    // owner has simply switched the cloud off.
    if (source === "cloud") {
      const locked = await cloudLockedRefusal();
      if (locked) return locked;
    }
    if (writer.by === "assistant") {
      const refused = await assistantGate(source, change.confirm, selection);
      if (refused) return refused;
    }
    if (source === "cloud") return await switchCloud(writer.by);
    // The owner pinned the embedder on the box: the ClawBox AI cloud default
    // must not move the index back at the next boot, which would cost a full
    // reindex nobody asked for. BEFORE the switch, because the two orders fail
    // differently — a mark that landed over a switch that did not honours an
    // intent the owner expressed, while a switch that landed with no mark is
    // one the next boot could undo. Both halves are idempotent, so the 500 a
    // failure here answers asks for a retry that costs nothing.
    await noteOwnerChoice("embeddings");
    await switchToLocalEmbeddings(selection);
    invalidateMemoryStatusCache();
    const { readActiveLocalEmbeddingModel } = await import("@/lib/embed-server");
    const model = localModelName((await readActiveLocalEmbeddingModel()).id);
    console.error(
      `[memory-shard] embedding provider set to ${LOCAL_EMBEDDING_PROVIDER}/${model} (${LOCAL_EMBEDDING_ENGINE}) by the ${writer.by}`,
    );
    return NextResponse.json({
      source: "local",
      provider: LOCAL_EMBEDDING_PROVIDER,
      model,
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

interface RequestedChange {
  source: EmbeddingSource;
  confirm: boolean;
  /** Which model on this box; absent keeps the one the box is set to. */
  localModel?: LocalEmbeddingModelId;
}

async function requestedChange(request: Request): Promise<RequestedChange | null> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return { source: "local", confirm: false };
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = (body as { source?: unknown }).source;
    const confirm = (body as { confirm?: unknown }).confirm === true;
    const model = (body as { localModel?: unknown }).localModel;
    if (model !== undefined && !isLocalEmbeddingModelId(model)) return null;
    const source = value === undefined ? "local" : value;
    if (source !== "cloud" && source !== "local") return null;
    // A model on this box with the cloud as the place is a contradiction, not
    // a request to guess which half was meant.
    if (source === "cloud" && model !== undefined) return null;
    return model === undefined ? { source, confirm } : { source, confirm, localModel: model };
  } catch {
    return null;
  }
}

/** The name OpenClaw and the index know a local model by. */
function localModelName(id: LocalEmbeddingModelId): string {
  return id === DEFAULT_LOCAL_EMBEDDING_MODEL_ID ? LOCAL_EMBEDDING_MODEL : id;
}

/**
 * The selection a switch onto `id` records, or the refusal: a model this box
 * cannot run (the gate's own reason), or one whose GGUF is not on disk yet.
 * The default 0.6B keeps every rule it had — its download is the owner's
 * card, and the assistant's refusal below still applies to it.
 */
async function localModelSelection(id: LocalEmbeddingModelId): Promise<LocalEmbeddingSelection | NextResponse> {
  const { gateLocalModel, selectionForSwitch } = await import("@/lib/local-embedding-model");
  const gate = await gateLocalModel(id);
  if (!gate.available) {
    return NextResponse.json(
      { error: gate.detail ?? "This box cannot run that embedding model.", kind: "local_model_unavailable", reason: gate.reason, model: id },
      { status: 409 },
    );
  }
  if (id === DEFAULT_LOCAL_EMBEDDING_MODEL_ID) return { id, quant: "Q8_0" };
  const selection = await selectionForSwitch(id);
  if (selection) return selection;
  const spec = localEmbeddingModelSpec(id);
  const bytes = localEmbeddingVariant(id, gate.quant).bytes;
  return NextResponse.json(
    {
      error: `${spec.label} is not downloaded yet (about ${(bytes / 1e9).toFixed(1)} GB). The owner downloads it from Settings → Local AI or Memory Shard's settings.`,
      kind: "local_not_installed",
      model: id,
    },
    { status: 409 },
  );
}

/**
 * What the assistant may not do without more: move the index onto a model
 * that is not on the box, or move it at all without `confirm`. Null when the
 * switch may go ahead — including a "switch" to where the index already is,
 * which re-embeds nothing.
 */
async function assistantGate(
  source: EmbeddingSource,
  confirm: boolean,
  selection?: LocalEmbeddingSelection,
): Promise<NextResponse | null> {
  const current = await readEmbedderChoice();
  if (source === "cloud" && !current.cloudAvailable) {
    // switchCloud's own refusal, said before the estimate rather than after
    // it: an estimate for a move that cannot happen is a question nobody can
    // answer yes to.
    return NextResponse.json(
      {
        error: "The ClawBox AI cloud model is not available on this box right now: it needs a ClawBox AI plan and a reachable service.",
        kind: "cloud_unavailable",
      },
      { status: 409 },
    );
  }
  // A different model on this box is a different embedder just as a different
  // place is: every file is embedded again, so it needs the owner's yes too.
  const modelChange = source === "local" && selection !== undefined && selection.id !== current.localModel;
  const targetInstalled = modelChange
    ? current.localModels.find((m) => m.id === selection?.id)?.installed === true
    : current.localInstalled;
  if (source === "local" && (current.source !== "local" || modelChange) && !targetInstalled) {
    return NextResponse.json(
      {
        error: `The embedding model for this box is not downloaded yet (about ${Math.round(LOCAL_EMBEDDING_BYTES / 1_000_000)} MB). The owner chooses "On this box" in Memory Shard's settings, which downloads it.`,
        kind: "local_not_installed",
      },
      { status: 409 },
    );
  }
  if ((current.source === source && !modelChange) || confirm) return null;
  const [status, cloud] = await Promise.all([getMemoryStatus(), import("@/lib/clawai-cloud-embeddings")]);
  const model = source === "cloud"
    ? await cloudModelForThisBox(cloud)
    : localModelName(selection?.id ?? current.localModel);
  const what = current.source === source
    ? `Switching the model on this box to ${model}`
    : `Moving the index ${source === "cloud" ? "to the ClawBox AI cloud" : "onto this box"}`;
  return confirmRequired(
    `${what} embeds every file again. Ask the owner first; nothing was changed.`,
    {
      from: current.source,
      to: source,
      ...(source === "local" ? { fromModel: localModelName(current.localModel) } : {}),
      model,
      estimate: estimateFullReindex(status, source, model),
    },
  );
}

/**
 * Onto the ClawBox AI cloud embedder — on either edition, since 2026-09-18.
 * Refused where it cannot work rather than written and left to fail: a box the
 * cloud embedder does not answer would report a healthy index that finds
 * nothing.
 */
/**
 * The cloud model the index on THIS box is embedded with: OpenClaw's index (in
 * the agent databases) is on the small model, ClawBox's own index — the edition
 * without OpenClaw — keeps the shared one. The same split `switchToCloudEmbeddings`
 * writes, so the answer names the model that was written.
 */
async function cloudModelForThisBox(cloud: typeof import("@/lib/clawai-cloud-embeddings")): Promise<string> {
  const { openclawIsAbsent } = await import("@/lib/openclaw-config");
  return openclawIsAbsent() ? cloud.CLOUD_EMBEDDING_MODEL : cloud.OPENCLAW_CLOUD_EMBEDDING_MODEL;
}

/**
 * The local-only AI lock (TASK-2501): the owner's documents are not sent to a
 * cloud embedder, so the cloud is not a choice while it is on.
 */
async function cloudLockedRefusal(): Promise<NextResponse | null> {
  const { isCloudAiLocked, cloudAiLockedBody } = await import("@/lib/ai-cloud-lock");
  if (!(await isCloudAiLocked())) return null;
  return NextResponse.json(
    { ...cloudAiLockedBody("Local-only AI is on: Memory Shard embeds on this box only."), kind: "cloud_ai_locked" },
    { status: 409 },
  );
}

async function switchCloud(by: MemoryShardWriter): Promise<NextResponse> {
  // Asked again here, where the switch is written: the lock can go on while
  // the assistant's gate was weighing the move.
  const locked = await cloudLockedRefusal();
  if (locked) return locked;
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
  const model = await cloudModelForThisBox(cloud);
  console.error(
    `[memory-shard] embedding provider set to ${cloud.CLOUD_EMBEDDING_PROVIDER}/${model} (${cloud.CLOUD_EMBEDDING_ENGINE}) by the ${by}`,
  );
  return NextResponse.json({
    source: "cloud",
    provider: cloud.CLOUD_EMBEDDING_PROVIDER,
    model,
    engine: cloud.CLOUD_EMBEDDING_ENGINE,
  });
}
