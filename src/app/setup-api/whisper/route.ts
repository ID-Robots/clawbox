export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  backgroundTaskResponse,
  liveBackgroundTask,
  liveBackgroundTasks,
  startBackgroundTask,
} from "@/lib/background-tasks";
import { WHISPER_ENGINE_INSTALL_KIND, WHISPER_SIZE_DOWNLOAD_KIND } from "@/lib/background-task-kinds";
import { clearOwnerChoice } from "@/lib/clawai-cloud-choice";
import { checkInstallDisk, checkInstallDisks, dirBytes, diskRefusal } from "@/lib/install-disk";
import { GatewayNotReadyError, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { safeWhisperSize, whisperSize } from "@/lib/local-install";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { syncChannelAudio } from "@/lib/stt-channel";
import { getSttPrimary, readStoredSttPrimary, setSttPrimary, sttEngineOrder } from "@/lib/stt-preference";
import {
  WHISPER_ENGINE_GROUP,
  whisperEngineInstallParts,
  whisperEngineInstallTask,
  whisperSizeDownloadTask,
  whisperSizeGroup,
} from "@/lib/whisper-install-tasks";
import {
  readWhisperState,
  removeWhisperSize,
  uninstallWhisperEngine,
  whisperCacheDir,
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
 * `{error}`), 409 `already_installed` when the unit is there, and a second
 * press while it runs (or waits) follows the same install. Pressed while
 * ANOTHER engine installs, it is accepted and waits its turn as a queued task
 * (src/lib/local-ai-install-queue.ts); so is a size pressed while another size
 * downloads. The work of both is src/lib/whisper-install-tasks.ts. Everything
 * else is the picker: GET its facts, POST a size
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

/**
 * A removal is deleting speech's files right now — the engine, or one size.
 * An install or a download started under it would write into what it deletes,
 * so those are refused (a removal takes seconds, not an install's minutes).
 */
let removing = false;
/**
 * Install and download requests between their first check and the start of
 * their task — the awaits (the box's state, the disk) in which no task record
 * exists yet to tell a removal that something is about to write. A count, not
 * a flag: two downloads of different sizes may both be on their way to the
 * queue.
 */
let starting = 0;

/**
 * Anything writing speech's files, or about to: a start on its way, or a task
 * — running OR queued — of either kind. A task counts on its own because a web
 * server that restarted mid-install ADOPTS the engine's root step
 * (src/lib/background-tasks.ts) with none of this module's flags set — its
 * removal must still refuse.
 */
function speechBusy(): boolean {
  return removing || starting > 0
    || liveBackgroundTasks({ kinds: [WHISPER_ENGINE_INSTALL_KIND, WHISPER_SIZE_DOWNLOAD_KIND] }).length > 0;
}

/**
 * A download of this size already running (or queued): followed. Another size
 * is a download of its own, which joins the queue behind this one — never a
 * refusal (src/lib/local-ai-install-queue.ts, WHISPER_CACHE_LANE).
 */
function followSize(size: string): Response | null {
  const live = liveBackgroundTask(whisperSizeGroup(size));
  return live ? backgroundTaskResponse(live.id) : null;
}

/** A removal deleting speech's files right now: the one write a start must wait out. */
function removalRefusal(): NextResponse {
  return NextResponse.json(
    { error: "Speech on this box is being removed right now. Try again in a moment.", code: "removing" },
    { status: 409 },
  );
}

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
  if (!(await hasPersonSession(req))) {
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
  // Before the disk check: the running download has used part of the space
  // that check would measure it against, and this request only follows it.
  const following = followSize(size);
  if (following) return following;
  if (removing) return removalRefusal();

  // Counted from the first await to the task's start, so a removal arriving
  // in between refuses instead of deleting what this is about to write.
  starting += 1;
  try {
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
      // say how much is missing rather than "not enough space". A download that
      // then waits its turn measures again when it starts.
      const needed = whisperSize(size)?.bytes ?? 0;
      const disk = await checkInstallDisk(whisperCacheDir(size), needed);
      if (!disk.ok) return diskRefusal(disk);
    }

    // Again after the awaits above: the same size may have started meanwhile.
    // ANOTHER size running or queued is not a refusal: this one is accepted
    // and waits its turn (`startBackgroundTask` queues it).
    const startedMeanwhile = followSize(size);
    if (startedMeanwhile) return startedMeanwhile;
    if (removing) return removalRefusal();
    const start = startBackgroundTask(whisperSizeDownloadTask(size, already));
    return backgroundTaskResponse(start.started ? start.task.id : start.running.id);
  } finally {
    starting -= 1;
  }
}

