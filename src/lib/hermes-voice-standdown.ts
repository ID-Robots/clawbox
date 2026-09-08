import fs from "fs/promises";
import path from "path";
import { hermesHome } from "@/lib/hermes-env";

function stampPath(): string {
  return `${path.join(hermesHome(), "config.yaml")}.clawbox-voice-standdown.json`;
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
