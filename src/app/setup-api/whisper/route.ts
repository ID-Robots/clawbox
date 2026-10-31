export const dynamic = "force-dynamic";

import { spawn } from "child_process";
import path from "@/lib/runtime-path";
import { NextResponse } from "next/server";
import {
  BackgroundTaskFailure,
  backgroundTaskResponse,
  runningBackgroundTask,
  startBackgroundTask,
} from "@/lib/background-tasks";
import { WHISPER_ENGINE_INSTALL_KIND, WHISPER_SIZE_DOWNLOAD_KIND } from "@/lib/background-task-kinds";
import { clearOwnerChoice } from "@/lib/clawai-cloud-choice";
import { CONFIG_ROOT } from "@/lib/config-store";
import { checkInstallDisk, checkInstallDisks, dirBytes, diskRefusal } from "@/lib/install-disk";
import { GatewayNotReadyError, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { safeWhisperSize, whisperSize } from "@/lib/local-install";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { reconcileChannelAudio, syncChannelAudio } from "@/lib/stt-channel";
import { withWhisperLibraryPath } from "@/lib/stt-local";
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

/** A `medium` fetch on a slow link is tens of minutes; the client may leave, the child may not be killed for it. */
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;
/** How often the cache directory is re-measured for the bar. */
const PROGRESS_POLL_MS = 1500;
/** After a Cancel's SIGTERM, how long the fetcher's group has before SIGKILL. */
const CANCEL_GRACE_MS = 3000;

/**
 * One fetch at a time: two would write the same Hub cache entry. Held for the
 * whole size task (src/lib/background-tasks.ts), not only its start.
 */
let inFlight = false;
/** The size fetch's background-task group. */
const WHISPER_SIZE_GROUP = "whisper-size";
/**
 * One engine install at a time: two would fight over pip and the CTranslate2
 * build tree. Held for the whole install task, not only its start, so the size
 * fetch and both removals keep refusing while it runs.
 */
let engineInFlight = false;
/** The engine install's background-task group (src/lib/background-tasks.ts). */
const WHISPER_ENGINE_GROUP = "whisper-engine";
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this stream, owns the kill — the rule the tts/install route
 * keeps, and the CTranslate2 build alone is five minutes on an Orin.
 */
const ENGINE_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * The home the engine installs into, as the ROOT STEP sees it — not this
 * process's `CLAWBOX_HOME`. `clawbox-setup.service` loads `.env`, the root
 * step's unit does not, and install.sh fixes the installer's home to exactly
 * this literal (`CLAWBOX_HOME="/home/clawbox"`, inherited by install-voice.sh),
 * so an override here would measure a filesystem the files never land on.
 * `whisper-install-home.test.ts` pins the two literals together.
 */
const INSTALLER_HOME = "/home/clawbox";
const MIB = 1024 * 1024;
/**
 * Where the WHOLE engine install writes, and a generous ceiling for each —
 * refusing up front costs a click, while running out part-way costs minutes of
 * build and a half-installed engine. Three places, measured per filesystem
 * (they share one on a stock Jetson, and nothing guarantees it): the CTranslate2
 * CUDA source and build tree under /tmp, the faster-whisper and CTranslate2
 * wheels plus `libctranslate2` under ~/.local, and the `base` weights in the
 * Hugging Face cache. 3 GiB in all.
 */
function whisperEngineInstallParts() {
  return [
    { dir: "/tmp/CTranslate2-build", bytes: 2048 * MIB },
    { dir: path.join(INSTALLER_HOME, ".local"), bytes: 768 * MIB },
    { dir: path.join(INSTALLER_HOME, ".cache", "huggingface", "hub"), bytes: 256 * MIB },
  ];
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

  // The same size already on its way is the one this request wants: follow
  // it. Another size is a second writer into the Hub cache and the unit.
  const runningSize = runningBackgroundTask(WHISPER_SIZE_GROUP);
  if (runningSize) {
    if (runningSize.meta?.size === size) return backgroundTaskResponse(runningSize.id);
    return NextResponse.json(
      { error: "A speech model is already being fetched.", code: "busy", taskId: runningSize.id },
      { status: 409 },
    );
  }
  if (inFlight || engineInFlight) {
    return NextResponse.json({ error: "A speech model is already being fetched.", code: "busy" }, { status: 409 });
  }
  inFlight = true;

  const total = whisperSize(size)?.bytes ?? 0;
  const start = startBackgroundTask({
    kind: WHISPER_SIZE_DOWNLOAD_KIND,
    group: WHISPER_SIZE_GROUP,
    title: `Downloading the ${size} speech model`,
    meta: { size },
    status: already ? "Pointing speech on this box at the new model…" : `Fetching the ${size} speech model…`,
    // Stopping a fetch is safe: the unit is not touched until the weights are
    // whole. Once they are, the switch is seconds and is not offered a stop.
    cancellable: !already,
    steps: already
      ? [{ id: "switch", label: "Switch speech to it" }]
      : [
        { id: "fetch", label: `Download the ${size} model`, weight: 9 },
        { id: "switch", label: "Switch speech to it", weight: 1 },
      ],
    async run(task) {
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        if (!already) {
          task.step("fetch");
          if (total > 0) task.progress(0, total);
          const dir = whisperCacheDir(size);
          timer = setInterval(() => {
            void dirBytes(dir).then((bytes) => {
              if (bytes !== null && total > 0) task.progress(Math.min(bytes, total), total);
            });
          }, PROGRESS_POLL_MS);
          const fetched = await runFetch(size, (line) => task.status(line), task.signal);
          clearInterval(timer);
          timer = null;
          if (fetched.cancelled) {
            // A size that was not here before the click: what the fetcher left
            // is half a snapshot nothing can use, and the disk is the owner's.
            await removeWhisperSize(size).catch(() => null);
            throw new BackgroundTaskFailure("The download was cancelled.");
          }
          if (!fetched.ok) {
            // The unit is untouched, so the box still transcribes with whatever
            // it did before this click. Nothing to undo.
            throw new BackgroundTaskFailure(fetched.error ?? "The speech model download failed.");
          }
          // Re-measured rather than assumed: a download that exits 0 with an
          // incomplete snapshot is exactly the shape install-voice.sh's own
          // cache check exists to catch.
          const after = await readWhisperState();
          if (after.sizes.find((s) => s.id === size)?.cached !== true) {
            throw new BackgroundTaskFailure("The download finished but the model is not complete on this box.");
          }
        }

        task.step("switch", "Pointing speech on this box at the new model…");
        const pointed = await setActiveWhisperSize(size);
        if (!pointed.ok) throw new BackgroundTaskFailure(pointed.error ?? "Could not switch to that speech model.");
        const restarted = await restartWhisper();
        return {
          size,
          restarted: restarted.ok,
          // Not an error: the weights are here and the unit names them. The
          // engine picks them up on its next start either way, and saying
          // "failed" over a change that landed sends the owner to repeat it.
          status: restarted.ok
            ? `Speech on this box now uses the ${size} model.`
            : `Speech on this box will use the ${size} model after the next restart.`,
        };
      } finally {
        if (timer) clearInterval(timer);
        inFlight = false;
      }
    },
  });
  if (!start.started) {
    // Not reachable while the flag above is held, but a task that never ran
    // would never give it back.
    inFlight = false;
    return backgroundTaskResponse(start.running.id);
  }
  return backgroundTaskResponse(start.task.id);
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
  const running = runningBackgroundTask(WHISPER_ENGINE_GROUP);
  if (running) return backgroundTaskResponse(running.id);

  // Reserved BEFORE the first await, and shared with the engine removal and a
  // size fetch: two requests that arrive together must not both pass this and
  // start two pip installs and two CTranslate2 builds in the same paths. Every
  // early answer below gives the reservation back; the stream's own `finally`
  // gives it back once an install has started.
  if (engineInFlight || inFlight) {
    return NextResponse.json({ error: "Speech on this box is being installed or changed right now.", code: "busy" }, { status: 409 });
  }
  engineInFlight = true;
  let state: Awaited<ReturnType<typeof readWhisperState>>;
  let disk: Awaited<ReturnType<typeof checkInstallDisks>> | null = null;
  try {
    state = await readWhisperState();
    // Before anything starts: a build that fails on a full disk minutes in is
    // the outcome this refuses in one request.
    if (!state.installed) disk = await checkInstallDisks(whisperEngineInstallParts());
  } catch (err) {
    engineInFlight = false;
    throw err;
  }
  if (state.installed) {
    engineInFlight = false;
    return NextResponse.json(
      { error: "Speech on this box is already installed.", code: "already_installed" },
      { status: 409 },
    );
  }
  if (!disk || !disk.ok) {
    engineInFlight = false;
    return diskRefusal(disk ?? (await checkInstallDisks(whisperEngineInstallParts())));
  }

  const start = startBackgroundTask({
    kind: WHISPER_ENGINE_INSTALL_KIND,
    group: WHISPER_ENGINE_GROUP,
    title: "Installing speech (Whisper)",
    status: "Installing speech on this box (faster-whisper)…",
    steps: [
      { id: "install", label: "Build faster-whisper and fetch the base model", weight: 9 },
      { id: "wire", label: "Switch voice notes to it", weight: 1 },
    ],
    async run(task) {
      try {
        task.step("install");
        // Through the task, so a web server that restarts mid-build follows
        // the same unit again. What it then cannot do is the wiring below —
        // which the next start's channel-audio pass does anyway, the same
        // promise the line below makes when the wiring fails.
        const result = await task.rootStep("voice_whisper_install", {
          timeoutMs: ENGINE_INSTALL_TIMEOUT_MS,
          label: "the speech install",
          finishes: { status: "Speech on this box is installed. Voice notes switch to it at the next restart." },
        });
        if (!result.ok) throw new BackgroundTaskFailure(result.error || "The speech install did not finish.");
        task.step("wire");
        const wired = await wireLocalTranscription();
        if (!wired) {
          task.status("Channel voice notes could not be switched to it yet — they will be at the next restart.");
        }
        return { status: "Speech on this box is installed." };
      } finally {
        engineInFlight = false;
      }
    },
  });
  if (!start.started) {
    // Not reachable while the flag above is held, but a task that never ran
    // would never give it back.
    engineInFlight = false;
    return backgroundTaskResponse(start.running.id);
  }
  return backgroundTaskResponse(start.task.id);
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
    // The same reservation as the install, for the whole removal: an install
    // or a second removal started now would write into what this deletes.
    engineInFlight = true;
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
      engineInFlight = false;
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
  if (inFlight || engineInFlight) {
    return NextResponse.json({ error: "Speech on this box is being installed or changed right now.", code: "busy" }, { status: 409 });
  }
  engineInFlight = true;
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
    engineInFlight = false;
  }
}