/**
 * The engine itself, for a box that has none. Owner-only and same-origin like
 * every write here (the guard ran before this was reached), and refused while
 * the engine is already installed: the SIZES are the picker's job, and
 * re-running the engine install over a working one is what the Terminal is
 * for. The in-flight flag is released only at the install's real end, so a
 * second click cannot start a second build under the first.
 *
 * A BACKGROUND TASK of the server, which this response only follows: closing
 * Settings, a reload or a dropped tunnel leaves the build and its progress
 * record running, the desktop's corner card keeps drawing it, and a POST while
 * it runs — a reopened Settings — follows the same task instead of `busy`.
 */
async function installEngine(): Promise<Response> {
  const running = liveBackgroundTask(WHISPER_ENGINE_GROUP);
  if (running) return backgroundTaskResponse(running.id);
  if (removing) return removalRefusal();

  // Counted BEFORE the first await, and read by the engine removal and a size
  // removal: a removal arriving in the awaits below must not delete what this
  // is about to install. Another engine's install running is no reason to
  // refuse: this one is accepted and waits its turn in the queue.
  starting += 1;
  try {
    const state = await readWhisperState();
    if (state.installed) {
      return NextResponse.json(
        { error: "Speech on this box is already installed.", code: "already_installed" },
        { status: 409 },
      );
    }
    // Before anything starts: a build that fails on a full disk minutes in is
    // the outcome this refuses in one request. The task measures again when its
    // turn comes, for an install that waited behind another.
    const disk = await checkInstallDisks(whisperEngineInstallParts());
    if (!disk.ok) return diskRefusal(disk);
    if (removing) return removalRefusal();
    const start = startBackgroundTask(whisperEngineInstallTask());
    return backgroundTaskResponse(start.started ? start.task.id : start.running.id);
  } finally {
    starting -= 1;
  }
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
    if (speechBusy()) {
      return NextResponse.json({ error: "Speech on this box is being installed, or a model is being fetched, right now.", code: "busy" }, { status: 409 });
    }
    // Held for the whole removal: an install, a download or a second removal
    // started now would write into what this deletes.
    removing = true;
    try {
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
    } finally {
      removing = false;
    }
  }

  const size = safeWhisperSize(params.get("size"));
  if (size === null) {
    return NextResponse.json({ error: "That is not a speech model this box offers.", code: "invalid" }, { status: 400 });
  }
  // The same reservation every other write on this route takes, held from the
  // measurement through the re-read: the engine install pre-downloads `base`
  // and the engine removal measures and deletes every size, and a size removal
  // interleaved with either would measure or delete a cache under them.
  if (speechBusy()) {
    return NextResponse.json({ error: "Speech on this box is being installed or changed right now.", code: "busy" }, { status: 409 });
  }
  removing = true;
  try {
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
  } finally {
    removing = false;
  }
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
    // The owner's own speech server (TASK-2501 PR-D) is not what was removed:
    // a box that picked it keeps it, and only the engine's row goes.
    const keepsEndpoint = (await readStoredSttPrimary()) === "endpoint";
    if (!openclawIsAbsent()) wrote = await syncChannelAudio(sttEngineOrder(keepsEndpoint ? "endpoint" : "cloud"), false);
    if (!keepsEndpoint) {
      await setSttPrimary("cloud");
      await clearOwnerChoice("stt");
    }
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
