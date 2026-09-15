export const dynamic = "force-dynamic";

import { spawn } from "child_process";
import path from "path";
import { NextResponse } from "next/server";
import { CONFIG_ROOT } from "@/lib/config-store";
import { checkInstallDisk, dirBytes, diskRefusal } from "@/lib/install-disk";
import { safeWhisperSize, whisperSize } from "@/lib/local-install";
import { hasOwnerSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  readWhisperState,
  removeWhisperSize,
  restartWhisper,
  setActiveWhisperSize,
  whisperCacheDir,
  whisperFetchScript,
} from "@/lib/whisper-models";

/**
 * /setup-api/whisper — which speech-to-text size this box transcribes with.
 *
 * Every box ships with `base`. The owner's decision of 2026-09-14 is that the
 * other sizes are one click away, so this is the click: GET the picker's facts,
 * POST a size to fetch it and switch to it, DELETE one to get the disk back.
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

  let body: { size?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid" }, { status: 400 });
  }
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

export async function DELETE(req: Request) {
  const refused = await guard(req, "Removing a speech model");
  if (refused) return refused;

  const size = safeWhisperSize(new URL(req.url).searchParams.get("size"));
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
