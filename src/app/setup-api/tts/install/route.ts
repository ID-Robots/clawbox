export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { followRootStep } from "@/lib/root-step-follow";

/**
 * POST /setup-api/tts/install → install the box's own voice (Kokoro), streamed.
 *
 * The Local AI tab's "Install" on a Kokoro row that reads "Not installed".
 * The work is install.sh's own step_openclaw_tts — the CUDA Kokoro stack, its
 * on-demand server unit, the workspace scripts and the `tts-local-cli`
 * provider entry — started as root through the one launcher the web server is
 * granted (src/lib/root-step-runner.ts; `openclaw_tts` is on its list), and
 * followed through systemd so the row shows what the installer is doing. The
 * same step an in-app update runs, so a box installed from here is the same
 * box an update produces.
 *
 * Answers the llama.cpp install route's shape, which the tab already reads:
 * `{status}` lines while it runs, then ONE closing `{success: true}` or
 * `{error}`.
 */

const encoder = new TextEncoder();
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this stream, owns the kill: a stream that gave up first would
 * show a red error over an install that was still running and about to
 * finish. Same rule the llama.cpp install route keeps.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  // A cancelled stream refuses further writes; the install itself goes on
  // (a root unit), and the follow below has to reach its real end.
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

/** One install at a time: two would fight over pip, the GPU and the config file. */
let inFlight = false;

export async function POST(req: Request) {
  if (openclawIsAbsent()) {
    return NextResponse.json({ error: "Voice output is not part of this edition.", code: "edition" }, { status: 409 });
  }
  // OWNER ONLY. Installing software as root is the person's decision; the
  // agent holds the MCP bearer the middleware also admits here.
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: "Installing the voice needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Installing the voice only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  if (inFlight) {
    return NextResponse.json({ error: "The voice is already being installed.", code: "busy" }, { status: 409 });
  }
  inFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { status: "Installing the voice on this box (Kokoro)…" });
        const result = await followRootStep("openclaw_tts", {
          timeoutMs: INSTALL_TIMEOUT_MS,
          label: "the voice install",
          onStatus: (line) => emit(controller, { status: line }),
        });
        if (!result.ok) {
          emit(controller, { error: result.error || "The voice install did not finish." });
        } else {
          emit(controller, { success: true, status: "The voice on this box is installed." });
        }
      } catch (err) {
        emit(controller, { error: err instanceof Error ? err.message : "The voice install failed." });
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
