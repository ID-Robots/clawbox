// Server half of the remote-desktop resolution setting (see ./vnc-resolution
// for the presets and the storage design). Node-only: never import this from a
// client component.

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { normalizeVncResolution, type VncResolution } from "./vnc-resolution";

export function vncResolutionEnvPath(home: string = os.homedir()): string {
  return path.join(home, ".config", "clawbox", "vnc-resolution.env");
}

/**
 * Write the file scripts/start-vnc.sh reads. Atomic: each call writes its own
 * temp file beside the target (same directory, so the rename cannot cross a
 * filesystem) and renames it into place, so overlapping saves never share a
 * temp file. The temp file is removed if the write or the rename fails.
 */
export async function writeVncResolutionEnv(value: VncResolution, home?: string): Promise<void> {
  const file = vncResolutionEnvPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `CLAWBOX_VNC_RESOLUTION=${normalizeVncResolution(value)}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
