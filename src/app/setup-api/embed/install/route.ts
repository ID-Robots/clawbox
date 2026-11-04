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
import { getEmbedLaunchSpec, getEmbedProvisioningStatus } from "@/lib/embed-server";
import { embedModelAsidePath } from "@/lib/embed-model-download";
import { EMBED_GROUP, embedModelDownloadTask } from "@/lib/embed-install-task";
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
  const force = await req.json().then(
    (body: unknown) => (body as { force?: unknown })?.force === true,
    () => false,
  );

  const provisioning = await getEmbedProvisioningStatus().catch(() => null);
  if (provisioning?.installed && !force) {
    return closingLine({ success: true, status: "The memory-search model is already on this box." });
  }

  const start = startBackgroundTask(embedModelDownloadTask({ force }));
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

  const spec = getEmbedLaunchSpec();
  // A copy a dead "Download again" left aside would otherwise be put back by
  // the next download — and is disk the owner asked for back.
  await fs.rm(embedModelAsidePath(spec.modelPath), { force: true }).catch(() => {});
  let freedBytes: number | null = null;
  try {
    freedBytes = (await fs.stat(spec.modelPath)).size;
  } catch {
    return NextResponse.json({ error: "The memory model is not on this box.", code: "not_found" }, { status: 404 });
  }
  await stopLocalAiProvider("embed").catch(() => {});
  // The stop is awaited: a download started from another tab meanwhile owns
  // the file now (and a "Download again" may have moved it aside).
  const startedMeanwhile = liveBackgroundTask(EMBED_GROUP);
  if (startedMeanwhile) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy", taskId: startedMeanwhile.id }, { status: 409 });
  }
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
