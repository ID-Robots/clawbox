/**
 * The speech-to-text size the box transcribes with, and the weights behind it.
 *
 * Whisper arrives on every box as `base` — install.sh's blessed size, 148 MB,
 * the one thing about the STT engine nobody chooses. The owner's decision of
 * 2026-09-14 is that the other sizes are a click away, so this is the half of
 * that which touches the device: which sizes are cached, which one the unit is
 * pointed at, how to point it somewhere else, and how to take a size back off
 * the disk.
 *
 * NO ROOT STEP. Both things that have to change are the clawbox account's own —
 * the user unit under `~/.config/systemd/user` and the Hugging Face cache under
 * `~/.cache/huggingface` — so the web server writes them directly. Adding a
 * passwordless root entrypoint for a file this account already owns would be a
 * privilege decision made for nothing (see src/lib/root-steps.ts).
 *
 * SERVER ONLY: fs and systemctl.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { safeWhisperSize, WHISPER_SIZES, type WhisperSize } from "@/lib/local-install";
import { readUnitState, reloadAndRestartUserEngine, SYSTEMD_USER_DIR, WHISPER_UNIT } from "@/lib/local-models";

const HOME = process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox";

/** The unit `scripts/install-voice.sh::write_whisper_unit` writes. */
export const WHISPER_UNIT_PATH = path.join(SYSTEMD_USER_DIR, WHISPER_UNIT);

/**
 * Where `faster_whisper.utils.download_model` puts a size's weights.
 *
 * The name is taken from the CATALOGUE rather than from the argument, so this
 * function cannot build a path out of a caller's string even when one reaches
 * it — the `safeAppId` rule, applied at the place that joins. A size nobody
 * offers has no directory here, and the callers read that as "not cached".
 */
export function whisperCacheDir(requested: string): string {
  const size = safeWhisperSize(requested) ?? "";
  return path.join(HOME, ".cache/huggingface/hub", `models--Systran--faster-whisper-${size}`);
}

/** The fetcher the install route spawns; a file, so no size is ever interpolated into code. */
export function whisperFetchScript(projectRoot: string): string {
  return path.join(projectRoot, "scripts", "fetch-whisper-model.py");
}

/** The size the unit is pointed at — `base` when the unit says nothing, as the server itself defaults. */
const MODEL_LINE = /^Environment=WHISPER_MODEL=(.*)$/m;

export interface WhisperState {
  /** The unit file exists at all: Whisper is installed on this box. */
  installed: boolean;
  running: boolean;
  /** The size the unit will load, or null when there is no unit to read. */
  active: string | null;
  /** Every offered size, with whether its weights are already here. */
  sizes: { id: string; bytes: number; cached: boolean }[];
}

/**
 * Are a size's weights on this box, WHOLE?
 *
 * The same judgement `whisper_model_cached` in install-voice.sh makes, and for
 * the same reason: a cache with `model.bin` and no tokenizer passes a naive
 * existence check and then pays for the missing file at the first
 * transcription. A snapshot entry is a SYMLINK into `blobs/`, so every check
 * has to follow it — a dangling link is the shape an interrupted download
 * leaves, and `fs.stat` (which follows) rejects on one where `lstat` would not.
 */
async function sizeCached(size: string): Promise<boolean> {
  const snapshots = path.join(whisperCacheDir(size), "snapshots");
  let revisions: string[];
  try {
    revisions = await fs.readdir(snapshots);
  } catch {
    return false;
  }
  for (const revision of revisions) {
    const dir = path.join(snapshots, revision);
    const whole = await Promise.all(
      ["config.json", "model.bin", "tokenizer.json"].map(async (artifact) => {
        try {
          const st = await fs.stat(path.join(dir, artifact));
          return st.isFile() && st.size > 0;
        } catch {
          return false;
        }
      }),
    );
    if (whole.every(Boolean)) return true;
  }
  return false;
}