/**
 * Run the fetcher and report what it said.
 *
 * Its own process group, so a timeout ends the download rather than orphaning a
 * multi-hundred-megabyte transfer; stderr is the reason a person reads, kept to
 * its last line so a Python traceback does not become the row's copy.
 *
 * The web server's environment plus the whisper-server unit's library path:
 * `libctranslate2.so.4` lives in ~/.local/lib, which the loader does not
 * search, and without it the fetcher's `import faster_whisper` fails on every
 * box whose engine is install-voice.sh's CUDA build — every Jetson (see
 * `withWhisperLibraryPath`).
 */
function runFetch(
  size: string,
  onStatus: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/python3", [whisperFetchScript(CONFIG_ROOT), size], {
      cwd: path.dirname(whisperFetchScript(CONFIG_ROOT)),
      env: withWhisperLibraryPath(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let settled = false;
    let stderr = "";
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ }
    };
    const finish = (outcome: { ok: boolean; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      killGroup("SIGKILL");
      finish({ ok: false, error: "The speech model download took too long and was stopped." });
    }, FETCH_TIMEOUT_MS);
    // The owner's Cancel. Settled only once the group has really exited (its
    // `close`), so the caller's cleanup never races a fetcher still writing
    // into the cache; SIGKILL if it has not gone after the grace.
    function onAbort() {
      if (settled) return;
      cancelled = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), CANCEL_GRACE_MS);
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

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
    child.on("error", () => finish({ ok: false, error: "Could not start the speech model download.", cancelled }));
    child.on("close", (code) => {
      if (cancelled) return finish({ ok: false, cancelled: true, error: "The download was cancelled." });
      if (code === 0) return finish({ ok: true });
      const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      finish({ ok: false, error: lines.at(-1) || `The speech model download failed (exit ${code}).` });
    });
  });
}

/**
 * The install's half of the bookkeeping {@link releaseLocalTranscription} does
 * for a removal: put the engine that just landed into the audio list channel
 * voice notes walk. Nothing did — the install built the engine, enabled the
 * unit and answered "installed", and Telegram voice notes went on trying only
 * the cloud row, which on a box whose ClawBox AI credential no longer backs it
 * meant no transcript at all, with Whisper running beside it (found on a real
 * box).
 *
 * `freshProbe`, because the panel asked whether faster-whisper imports before
 * the install began and the "missing" it cached is still good for a minute.
 * Whether the engine goes first is the preference's call (stt-preference.ts):
 * on a box with no stored pick, or no ClawBox AI credential, it does. No
 * restart — see `reconcileChannelAudio`. Answers false when the write failed;
 * the boot pass puts it right at the next start.
 */
async function wireLocalTranscription(): Promise<boolean> {
  try {
    await reconcileChannelAudio({ trigger: "whisper-install", freshProbe: true });
    return true;
  } catch (err) {
    console.warn("[setup-api/whisper] could not add the installed engine to channel voice notes:", err);
    return false;
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
