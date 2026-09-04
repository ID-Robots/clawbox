/**
 * The on-box speech-to-text engine: faster-whisper, driven through the
 * workspace's `stt-client.py`.
 *
 * WHY A SCRIPT AND NOT A LIBRARY. The client already exists for OpenClaw's
 * media-understanding surface (a `type: "cli"` entry in
 * `tools.media.models[]` runs it for every channel voice note), and it
 * owns the awkward parts: it starts the `whisper-server` user unit on demand
 * so the model stays loaded between calls, talks to it over a unix socket,
 * and falls back to an in-process decode when the server is not there. The
 * chat microphone reusing the same script means one engine, one set of
 * failure modes and one thing to install — the transcript is whatever the
 * script prints on stdout, exactly as OpenClaw reads it.
 *
 * SERVER ONLY: this spawns processes and writes temp files.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { failureDetail, runChild } from "@/lib/child-run";

/** The interpreter the user unit itself runs under; the script needs no venv. */
export const PYTHON3 = "/usr/bin/python3";

// Resolved per call rather than at import: the test suite re-points HOME at a
// sandbox before importing, and a constant captured at load time would keep
// probing the real box.
function home(): string {
  return process.env.HOME || "/home/clawbox";
}

/** Where install-voice.sh puts the client — the OpenClaw workspace, so the
 *  gateway's CLI entry and this module name the same file. */
export function sttClientScriptPath(): string {
  return path.join(home(), ".openclaw", "workspace", "scripts", "stt-client.py");
}

function whisperUnitPath(): string {
  return path.join(home(), ".config", "systemd", "user", "whisper-server.service");
}

// Matches the CLI entry's `timeoutSeconds`: a cold start loads the model
// (tens of seconds on a Nano) before a word is decoded, and a budget that
// fits only a warm server would fail every first call of the day.
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;
// Spawning python to import faster-whisper is a real cost on this board, and
// the settings panel and every chat-mic press both ask. ONLY that import is
// cached: the file checks below are two stat() calls and are asked every time.
// A successful import is held for hours; a failed one is re-asked every minute
// so an install shows up. A `pip uninstall` or a python minor-version bump does
// outlast the positive TTL — an accepted residual, and far rarer than the
// removed-script case the per-call file checks above close.
const IMPORT_MISSING_TTL_MS = 60_000;
const IMPORT_OK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Where the CUDA CTranslate2 build puts its shared library, and the CUDA
 * runtime beside it.
 *
 * `install-voice.sh` builds CTranslate2 with `-DCMAKE_INSTALL_PREFIX=~/.local`,
 * so `libctranslate2.so.4` lands somewhere the dynamic linker does not search:
 * `ldconfig -p` has no entry for it. `import faster_whisper` therefore fails
 * with "libctranslate2.so.4: cannot open shared object file" in any process
 * that does not name the directory itself.
 *
 * The whisper-server unit sets exactly this, which is why TRANSCRIPTION works.
 * The probe below did not, so Settings reported "faster-whisper is not
 * installed for python3" on a box where it was installed, working and serving
 * — measured on hardware 2026-09-04, minutes after the install succeeded.
 *
 * Kept identical to the unit's own Environment= line and to stt-client.py's
 * fallback, because three readers disagreeing about where the library lives is
 * how this went unnoticed in the first place.
 */
function ldLibraryPath(): string {
  const h = home();
  return [
    `${h}/.local/lib`,
    `${h}/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib`,
    "/usr/local/cuda/lib64",
  ].join(":");
}

/**
 * The whole environment the script gets. `systemctl --user` needs
 * XDG_RUNTIME_DIR to find the user bus — from a system service there is none
 * inherited, and without it every start attempt answers "Failed to connect"
 * and the client falls through to the slow in-process decode.
 *
 * LD_LIBRARY_PATH is here for the reason above: without it the import probe
 * cannot load the library the install just built, and answers "not installed"
 * about an engine that is running.
 */
