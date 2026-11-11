export const dynamic = "force-dynamic";

import fs from "fs/promises";
import { NextResponse } from "next/server";
import {
  backgroundTaskResponse,
  liveBackgroundTask,
  startBackgroundTask,
} from "@/lib/background-tasks";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import path from "@/lib/runtime-path";
import {
  getEmbedLaunchSpec,
  getEmbedModelDir,
  getEmbedProvisioningStatus,
  readActiveLocalEmbeddingModel,
} from "@/lib/embed-server";
import { embedModelAsidePath } from "@/lib/embed-model-download";
import { EMBED_GROUP, embedModelDownloadTask } from "@/lib/embed-install-task";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  isLocalEmbeddingModelId,
  localEmbeddingModelSpec,
  localEmbeddingVariant,
  type LocalEmbeddingModelId,
} from "@/lib/embed-runtime-ids";
import { partPathOf } from "@/lib/embed-model-fetch";

/**
 * POST /setup-api/embed/install → fetch the memory-search model, streamed.
 *
 * The Memory Shard wizard's provisioning step. The work is install.sh's own
 * `embed_model` — the Qwen3-Embedding GGUF cached into data/embed/models as
 * root, ahead of time, so the unit never has to download 640 MB inside a
 * proxied request (OpenClaw gives a document batch 120 s). Started through
 * the one launcher the web server is granted (src/lib/root-step-runner.ts;
 * `embed_model` is on its list) and followed through systemd so the wizard
 * shows what the download is doing. The same step every update runs, so a
 * box provisioned from here is the same box an update produces. An x86 PC has
 * no such step on either of its installs, and fetches the same verified file
 * as the web server's own user instead (TASK-2418, embed-install-task.ts).
 *
 * Answers the llama.cpp install route's shape, which the wizard reads:
 * `{status}` lines while it runs, with `{completed, total}` bytes for the bar,
 * then ONE closing `{success: true}` or `{error}`. A model already on disk
 * answers the closing line at once — a repeat of the wizard must not spend
 * the step on a no-op root unit.
 *
 * A BACKGROUND TASK of the server (src/lib/background-tasks.ts), which this
 * response only follows: closing Settings or the wizard, a reload or a dropped
 * tunnel leaves the download and its progress running, the desktop's corner
 * card keeps drawing it, and a POST while it runs follows the same task
 * instead of answering `busy`. The root step runs in its own unit, so even a
 * restart of the web server mid-download is followed again to its end. The
 * download holds no lane of the install queue (src/lib/local-ai-install-queue.ts):
 * it runs beside an engine install whenever the box has the room, and waits
 * its turn, queued, when it has not. The work is src/lib/embed-install-task.ts.
 */

const encoder = new TextEncoder();

