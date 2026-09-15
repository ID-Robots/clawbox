export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { POST as selectVoice } from "@/app/setup-api/tts/route";
import { clearOwnerChoice } from "@/lib/clawai-cloud-choice";
import { uninstallKokoro } from "@/lib/kokoro-uninstall";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { followRootStep } from "@/lib/root-step-follow";
import { readVoiceState, writeVoiceState } from "@/lib/voice-output-store";

/**
 * POST /setup-api/tts/install → install the box's own voice (Kokoro), streamed.
 *
 * The Local AI tab's "Install" on a Kokoro row that reads "Not installed".
 * The work is install.sh's `voice_kokoro_install` step — the CUDA Kokoro
 * stack, its on-demand server unit, the workspace scripts and the
 * `tts-local-cli` provider entry — started as root through the one launcher
 * the web server is granted (src/lib/root-step-runner.ts; the step is on
 * WEB_ROOT_STEPS), and followed through systemd so the row shows what the
 * installer is doing. It is step_openclaw_tts in its INSTALL mode: the same
 * registration an install and an update run, which since 2026-09-15 install
 * nothing themselves (the owner's ruling — no model or engine but the
 * llama.cpp runtime and Gemma 4 is forced), so this click is the ONLY way
 * Kokoro reaches a box — on every SKU, the Hermes one included.
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
  // EVERY EDITION. The step is `step_openclaw_tts --kokoro`, which installs
  // the engine and then registers it with whichever harness the box runs — on
  // Hermes the `clawbox-local` provider, before its Hermes arm returns. It used
  // to refuse the Hermes SKU (409 `edition`) from the days the whole tts family
  // was OpenClaw-CLI work; that was harmless only while every update installed
  // Kokoro everywhere, and since 2026-09-15 this click is the one way in.
  // OWNER ONLY. Installing software as root is the person's decision; the
  // agent holds the MCP bearer the middleware also admits here.
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: "Installing the voice needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Installing the voice only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  if (inFlight) {
    return NextResponse.json({ error: "The voice is being installed or removed right now.", code: "busy" }, { status: 409 });
  }
  inFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { status: "Installing the voice on this box (Kokoro)…" });
        const result = await followRootStep("voice_kokoro_install", {
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

/**
 * DELETE /setup-api/tts/install → take the box's own voice back off.
 *
 * The undo of the POST, on the same route for that reason (the embed route's
 * precedent). What it removes is `src/lib/kokoro-uninstall.ts`'s list — the
 * weights, the stamp, the unit — and the row on Settings → Local AI reads
 * "not installed" the moment the stamp is gone. Like the POST, not gated on
 * the edition: install-voice.sh writes the Kokoro unit on every SKU and both
 * harnesses speak through the same script, so there is a voice to remove on
 * either — and, symmetrically, a voice to install.
 *
 * A pick of "this box" that is left standing would read back a voice that
 * cannot speak, so it is settled on Auto the way the tts route settles a pick
 * it cannot honour — through that route's own selection, so the harness's
 * provider moves with it — and the answer carries the same `fallback` shape so
 * the panel says so in one amber line.
 *
 * OWNER ONLY and same-origin: the agent holds the MCP bearer the middleware
 * also admits here, and taking the owner's voice away is not its call.
 */
export async function DELETE(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: "Removing the voice needs a signed-in browser session.", code: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Removing the voice only works from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  if (inFlight) {
    return NextResponse.json({ error: "The voice is being installed right now.", code: "busy" }, { status: 409 });
  }

  // The POST's own flag, held for the whole removal: an install started now
  // would write the stamp, the cache and the unit this is deleting.
  inFlight = true;
  try {
    // Read BEFORE the removal: afterwards the status route reports the engine
    // as unconfigured and the stored pick is the only trace that it was chosen.
    const pickedLocal = await readVoiceState().then((s) => s.choice === "local", () => false);
    const removed = await uninstallKokoro();
    if (!removed.ok) {
      return NextResponse.json({ error: removed.error ?? "Could not remove the voice.", code: removed.code ?? "remove_failed" }, { status: 500 });
    }
    if (!pickedLocal) {
      return NextResponse.json({ ok: true, freedBytes: removed.freedBytes, installed: false });
    }
    try {
      const fallback = await releaseLocalVoicePick();
      return NextResponse.json({ ok: true, freedBytes: removed.freedBytes, installed: false, fallback });
    } catch (err) {
      // The voice IS gone; what did not land is moving the pick off it. Said as
      // exactly that, never as a clean success over a pick that still names an
      // engine this box no longer has.
      console.error("[tts/install] the voice was removed but its pick could not be moved to Auto:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        {
          error: "The voice was removed, but the voice choice could not be moved off it. Choose a voice in Settings → Voice.",
          code: "fallback_failed",
          freedBytes: removed.freedBytes,
          installed: false,
        },
        { status: 500 },
      );
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Settle a standing "this box" pick on Auto now that there is no box voice.
 *
 * Through the tts route's own `select`, which also moves the harness's provider
 * off `tts-local-cli` and releases the owner pin. When that route refuses —
 * a box with no cloud voice either answers `no_voice` — the stored choice is
 * still written to Auto directly, because the one outcome this must not leave
 * is a pick that names an engine which is no longer there.
 */
async function releaseLocalVoicePick(): Promise<{ requested: "local"; reason: "not_installed" }> {
  const settled = await selectVoice(new Request("http://127.0.0.1/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "select", choice: "auto" }),
  })).then((res) => res.ok, () => false);
  if (!settled) {
    // Not swallowed: a pick left on "local" or a stale owner pin is what the
    // caller must be told about.
    await writeVoiceState({ ...(await readVoiceState()), choice: "auto" });
    await clearOwnerChoice("tts");
  }
  return { requested: "local", reason: "not_installed" };
}
