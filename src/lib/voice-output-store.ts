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
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import {
  DEFAULT_VOICE_STATE,
  isVoiceChoice,
  normalizeProviderId,
  type VoiceAttempt,
  type VoiceCheck,
  type VoiceEngineId,
  type VoiceOutputState,
} from "@/lib/voice-output";

export const VOICE_STATE_PATH = path.join(DATA_DIR, "voice-output.json");

const ENGINE_IDS: VoiceEngineId[] = ["local", "cloud"];

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
      const signature = (entry as { signature?: unknown })?.signature;
      if (attempt && typeof at === "number" && Number.isFinite(at)) {
        engineChecks[engine] = {
          ...attempt,
          at,
          ...(typeof signature === "string" ? { signature } : {}),
        };
      }
    }
  }
  return {
    choice: isVoiceChoice(raw.choice) ? raw.choice : DEFAULT_VOICE_STATE.choice,
    engineChecks,
    lastCheck: readCheck(raw.lastCheck),
  };
}

export async function writeVoiceState(state: VoiceOutputState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Atomic, like every other state file in data/: a half-written selection read
  // by the next request would look like a corrupt file and silently reset the
  // customer's choice to Auto.
  const tmp = `${VOICE_STATE_PATH}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  try {
    // rename() makes the swap atomic against a reader; it does not make the new
    // bytes durable. This runs on a Jetson that gets unplugged, and a rename
    // that outlives its own contents leaves a truncated file — which reads as
    // corrupt and silently resets the customer's choice to Auto, exactly the
    // loss the atomic write is here to prevent. So sync before swapping.
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, VOICE_STATE_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
