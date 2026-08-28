/**
 * Where the voice-output selection lives.
 *
 * `messages.tts.provider` records which engine speaks, but it cannot record
 * that the customer asked for "Auto": Auto and an explicit pick can resolve to
 * the same provider, and only one of them should move when the box changes. So
 * the choice is kept beside the setup app's own state, and openclaw.json stays
 * the single truth for what is actually configured.
 *
 * The per-engine check memory rides along in the same file: it is a record of
 * what this box observed, not configuration, and losing it costs nothing worse
 * than an "unproven" badge until the next check.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { isLocalVoice, isVoiceLanguage } from "@/lib/voice-catalog";
import {
  DEFAULT_VOICE_STATE,
  isVoiceChoice,
  normalizeProviderId,
  type VoiceAttempt,
  type VoiceCheck,
  VOICE_ENGINE_IDS,
  type VoiceEngineId,
  type VoiceOutputState,
} from "@/lib/voice-output";

export const VOICE_STATE_PATH = path.join(DATA_DIR, "voice-output.json");

const ENGINE_IDS = VOICE_ENGINE_IDS;

function readAttempt(value: unknown): VoiceAttempt | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const providerId = normalizeProviderId(raw.providerId);
  if (!providerId) return null;
  const engine = ENGINE_IDS.includes(raw.engine as VoiceEngineId)
    ? raw.engine as VoiceEngineId
    : null;
  return {
    providerId,
    engine,
    ok: raw.ok === true,
    message: typeof raw.message === "string" ? raw.message : null,
    latencyMs: typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs)
      ? raw.latencyMs
      : null,
  };
}

function readCheck(value: unknown): VoiceCheck | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null;
  if (at === null) return null;
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.map(readAttempt).filter((a): a is VoiceAttempt => a !== null)
    : [];
  return {
    at,
    ok: raw.ok === true,
    servedByProviderId: normalizeProviderId(raw.servedByProviderId),
    servedEngine: ENGINE_IDS.includes(raw.servedEngine as VoiceEngineId)
      ? raw.servedEngine as VoiceEngineId
      : null,
    attempts,
    message: typeof raw.message === "string" ? raw.message : null,
  };
}

/**
 * Never throws and never returns a half-read shape: a corrupt or truncated
 * state file must cost the customer an "unproven" badge, not the Voice panel.
 * Every field is validated the way it will be read, because a guard that
 * checks the envelope and lets an entry through is the mistake that took the
 * whole ClawKeep window down on TASK-398.
 */
export async function readVoiceState(): Promise<VoiceOutputState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(VOICE_STATE_PATH, "utf8"));
  } catch {
    return { ...DEFAULT_VOICE_STATE, engineChecks: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_VOICE_STATE, engineChecks: {} };
  }
  const raw = parsed as Record<string, unknown>;
  const engineChecks: VoiceOutputState["engineChecks"] = {};
  const rawChecks = raw.engineChecks;
  if (rawChecks && typeof rawChecks === "object") {
    for (const engine of ENGINE_IDS) {
      const entry = (rawChecks as Record<string, unknown>)[engine];
      const attempt = readAttempt(entry);
      const at = (entry as { at?: unknown })?.at;
      if (attempt && typeof at === "number" && Number.isFinite(at)) {
        engineChecks[engine] = { ...attempt, at };
      }
    }
  }
  return {
    choice: isVoiceChoice(raw.choice) ? raw.choice : DEFAULT_VOICE_STATE.choice,
    engineChecks,
    lastCheck: readCheck(raw.lastCheck),
    language: isVoiceLanguage(raw.language) ? raw.language : DEFAULT_VOICE_STATE.language,
  };
}

/**
 * The on-device voice lives where the local script reads it
 * (`clawbox-tts.sh --set-voice` writes the same file), so the gateway and this
 * tab can never disagree about which Kokoro voice speaks.
 */
export function localVoicePath(): string {
  return process.env.CLAWBOX_TTS_VOICE_FILE
    || path.join(process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox", ".openclaw", "clawbox-tts-voice");
}

/** The saved local voice, or null when none is saved or the file names an unknown one. */
export async function readLocalVoice(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(localVoicePath(), "utf8")).trim();
    return isLocalVoice(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The voice is written the way the state is, below: `clawbox-tts.sh` reads
 * this file on EVERY utterance, and a plain `writeFile` truncates before it
 * writes — a read in that window finds an empty file and speaks the default,
 * and an unplugged box could leave it that way.
 */
export async function writeLocalVoice(voice: string): Promise<void> {
  if (!isLocalVoice(voice)) throw new Error("Unknown local voice.");
  const target = localVoicePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomically(target, `${voice}\n`);
}

export async function writeVoiceState(state: VoiceOutputState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Atomic, like every other state file in data/: a half-written selection read
  // by the next request would look like a corrupt file and silently reset the
  // customer's choice to Auto.
  await writeFileAtomically(VOICE_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Write `contents` so a reader sees the old file or the new one, never a
 * truncated one, and so the swap cannot outlive its own bytes.
 *
 * rename() makes the swap atomic against a reader; it does not make the new
 * bytes durable. This runs on a Jetson that gets unplugged, and a rename that
 * outlives its own contents leaves a truncated file — which reads as corrupt
 * and silently resets the customer's choice, exactly the loss the atomic
 * write is here to prevent. So sync before swapping. 0600 because the state
 * is the box's own; the temp name is unique so two writers cannot share one.
 *
 * The rename itself is a write to the DIRECTORY, and it is durable only once
 * the directory is synced too: without that, a power cut can leave the old
 * name pointing at the old file — the write "succeeded" and was not there
 * after the reboot. Both writers here go through this one function.
 */
async function writeFileAtomically(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  try {
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDirectory(path.dirname(target));
}

/**
 * fsync a directory, so a rename inside it survives a power cut.
 *
 * Best effort by design: the file's bytes were already synced and swapped in,
 * so the one thing left to lose is the swap itself, and a filesystem that
 * refuses to fsync a directory (some FUSE and network mounts answer EINVAL,
 * EPERM or EISDIR; one without the concept answers ENOTSUP) is not a reason
 * to fail a write that has otherwise landed.
 */
const DIRECTORY_SYNC_REFUSALS = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP", "EBADF", "EACCES"]);

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(dir, "r");
  } catch (err) {
    // The same refusals a filesystem can give the sync itself are forgiven at
    // the open; anything else (ENOENT for a directory that just held a rename,
    // EIO, EMFILE) is an I/O failure the caller must hear about, or the
    // "durable" in this writer's contract would be a word.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (DIRECTORY_SYNC_REFUSALS.has(code)) return;
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!DIRECTORY_SYNC_REFUSALS.has(code)) throw err;
  } finally {
    await handle.close();
  }
}
