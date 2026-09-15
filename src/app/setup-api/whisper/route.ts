export const dynamic = "force-dynamic";

import { spawn } from "child_process";
import path from "path";
import { NextResponse } from "next/server";
import { clearOwnerChoice } from "@/lib/clawai-cloud-choice";
import { CONFIG_ROOT } from "@/lib/config-store";
import { checkInstallDisk, dirBytes, diskRefusal } from "@/lib/install-disk";
import { GatewayNotReadyError, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { safeWhisperSize, whisperSize } from "@/lib/local-install";
import { hasOwnerSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { followRootStep } from "@/lib/root-step-follow";
import { isSameOriginRequest } from "@/lib/same-origin";
import { syncChannelAudio } from "@/lib/stt-channel";
import { getSttPrimary, setSttPrimary, sttEngineOrder } from "@/lib/stt-preference";
import {
  readWhisperState,
  removeWhisperSize,
  restartWhisper,
  setActiveWhisperSize,
  uninstallWhisperEngine,
  whisperCacheDir,
  whisperFetchScript,
} from "@/lib/whisper-models";

/**
 * /setup-api/whisper — which speech-to-text size this box transcribes with.
 *
 * Every box used to ship with `base`; since 2026-09-15 no box ships with the
 * engine at all (owner's ruling: install.sh forces nothing but the llama.cpp
 * runtime and Gemma 4), so this route is also where the ENGINE arrives:
 * `POST { action: "install-engine" }` streams install.sh's
 * `voice_whisper_install` root step — faster-whisper, the CTranslate2 CUDA
 * build and the `base` weights — in the shape `/setup-api/tts/install`
 * answers with (`{status}` lines, then ONE closing `{success: true}` or
 * `{error}`), 409 `already_installed` when the unit is there, 409 `busy`
 * while one runs. Everything else is the picker: GET its facts, POST a size
 * to fetch it and switch to it, DELETE one to get the disk back — or, with
 * `?scope=engine`, take speech-to-text off the box altogether (every size,
 * the stamp, the unit), which is Settings → Local AI's Uninstall.
 *
 * OWNER ONLY for both writes, and same-origin with it. A size change spends
 * hundreds of megabytes and swaps the engine the microphone speaks to; the
 * middleware admits the MCP bearer to this path like any other, and the agent
 * is exactly the party that must not be able to do this on its own.
 *
 * SWAPPING DOES NOT BREAK THE RUNNING ENGINE. The weights are fetched FIRST,
 * whole; only then is the unit rewritten, and only then is the engine bounced —
 * with `try-restart`, so an engine the owner had switched off stays off. A
 * download that fails leaves the unit pointing where it did, and the answer
 * says so.
 */

const encoder = new TextEncoder();
/** A `medium` fetch on a slow link is tens of minutes; the client may leave, the child may not be killed for it. */
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;
/** How often the cache directory is re-measured for the bar. */
const PROGRESS_POLL_MS = 1500;

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  // A cancelled stream refuses further writes; the download itself goes on and
  // the in-flight flag still has to be released by the end of the run.
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

/** One fetch at a time: two would write the same Hub cache entry. */
let inFlight = false;
/** One engine install at a time: two would fight over pip and the CTranslate2 build tree. */
let engineInFlight = false;
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this stream, owns the kill — the rule the tts/install route
 * keeps, and the CTranslate2 build alone is five minutes on an Orin.
 */
const ENGINE_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const state = await readWhisperState();
  // Measured against the cache's own filesystem, which on this box need not be
  // the one `data/` sits on. Nothing is being asked for yet, so the requirement
  // is 0 and only the two figures the picker draws are read off it.
  const disk = await checkInstallDisk(whisperCacheDir("base"), 0);
  const cached = await Promise.all(
    state.sizes.map(async (s) => (s.cached ? await dirBytes(whisperCacheDir(s.id)) : null)),
  );
  return NextResponse.json(
    {
      ...state,
      sizes: state.sizes.map((s, i) => ({ ...s, diskBytes: cached[i] })),
      freeBytes: disk.freeBytes,
      reserveBytes: disk.reserveBytes,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function guard(req: Request, verb: string): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: `${verb} needs a signed-in browser session.`, code: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: `${verb} only works from this ClawBox's own pages.`, code: "cross_origin" }, { status: 403 });
  }
  return null;
}