/** The size named in the unit file, or null when there is no readable unit. */
export async function readActiveWhisperSize(): Promise<string | null> {
  let unit: string;
  try {
    unit = await fs.readFile(WHISPER_UNIT_PATH, "utf-8");
  } catch {
    return null;
  }
  const named = MODEL_LINE.exec(unit)?.[1]?.trim();
  // A unit with no Environment line loads whatever scripts/whisper-server.py
  // defaults to, which is `base`. Saying null there would draw a picker with
  // nothing selected over a box that is transcribing perfectly well.
  if (!named) return "base";
  // Reported as it stands even when it is not one of the four offered here: a
  // box whose unit was edited by hand is transcribing with THAT, and a picker
  // that quietly claimed otherwise would be wrong about the thing it exists to
  // say. The picker draws no selection for it and the owner can pick one.
  return named;
}

export async function readWhisperState(): Promise<WhisperState> {
  const [unit, active, cached] = await Promise.all([
    readUnitState(WHISPER_UNIT, "user").catch(() => null),
    readActiveWhisperSize(),
    Promise.all(WHISPER_SIZES.map(async (s) => [s.id, await sizeCached(s.id)] as const)),
  ]);
  const cachedBy = new Map(cached);
  return {
    installed: !!unit?.present,
    running: !!unit?.active,
    active,
    sizes: WHISPER_SIZES.map((s: WhisperSize) => ({
      id: s.id,
      bytes: s.bytes,
      cached: cachedBy.get(s.id) === true,
    })),
  };
}

/**
 * Point the unit at `size`.
 *
 * The whole file is rewritten from what was read, with only the one line
 * replaced (or added, for a unit that predates the Environment line) — never
 * regenerated from a template here, because `install-voice.sh` owns that
 * template and two writers of one unit file is how a box ends up with an
 * LD_LIBRARY_PATH nobody meant to change.
 *
 * tmp+rename in the same directory, so a reader never sees a half-written unit.
 */
export async function setActiveWhisperSize(requested: string): Promise<{ ok: boolean; error?: string }> {
  const size = safeWhisperSize(requested);
  if (size === null) return { ok: false, error: "Unknown Whisper size." };
  let unit: string;
  try {
    unit = await fs.readFile(WHISPER_UNIT_PATH, "utf-8");
  } catch {
    return { ok: false, error: "Whisper is not installed on this box." };
  }
  const line = `Environment=WHISPER_MODEL=${size}`;
  const next = MODEL_LINE.test(unit)
    ? unit.replace(MODEL_LINE, line)
    : unit.replace(/^\[Service\]$/m, `[Service]\n${line}`);
  if (!next.includes(line)) return { ok: false, error: "Could not read the Whisper service file." };
  const tmp = `${WHISPER_UNIT_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, next, { encoding: "utf-8", mode: 0o644 });
    await fs.rename(tmp, WHISPER_UNIT_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : "Could not write the Whisper service file." };
  }
  return { ok: true };
}

/** Bounce the engine so the new size is what the next transcription loads. */
export async function restartWhisper(): Promise<{ ok: boolean; error?: string }> {
  return reloadAndRestartUserEngine(WHISPER_UNIT);
}

/**
 * Take a size's weights off the disk.
 *
 * Refused for the ACTIVE size: the next transcription would download it again
 * inside somebody's request, which is the cost the whole pre-download exists to
 * avoid. Rebuilt from the alphabet rather than tested and passed through —
 * `whisperCacheDir` builds a path, and `isWhisperSize` is what makes that path
 * one of four literals.
 */
export async function removeWhisperSize(requested: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  const size = safeWhisperSize(requested);
  if (size === null) return { ok: false, error: "Unknown Whisper size.", code: "invalid" };
  const active = await readActiveWhisperSize();
  if (active === size) {
    return { ok: false, error: "That is the size this box transcribes with. Pick another one first.", code: "in_use" };
  }
  try {
    await fs.rm(whisperCacheDir(size), { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not remove those weights.", code: "remove_failed" };
  }
  return { ok: true };
}