function childEnv(): Record<string, string> {
  return {
    HOME: home(),
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
    LD_LIBRARY_PATH: ldLibraryPath(),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface LocalSttProbe {
  installed: boolean;
  /** One sentence for the settings panel: what is there, or what is missing. */
  detail: string;
}

let importCache: { at: number; ok: boolean } | null = null;

/** Can python3 import faster-whisper? The one expensive half, and the only
 *  half that is cached. */
async function fasterWhisperImports(): Promise<boolean> {
  const ttl = importCache?.ok ? IMPORT_OK_TTL_MS : IMPORT_MISSING_TTL_MS;
  if (importCache && Date.now() - importCache.at < ttl) return importCache.ok;
  const check = await runChild(PYTHON3, ["-c", "import faster_whisper"], {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: childEnv(),
    notStarted: "python3 could not be started",
  });
  const ok = check.code === 0;
  importCache = { at: Date.now(), ok };
  return ok;
}

/**
 * Whether this box can transcribe on its own.
 *
 * The two file checks are asked on EVERY call, and only the python import is
 * cached. Holding the whole answer for six hours meant an engine removed from
 * the box — by hand, from the Terminal or the agent's shell; nothing in the app
 * uninstalls it — still read as installed. Settings then offered "On this box"
 * as a working choice, and /setup-api/stt wrote a `type: "cli"` row into
 * openclaw.json for a script that is gone. OpenClaw takes such a row on trust —
 * `openclaw config set` accepts it and no doctor check inspects a configured CLI
 * entry — and then pays a failed exec for it on every channel voice note before
 * falling through to the cloud row behind it. The chat microphone runs the same
 * missing script and answers "Transcription failed on this box." whenever the
 * cloud leg cannot cover for it. Two stat() calls are what keeps this box from
 * advertising an engine it no longer has.
 */
export async function localSttInstalled(): Promise<LocalSttProbe> {
  // Cheapest checks first, so a box that never installed the engine answers
  // from two stat() calls and never spawns an interpreter.
  if (!(await exists(sttClientScriptPath()))) {
    return { installed: false, detail: "The on-box transcriber is not installed." };
  }
  if (!(await exists(whisperUnitPath()))) {
    return { installed: false, detail: "The whisper-server service is not installed." };
  }
  if (!(await fasterWhisperImports())) {
    return { installed: false, detail: "faster-whisper is not installed for python3." };
  }
  return { installed: true, detail: "faster-whisper, kept warm by whisper-server." };
}

/**
 * Only the extension survives from the caller's filename. faster-whisper
 * decodes by content, but the container hint helps PyAV pick a demuxer, and
 * nothing else about a browser-supplied name belongs in a path we create.
 */
function tempFileName(filename: string): string {
  const ext = path.extname(filename);
  return `recording${/^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : ".webm"}`;
}

/**
 * Transcribe one recording on this box. Never throws: a missing script, a
 * killed child or a full /tmp all come back as `{ ok: false }`, because the
 * caller is a fallback chain and must move on rather than blow up.
 *
 * The audio goes through a private temp file (0700 dir, 0600 file) because the
 * script — and the server behind it — take a path, not bytes. It is removed
 * whatever happens: a box that keeps one recording per failed call fills its
 * own disk with other people's voices.
 */
export async function transcribeLocally(
  audioBytes: Buffer,
  filename: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-stt-"));
    const file = path.join(dir, tempFileName(filename));
    await fs.writeFile(file, audioBytes, { mode: 0o600 });
    const result = await runChild(PYTHON3, [sttClientScriptPath(), file], {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      env: childEnv(),
      notStarted: "python3 could not be started",
    });
    if (result.code !== 0) {
      return { ok: false, error: failureDetail(result, "On-box transcription") };
    }
    // stdout is the transcript and nothing else; the script keeps its
    // diagnostics ("falling back to direct") on stderr for exactly this reason.
    return { ok: true, text: result.stdout.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
