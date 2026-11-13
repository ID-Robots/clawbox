import fs from "fs/promises";
import path, { untraced } from "@/lib/runtime-path";
import { hermesHome } from "@/lib/hermes-env";

function stampPath(): string {
  return untraced(`${path.join(hermesHome(), "config.yaml")}.clawbox-voice-standdown.json`);
}

/** Contains selection history only, never the cloud credential. */
export async function readHermesVoiceStanddown(): Promise<{ cloudVoice?: string } | null> {
  try {
    const stamp = JSON.parse(await fs.readFile(stampPath(), "utf8"));
    if (stamp.version !== 1 || stamp.provider !== "clawbox-local") return null;
    return { cloudVoice: typeof stamp.cloudVoice === "string" ? stamp.cloudVoice : undefined };
  } catch { return null; }
}

/** An explicit Voice-panel choice cancels automatic restoration, even if local was selected again. */
export async function clearHermesVoiceStanddown(): Promise<void> {
  await fs.unlink(stampPath()).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/**
 * Remember, before the local-only AI lock moves Hermes off ClawBox AI's cloud
 * voice (TASK-2501), that it was on it — the stand-down the boot plan
 * (`register-mcp.sh` §4a) writes for a plan that no longer covers the voice,
 * so the same restore brings it back once the lock is lifted. Never a
 * credential: the voice name at most.
 */
export async function rememberHermesVoiceStanddown(cloudVoice: string | null): Promise<void> {
  await writeAtomically(stampPath(), { version: 1, provider: "clawbox-local", ...(cloudVoice ? { cloudVoice } : {}) });
}

function lockMarkerPath(): string {
  return untraced(`${path.join(hermesHome(), "config.yaml")}.clawbox-voice-lock.json`);
}

/**
 * Remember an owner's own voice (a provider NAME, never a credential) that the
 * local-only AI lock moved Hermes off, so lifting the lock gives it back —
 * the marker the boot plan's `unlock` verdict reads (`register-mcp.sh`).
 */
export async function rememberHermesVoiceLock(provider: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(provider)) return;
  await writeAtomically(lockMarkerPath(), { version: 1, provider });
}

async function writeAtomically(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, target);
}