export async function POST(req: Request) {
  const refused = await guard(req, "Changing the speech model");
  if (refused) return refused;

  let body: { size?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid" }, { status: 400 });
  }
  if (body.action === "install-engine") return installEngine();

  // The CATALOGUE's own string, not the caller's: `whisperCacheDir` builds a
  // path from it, and the repo's rule is that what reaches `path.join` is
  // rebuilt rather than tested and passed through (`safeAppId`).
  const size = safeWhisperSize(body.size);
  if (size === null) {
    return NextResponse.json({ error: "That is not a speech model this box offers.", code: "invalid" }, { status: 400 });
  }

  const state = await readWhisperState();
  if (!state.installed) {
    return NextResponse.json(
      { error: "Speech on this box is not installed yet. Install the voice first.", code: "not_installed" },
      { status: 409 },
    );
  }

  const already = state.sizes.find((s) => s.id === size)?.cached === true;
  if (!already) {
    // Before a byte is fetched, and reported with the figures so the panel can
    // say how much is missing rather than "not enough space".
    const needed = whisperSize(size)?.bytes ?? 0;
    const disk = await checkInstallDisk(whisperCacheDir(size), needed);
    if (!disk.ok) return diskRefusal(disk);
  }

  if (inFlight) {
    return NextResponse.json({ error: "A speech model is already being fetched.", code: "busy" }, { status: 409 });
  }
  inFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        if (!already) {
          const total = whisperSize(size)?.bytes ?? 0;
          emit(controller, { status: `Fetching the ${size} speech model…`, completed: 0, total });
          const dir = whisperCacheDir(size);
          timer = setInterval(() => {
            void dirBytes(dir).then((bytes) => {
              if (bytes !== null) emit(controller, { completed: bytes, total });
            });
          }, PROGRESS_POLL_MS);
          const fetched = await runFetch(size, (line) => emit(controller, { status: line }));
          if (timer) { clearInterval(timer); timer = null; }
          if (!fetched.ok) {
            // The unit is untouched, so the box still transcribes with whatever
            // it did before this click. Nothing to undo.
            emit(controller, { error: fetched.error });
            return;
          }
          // Re-measured rather than assumed: a download that exits 0 with an
          // incomplete snapshot is exactly the shape install-voice.sh's own
          // cache check exists to catch.
          const after = await readWhisperState();
          if (after.sizes.find((s) => s.id === size)?.cached !== true) {
            emit(controller, { error: "The download finished but the model is not complete on this box." });
            return;
          }
        }

        emit(controller, { status: "Pointing speech on this box at the new model…" });
        const pointed = await setActiveWhisperSize(size);
        if (!pointed.ok) {
          emit(controller, { error: pointed.error ?? "Could not switch to that speech model." });
          return;
        }
        const restarted = await restartWhisper();
        emit(controller, {
          success: true,
          size,
          restarted: restarted.ok,
          // Not an error: the weights are here and the unit names them. The
          // engine picks them up on its next start either way, and saying
          // "failed" over a change that landed sends the owner to repeat it.
          status: restarted.ok
            ? `Speech on this box now uses the ${size} model.`
            : `Speech on this box will use the ${size} model after the next restart.`,
        });
      } catch (err) {
        emit(controller, { error: err instanceof Error ? err.message : "The speech model change failed." });
      } finally {
        if (timer) clearInterval(timer);
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
 * The engine itself, for a box that has none. Owner-only and same-origin like
 * every write here (the guard ran before this was reached), and refused while
 * the engine is already installed: the SIZES are the picker's job, and
 * re-running the engine install over a working one is what the Terminal is
 * for. The root unit runs on if the client leaves; the in-flight flag is
 * released only at its real end, so a second click cannot start a second
 * build under the first.
 */
async function installEngine(): Promise<Response> {
  const state = await readWhisperState();
  if (state.installed) {
    return NextResponse.json(
      { error: "Speech on this box is already installed.", code: "already_installed" },
      { status: 409 },
    );
  }
  if (engineInFlight) {
    return NextResponse.json({ error: "Speech on this box is already being installed.", code: "busy" }, { status: 409 });
  }
  engineInFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { status: "Installing speech on this box (faster-whisper)…" });
        const result = await followRootStep("voice_whisper_install", {
          timeoutMs: ENGINE_INSTALL_TIMEOUT_MS,
          label: "the speech install",
          onStatus: (line) => emit(controller, { status: line }),
        });
        if (!result.ok) {
          emit(controller, { error: result.error || "The speech install did not finish." });
        } else {
          emit(controller, { success: true, status: "Speech on this box is installed." });
        }
      } catch (err) {
        emit(controller, { error: err instanceof Error ? err.message : "The speech install failed." });
      } finally {
        engineInFlight = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

export async function DELETE(req: Request) {
  const refused = await guard(req, "Removing a speech model");
  if (refused) return refused;

  const params = new URL(req.url).searchParams;
  if (params.get("scope") === "engine") {
    // The whole engine, not one size. Refused while a size is being fetched —
    // the fetcher would go on writing into a cache this is deleting, and the
    // stream would then point the unit at weights that are gone — and while
    // the ENGINE is being installed, whose own pre-download is the second
    // writer into that cache.
    if (inFlight || engineInFlight) {
      return NextResponse.json({ error: "Speech on this box is being installed, or a model is being fetched, right now.", code: "busy" }, { status: 409 });
    }
    // Read BEFORE the removal, the Kokoro DELETE's pattern: afterwards the
    // stored preference is the only trace that the box's engine was chosen.
    const pickedLocal = await getSttPrimary().then((p) => p === "local", () => false);
    const removed = await uninstallWhisperEngine();
    if (!removed.ok) {
      return NextResponse.json({ error: removed.error, code: removed.code ?? "remove_failed" }, { status: 500 });
    }
    const warning = await releaseLocalTranscription();
    const state = await readWhisperState();
    return NextResponse.json({
      ok: true,
      freedBytes: removed.freedBytes,
      ...state,
      ...(pickedLocal ? { fallback: { requested: "local", reason: "not_installed" } } : {}),
      ...(warning ? { warning } : {}),
    });
  }

  const size = safeWhisperSize(params.get("size"));
  if (size === null) {
    return NextResponse.json({ error: "That is not a speech model this box offers.", code: "invalid" }, { status: 400 });
  }
  const freed = await dirBytes(whisperCacheDir(size));
  const removed = await removeWhisperSize(size);
  if (!removed.ok) {
    return NextResponse.json(
      { error: removed.error, code: removed.code ?? "remove_failed" },
      { status: removed.code === "in_use" ? 409 : 500 },
    );
  }
  const state = await readWhisperState();
  return NextResponse.json({ ok: true, freedBytes: freed, ...state });
}

/**
 * Run the fetcher and report what it said.
 *
 * Its own process group, so a timeout ends the download rather than orphaning a
 * multi-hundred-megabyte transfer; stderr is the reason a person reads, kept to
 * its last line so a Python traceback does not become the row's copy.
 */
function runFetch(size: string, onStatus: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/python3", [whisperFetchScript(CONFIG_ROOT), size], {
      cwd: path.dirname(whisperFetchScript(CONFIG_ROOT)),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let settled = false;
    let stderr = "";
    const finish = (outcome: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      finish({ ok: false, error: "The speech model download took too long and was stopped." });
    }, FETCH_TIMEOUT_MS);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onStatus(trimmed);
      }
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", () => finish({ ok: false, error: "Could not start the speech model download." }));
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true });
      const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      finish({ ok: false, error: lines.at(-1) || `The speech model download failed (exit ${code}).` });
    });
  });
}

