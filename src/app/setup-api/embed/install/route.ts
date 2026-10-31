export const dynamic = "force-dynamic";

import fs from "fs/promises";
import { NextResponse } from "next/server";
import path from "@/lib/runtime-path";
import {
  BackgroundTaskFailure,
  backgroundTaskResponse,
  runningBackgroundTask,
  startBackgroundTask,
} from "@/lib/background-tasks";
import { EMBED_MODEL_DOWNLOAD_KIND } from "@/lib/background-task-kinds";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { getEmbedLaunchSpec, getEmbedProvisioningStatus } from "@/lib/embed-server";
import { EMBED_HF_FILE } from "@/lib/embed-runtime-ids";
import { dirBytes } from "@/lib/install-disk";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";

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
 * box provisioned from here is the same box an update produces.
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
 * restart of the web server mid-download is followed again to its end.
 */

const encoder = new TextEncoder();
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this stream, owns the kill. Same rule the llama.cpp and voice
 * install routes keep.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** One download at a time: two would fight over the same file. */
const EMBED_GROUP = "embed-model";
/** How often the model directory is re-measured for the bar. */
const PROGRESS_POLL_MS = 1500;
/**
 * The default GGUF's size as the Hub lists it (639 MB), for the bar only: the
 * download's own size is not known before it starts, and an estimate a few
 * kilobytes off holds the bar at 100% for those last kilobytes, which the
 * percent caps. Another file (`EMBED_HF_FILE` in .env) has no known size and
 * gets a moving bar without a figure.
 */
const DEFAULT_MODEL_BYTES = 639 * 1000 * 1000;
const DONE_STATUS = "The memory-search model is on this box.";

/**
 * Where "Download again" keeps the copy it replaces until the new one is
 * whole: beside the models directory, never in it — `dirBytes` of that
 * directory is the bar, and the old copy would count as downloaded.
 */
function asidePath(modelPath: string): string {
  return path.join(path.dirname(path.dirname(modelPath)), `${path.basename(modelPath)}.previous`);
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/**
 * Settle what a download that never finished left aside: an attempt the web
 * server died in (its task was adopted and closed, but nobody was left to
 * tidy). Back in place when there is no model, gone when there is one.
 */
async function settleAside(modelPath: string): Promise<void> {
  const aside = asidePath(modelPath);
  if (!(await exists(aside))) return;
  if (await exists(modelPath)) await fs.rm(aside, { force: true }).catch(() => {});
  else await fs.rename(aside, modelPath).catch(() => {});
}

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
  // A download already running is the one this request wants: follow it.
  const running = runningBackgroundTask(EMBED_GROUP);
  if (running) return backgroundTaskResponse(running.id);
  // Settings -> Local AI's "Download again" on a row that already reads
  // installed: the GGUF is on the box but the index says the embedder is not
  // answering, and fetching it afresh is the one repair that does not need a
  // terminal. A bodyless POST — every caller that predates this — is unchanged.
  const force = await req.json().then(
    (body: unknown) => (body as { force?: unknown })?.force === true,
    () => false,
  );

  const spec = getEmbedLaunchSpec();
  const provisioning = await getEmbedProvisioningStatus().catch(() => null);
  if (provisioning?.installed && !force) {
    return closingLine({ success: true, status: "The memory-search model is already on this box." });
  }

  const start = startBackgroundTask({
    kind: EMBED_MODEL_DOWNLOAD_KIND,
    group: EMBED_GROUP,
    title: "Downloading the memory-search model",
    status: "Fetching the memory-search model (Qwen3-Embedding, about 640 MB)…",
    async run(task) {
      const modelDir = path.dirname(spec.modelPath);
      const aside = asidePath(spec.modelPath);
      // Inside the task, where the group lock serialises it: a request that
      // tidied this up beside a running "Download again" would put the copy it
      // had just moved aside back under it.
      await settleAside(spec.modelPath);
      // "Download again" over a copy that is here: the step answers "already
      // cached" for ANY file at that path, a truncated one included, so the
      // copy is moved aside first — and put back if the new one never arrives,
      // so a failed repair leaves the box no worse than it found it.
      const previousBytes = force ? await fs.stat(spec.modelPath).then((s) => s.size, () => null) : null;
      if (previousBytes !== null) await fs.rename(spec.modelPath, aside);
      const total = previousBytes ?? (path.basename(spec.modelPath) === EMBED_HF_FILE ? DEFAULT_MODEL_BYTES : null);
      const restore = async () => {
        if (previousBytes !== null && !(await exists(spec.modelPath))) await fs.rename(aside, spec.modelPath).catch(() => {});
      };

      // A partial download already there (an attempt that died) is resumed by
      // the Hub CLI, so it counts from the start rather than reading as zero.
      const timer = total === null ? null : setInterval(() => {
        void dirBytes(modelDir).then((bytes) => {
          if (bytes !== null) task.progress(Math.min(bytes, total), total);
        });
      }, PROGRESS_POLL_MS);
      if (total !== null) task.progress(0, total);
      let result;
      try {
        result = await task.rootStep("embed_model", {
          timeoutMs: INSTALL_TIMEOUT_MS,
          label: "the memory model download",
          finishes: { status: DONE_STATUS },
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      if (!result.ok) {
        await restore();
        throw new BackgroundTaskFailure(result.error || "The memory model download did not finish.");
      }
      const after = await getEmbedProvisioningStatus().catch(() => null);
      if (!after?.modelAvailable) {
        await restore();
        throw new BackgroundTaskFailure("The download finished but the memory-search model is not on this box.");
      }
      if (previousBytes !== null) {
        await fs.rm(aside, { force: true }).catch(() => {});
        // The running embedder still holds the old copy open; stopped, it is
        // woken on the next search with the new one.
        await stopLocalAiProvider("embed").catch(() => {});
      }
      return { status: DONE_STATUS };
    },
  });
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
  const running = runningBackgroundTask(EMBED_GROUP);
  if (running) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy", taskId: running.id }, { status: 409 });
  }

  const spec = getEmbedLaunchSpec();
  // A copy a dead "Download again" left aside would otherwise be put back by
  // the next download — and is disk the owner asked for back.
  await fs.rm(asidePath(spec.modelPath), { force: true }).catch(() => {});
  let freedBytes: number | null = null;
  try {
    freedBytes = (await fs.stat(spec.modelPath)).size;
  } catch {
    return NextResponse.json({ error: "The memory model is not on this box.", code: "not_found" }, { status: 404 });
  }
  await stopLocalAiProvider("embed").catch(() => {});
  try {
    await fs.unlink(spec.modelPath);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not remove the memory model.", code: "remove_failed" },
      { status: 500 },
    );
  }
  const provisioning = await getEmbedProvisioningStatus().catch(() => null);
  return NextResponse.json({ ok: true, freedBytes, installed: !!provisioning?.installed });
}
