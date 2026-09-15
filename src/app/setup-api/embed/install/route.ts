export const dynamic = "force-dynamic";

import fs from "fs/promises";
import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { followRootStep } from "@/lib/root-step-follow";
import { getEmbedLaunchSpec, getEmbedProvisioningStatus } from "@/lib/embed-server";
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
 * `{status}` lines while it runs, then ONE closing `{success: true}` or
 * `{error}`. A model already on disk answers the closing line at once — a
 * repeat of the wizard must not spend the step on a no-op root unit.
 */

const encoder = new TextEncoder();
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this stream, owns the kill. Same rule the llama.cpp and voice
 * install routes keep.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

/** One download at a time: two would fight over the same file. */
let inFlight = false;

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
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: "Setting up the memory model needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Setting up the memory model only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  if (inFlight) {
    return NextResponse.json({ error: "The memory model is already being fetched.", code: "busy" }, { status: 409 });
  }
  // Settings -> Local AI's "Download again" on a row that already reads
  // installed: the GGUF is on the box but the index says the embedder is not
  // answering, and re-running the step is the one repair that does not need a
  // terminal. A bodyless POST — every caller that predates this — is unchanged.
  const force = await req.json().then(
    (body: unknown) => (body as { force?: unknown })?.force === true,
    () => false,
  );
  inFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const provisioning = await getEmbedProvisioningStatus().catch(() => null);
        if (provisioning?.installed && !force) {
          emit(controller, { success: true, status: "The memory-search model is already on this box." });
          return;
        }
        emit(controller, { status: "Fetching the memory-search model (Qwen3-Embedding, about 640 MB)…" });
        const result = await followRootStep("embed_model", {
          timeoutMs: INSTALL_TIMEOUT_MS,
          label: "the memory model download",
          onStatus: (line) => emit(controller, { status: line }),
        });
        if (!result.ok) {
          emit(controller, { error: result.error || "The memory model download did not finish." });
        } else {
          emit(controller, { success: true, status: "The memory-search model is on this box." });
        }
      } catch (err) {
        emit(controller, { error: err instanceof Error ? err.message : "The memory model download failed." });
      } finally {
        inFlight = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
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
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: "Removing the memory model needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Removing the memory model only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  if (inFlight) {
    return NextResponse.json({ error: "The memory model is being fetched right now.", code: "busy" }, { status: 409 });
  }

  const spec = getEmbedLaunchSpec();
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
