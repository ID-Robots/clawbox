import { spawn } from "child_process";
import path from "./runtime-path";
import {
  BackgroundTaskCancelled,
  BackgroundTaskFailure,
  type StartBackgroundTaskSpec,
} from "./background-tasks";
import { WHISPER_ENGINE_INSTALL_KIND, WHISPER_SIZE_DOWNLOAD_KIND } from "./background-task-kinds";
import { CONFIG_ROOT } from "./config-store";
import { checkInstallDisk, checkInstallDisks, dirBytes, DISK_FULL_MESSAGE, diskFullPayload } from "./install-disk";
import { whisperSize } from "./local-install";
import {
  LOCAL_AI_SYSTEM_LANE,
  WHISPER_CACHE_LANE,
  WHISPER_ENGINE_INSTALL_NEEDS,
  whisperSizeNeeds,
} from "./local-ai-install-queue";
import { reconcileChannelAudio } from "./stt-channel";
import { withWhisperLibraryPath } from "./stt-local";
import {
  readWhisperState,
  removeWhisperSize,
  restartWhisper,
  setActiveWhisperSize,
  whisperCacheDir,
  whisperFetchScript,
} from "./whisper-models";

/**
 * Speech-to-text's two installs as background tasks: the ENGINE (POST
 * /setup-api/whisper {action: "install-engine"}) and one SIZE (POST
 * /setup-api/whisper {size}). The route starts them; a restarted server that
 * finds one still queued rebuilds it from here (src/lib/background-task-
 * starters.ts) — a route file may export only its handlers.
 *
 * SERVER ONLY.
 */

/** The engine install's group: a second press follows the one running or queued. */
export const WHISPER_ENGINE_GROUP = "whisper-engine";

/**
 * One size's group. Per size, so a second press of the SAME size follows its
 * download, while another size is a download of its own that waits its turn
 * (WHISPER_CACHE_LANE) instead of being refused.
 */
export function whisperSizeGroup(size: string): string {
  return `whisper-size:${size}`;
}

/** A `medium` fetch on a slow link is tens of minutes; the client may leave, the child may not be killed for it. */
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;
/** How often the cache directory is re-measured for the bar. */
const PROGRESS_POLL_MS = 1500;
/** After a Cancel's SIGTERM, how long the fetcher's group has before SIGKILL. */
const CANCEL_GRACE_MS = 3000;
/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this follow, owns the kill — the rule the Kokoro install
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
export function whisperEngineInstallParts() {
  return [
    { dir: "/tmp/CTranslate2-build", bytes: 2048 * MIB },
    { dir: path.join(INSTALLER_HOME, ".local"), bytes: 768 * MIB },
    { dir: path.join(INSTALLER_HOME, ".cache", "huggingface", "hub"), bytes: 256 * MIB },
  ];
}

export const WHISPER_ENGINE_INSTALLED_STATUS = "Speech on this box is installed.";

/**
 * The engine itself: install.sh's `voice_whisper_install` root step —
 * faster-whisper, the CTranslate2 CUDA build and the `base` weights — then the
 * channel voice notes switched to it.
 */
export function whisperEngineInstallTask(): StartBackgroundTaskSpec {
  return {
    kind: WHISPER_ENGINE_INSTALL_KIND,
    group: WHISPER_ENGINE_GROUP,
    title: "Installing speech (Whisper)",
    label: "Whisper",
    status: "Installing speech on this box (faster-whisper)…",
    steps: [
      { id: "install", label: "Build faster-whisper and fetch the base model", weight: 9 },
      { id: "wire", label: "Switch voice notes to it", weight: 1 },
    ],
    lanes: [LOCAL_AI_SYSTEM_LANE, WHISPER_CACHE_LANE],
    needs: WHISPER_ENGINE_INSTALL_NEEDS,
    async run(task) {
      task.step("install");
      // Measured again when it waited its turn: the install before it may
      // have spent the disk the button's own check found free.
      if (task.waited) {
        const disk = await checkInstallDisks(whisperEngineInstallParts());
        if (!disk.ok) throw new BackgroundTaskFailure(DISK_FULL_MESSAGE, diskFullPayload(disk));
      }
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
      return { status: WHISPER_ENGINE_INSTALLED_STATUS };
    },
  };
}

/**
 * One size: fetch the weights (when they are not here yet), point the unit at
 * them, restart the engine. `already`: the weights are cached, so only the
 * switch is left — read from the box when the task is built.
 */
export function whisperSizeDownloadTask(size: string, already: boolean): StartBackgroundTaskSpec {
  const total = whisperSize(size)?.bytes ?? 0;
  return {
    kind: WHISPER_SIZE_DOWNLOAD_KIND,
    group: whisperSizeGroup(size),
    title: `Downloading the ${size} speech model`,
    label: `Whisper ${size}`,
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
    lanes: [WHISPER_CACHE_LANE],
    needs: whisperSizeNeeds(already ? 0 : total, whisperCacheDir(size)),
    async run(task) {
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        if (!already) {
          task.step("fetch");
          // Again when it waited its turn: the download before it may have
          // spent the room the button's own check found free.
          if (task.waited) {
            const disk = await checkInstallDisk(whisperCacheDir(size), total);
            if (!disk.ok) throw new BackgroundTaskFailure(DISK_FULL_MESSAGE, diskFullPayload(disk));
          }
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
            throw new BackgroundTaskCancelled("The download was cancelled.");
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

        // Seconds, and not to be stopped half-way: a failure here is said as
        // what it is, never as the owner's Cancel.
        task.cancellable(false);
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
      }
    },
  };
}

/** {@link whisperSizeDownloadTask} with `already` read off the box now. */
export async function whisperSizeDownloadTaskNow(size: string): Promise<StartBackgroundTaskSpec> {
  const state = await readWhisperState();
  return whisperSizeDownloadTask(size, state.sizes.find((s) => s.id === size)?.cached === true);
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
 * The install's half of the bookkeeping the route's removal does: put the
 * engine that just landed into the audio list channel voice notes walk.
 * Nothing did — the install built the engine, enabled the unit and answered
 * "installed", and Telegram voice notes went on trying only the cloud row,
 * which on a box whose ClawBox AI credential no longer backs it meant no
 * transcript at all, with Whisper running beside it (found on a real box).
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