/**
 * After the engine is gone, take it out of what still NAMES it: the CLI row in
 * OpenClaw's shared audio list — which channel voice notes exec, and which on a
 * box with no unit polls a dead socket for a minute and then downloads the
 * weights this removal just freed — and `stt_primary` with its owner pin. The
 * stt route's own order: the gateway's config first, the preference second.
 *
 * Never turns a landed uninstall into a failure: what it could not do comes
 * back as a `warning` sentence, the stt route's wording, and the panel says it
 * in amber beside a row that correctly reads "not installed".
 */
async function releaseLocalTranscription(): Promise<string | null> {
  let wrote = false;
  try {
    if (!openclawIsAbsent()) wrote = await syncChannelAudio(sttEngineOrder("cloud"), false);
    await setSttPrimary("cloud");
    await clearOwnerChoice("stt");
  } catch (err) {
    console.warn("[setup-api/whisper] could not release the removed engine from the transcription settings:", err);
    return "Removed, but the transcription settings could not be updated — channel voice notes still name the box's own engine until the engine is changed in Settings → Local AI.";
  }
  if (!wrote) return null;
  try {
    // Media-understanding config is read at gateway start.
    await restartGateway();
    return null;
  } catch (err) {
    console.warn("[setup-api/whisper] gateway restart failed after the audio write:", err);
    return err instanceof GatewayNotReadyError
      ? "Removed. The gateway has not finished restarting — channel voice notes switch over once it is serving again."
      : "Removed, but the gateway restart failed — channel voice notes switch over at the next restart.";
  }
}