function closingLine(payload: Record<string, unknown>): Response {
  return new Response(encoder.encode(`${JSON.stringify(payload)}\n`), {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  // No edition gate. This route used to refuse the Hermes SKU outright —
  // "Memory search is not part of this edition" — because the index it fed was
  // OpenClaw's. ClawBox owns an index on that edition now, over this very
  // model, so the wizard's provisioning step has to be able to fetch it there.
  // The main install still does NOT (see install.sh's call site): 639 MB is
  // spent on the owner's click, not on every flash.
  //
  // OWNER ONLY. Fetching software as root is the person's decision; the agent
  // holds the MCP bearer the middleware also admits here.
  if (!(await hasPersonSession(req))) {
    return NextResponse.json({ error: "Setting up the memory model needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Setting up the memory model only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  // A download already running (or queued) is the one this request wants: follow it.
  const running = liveBackgroundTask(EMBED_GROUP);
  if (running) return backgroundTaskResponse(running.id);
  // Settings -> Local AI's "Download again" on a row that already reads
  // installed: the GGUF is on the box but the index says the embedder is not
  // answering, and fetching it afresh is the one repair that does not need a
  // terminal. A bodyless POST — every caller that predates this — is unchanged.
  //
  // `model` (TASK-2411) names which catalog model to fetch; absent is the
  // model the box is set to, which is every caller that predates the choice.
  const body = await req.json().catch(() => null) as { force?: unknown; model?: unknown } | null;
  const force = body?.force === true;
  if (body?.model !== undefined && !isLocalEmbeddingModelId(body.model)) {
    return NextResponse.json({ error: "Unknown embedding model.", kind: "invalid" }, { status: 400 });
  }
  const model: LocalEmbeddingModelId = isLocalEmbeddingModelId(body?.model)
    ? body.model
    : (await readActiveLocalEmbeddingModel().catch(() => null))?.id ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID;

  if (model === DEFAULT_LOCAL_EMBEDDING_MODEL_ID) {
    const provisioning = await getEmbedProvisioningStatus(getEmbedLaunchSpec()).catch(() => null);
    if (provisioning?.installed && !force) {
      return closingLine({ success: true, status: "The memory-search model is already on this box." });
    }
    const start = startBackgroundTask(embedModelDownloadTask({ force }));
    return backgroundTaskResponse(start.started ? start.task.id : start.running.id);
  }

  // Another model: only where this box can run it — the route is the
  // boundary, not the picker that already hides it — and only the variant the
  // gate picks for this GPU.
  const { gateLocalModel, installedLocalEmbeddingVariant } = await import("@/lib/local-embedding-model");
  // The model the box is set to is the variant config.json records — the one
  // the unit loads — and not whichever variant happens to be on disk.
  const active = await readActiveLocalEmbeddingModel().catch(() => null);
  let installed = await installedLocalEmbeddingVariant(model);
  let quant = installed?.quant;
  if (active?.id === model) {
    const variant = localEmbeddingVariant(model, active.quant);
    const here = await fs.stat(path.join(getEmbedModelDir(), variant.file)).then((st) => st.isFile(), () => false);
    installed = here ? { quant: variant.quant, file: variant.file, bytes: variant.bytes } : null;
    quant = variant.quant;
  }
  if (installed && !force) {
    return closingLine({ success: true, status: `${localEmbeddingModelSpec(model).label} is already on this box.` });
  }
  const gate = await gateLocalModel(model);
  if (!gate.available || !gate.quant) {
    return NextResponse.json(
      { error: gate.detail ?? "This box cannot run that embedding model.", kind: "local_model_unavailable", reason: gate.reason },
      { status: 409 },
    );
  }
  const start = startBackgroundTask(embedModelDownloadTask({ force, model, quant: quant ?? gate.quant }));
  return backgroundTaskResponse(start.started ? start.task.id : start.running.id);
}

/**
 * DELETE /setup-api/embed/install → take the memory-search model back off.
 *
 * The undo of the POST, and it lives on the same route for that reason. What
 * it removes is the GGUF this box downloaded — not the unit, not the llama.cpp
 * binary, not the index: those are install.sh's, and a "remove" that quietly
 * uninstalled the runtime would leave the Memory Shard wizard with nothing to
 * put back.
 *
 * The unit is stopped FIRST. llama-server holds the weights open, and unlinking
 * a file out from under a running server frees no disk at all until it exits —
 * which is the one thing this button promises.
 */
export async function DELETE(req: Request) {
  if (!(await hasPersonSession(req))) {
    return NextResponse.json({ error: "Removing the memory model needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Removing the memory model only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  const running = liveBackgroundTask(EMBED_GROUP);
  if (running) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy", taskId: running.id }, { status: 409 });
  }

  // `?model=` (TASK-2411) removes one catalog model's copy — the one the box
  // is NOT set to, typically: switching models never deletes the other GGUF
  // on its own, this is where the owner takes it back. Absent is the model
  // the box is set to, as before.
  const asked = new URL(req.url).searchParams.get("model");
  if (asked !== null && !isLocalEmbeddingModelId(asked)) {
    return NextResponse.json({ error: "Unknown embedding model.", code: "invalid" }, { status: 400 });
  }
  const active = (await readActiveLocalEmbeddingModel().catch(() => null))?.id ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID;
  const target: LocalEmbeddingModelId = asked ?? active;
  if (target !== DEFAULT_LOCAL_EMBEDDING_MODEL_ID) return removeCatalogModel(target, target === active);

  const spec = getEmbedLaunchSpec();
  // A copy a dead "Download again" left aside would otherwise be put back by
  // the next download — and is disk the owner asked for back.
  await fs.rm(embedModelAsidePath(spec.modelPath), { force: true }).catch(() => {});
  // …and so is a part an x86 PC's fetch left (TASK-2418): the next download
  // would resume it otherwise. Measured with the model, and removed with it
  // after the recheck below — a part alone is still something to remove.
  const part = partPathOf(path.dirname(spec.modelPath), localEmbeddingVariant(DEFAULT_LOCAL_EMBEDDING_MODEL_ID));
  const [modelBytes, partBytes] = await Promise.all(
    [spec.modelPath, part].map((file) => fs.stat(file).then((st) => st.size, () => null)),
  );
  if (modelBytes === null && partBytes === null) {
    return NextResponse.json({ error: "The memory model is not on this box.", code: "not_found" }, { status: 404 });
  }
  if (target === active && modelBytes !== null) await stopLocalAiProvider("embed").catch(() => {});
  // The stop is awaited: a download started from another tab meanwhile owns
  // the file now (and a "Download again" may have moved it aside).
  const startedMeanwhile = liveBackgroundTask(EMBED_GROUP);
  if (startedMeanwhile) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy", taskId: startedMeanwhile.id }, { status: 409 });
  }
  try {
    await fs.rm(part, { force: true });
    if (modelBytes !== null) await fs.unlink(spec.modelPath);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not remove the memory model.", code: "remove_failed" },
      { status: 500 },
    );
  }
  const freedBytes = (modelBytes ?? 0) + (partBytes ?? 0);
  const provisioning = await getEmbedProvisioningStatus().catch(() => null);
  return NextResponse.json({ ok: true, freedBytes, installed: !!provisioning?.installed });
}

/** Every variant of a catalog model, and a half-fetched one, off the disk. */
async function removeCatalogModel(model: LocalEmbeddingModelId, isActive: boolean): Promise<Response> {
  const dir = getEmbedModelDir();
  const variants = localEmbeddingModelSpec(model).variants;
  const files = [
    ...variants.map((v) => path.join(dir, v.file)),
    ...variants.map((v) => partPathOf(dir, v)),
  ];
  const sizes = await Promise.all(files.map((f) => fs.stat(f).then((st) => st.size, () => null)));
  if (sizes.every((size) => size === null)) {
    return NextResponse.json({ error: "That memory model is not on this box.", code: "not_found" }, { status: 404 });
  }
  // The running embedder holds the weights open: unlinking under it frees no
  // disk until it exits, which is the one thing this button promises.
  if (isActive) await stopLocalAiProvider("embed").catch(() => {});
  // A download started from another tab during the stop owns the part now.
  const startedMeanwhile = liveBackgroundTask(EMBED_GROUP);
  if (startedMeanwhile) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy", taskId: startedMeanwhile.id }, { status: 409 });
  }
  try {
    for (const file of files) await fs.rm(file, { force: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not remove the memory model.", code: "remove_failed" },
      { status: 500 },
    );
  }
  const freedBytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  const provisioning = await getEmbedProvisioningStatus().catch(() => null);
  return NextResponse.json({ ok: true, freedBytes, installed: !!provisioning?.installed });
}
