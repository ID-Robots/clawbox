/**
 * The owner's project folder: where a Store app is installed, where a run's
 * folder name is looked up, where the Coding Agent lists projects.
 *
 * ONE answer for every reader. The owner chooses it in the Coding Agent's
 * settings; until they do, it is ~/Projects in the box owner's home — a
 * DEFAULT in force, not a suggestion. A fresh box (or one just factory reset)
 * used to have no folder at all, and installing a server app from the Store
 * was refused with "set a project folder first", a step nobody had told the
 * owner about.
 *
 * The default is never written to the config store: an absent key reads as
 * the default, so a folder the owner chose is never overwritten by it, and
 * clearing the setting is simply going back to it.
 *
 * Pure apart from `ensureProjectFolder`, and free of coding-agent.ts, so the
 * app proxy (which coding-agent.ts imports) reads the same answer.
 * scripts/app-port.js mirrors `projectFolderFrom` for production-server.js.
 */
import fs from "fs";
import os from "os";
import path from "@/lib/runtime-path";

/** The config key the owner's choice is stored under. */
export const PROJECT_FOLDER_CONFIG_KEY = "coding_agent_default_directory";

/** The folder in force when the owner has not chosen one: ~/Projects. */
export function defaultProjectFolder(): string {
  return path.join(os.homedir(), "Projects");
}

/**
 * The folder the owner chose, or null when they have not: an absent key, an
 * empty one, or a value that is not an absolute path (only a hand-edited
 * config.json holds one — setDefaultDirectory stores resolved paths — and a
 * relative base would be resolved against wherever the server happens to run).
 */
export function chosenProjectFolderFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && path.isAbsolute(value) ? value : null;
}

/** The folder in force: the owner's choice, else the default. */
export function projectFolderFrom(raw: unknown): string {
  return chosenProjectFolderFrom(raw) ?? defaultProjectFolder();
}

/**
 * Make the DEFAULT folder real on disk, owned by the box owner: called at
 * boot and before anything is put into it (a Store install, an import).
 *
 * Only ever the default. A folder the owner chose and then removed is their
 * business, and is answered "does not exist" where it is used, as before.
 * `recursive` makes an existing folder a no-op. 0755 like any folder the
 * owner makes; when the server runs as root (a dev setup, never the box's
 * `clawbox` service) the new folder is handed to the home's owner so the
 * owner's own tools can write into it.
 */
export async function ensureDefaultProjectFolder(): Promise<string> {
  const folder = defaultProjectFolder();
  const created = await fs.promises.mkdir(folder, { recursive: true, mode: 0o755 }).catch(() => undefined);
  if (created && typeof process.getuid === "function" && process.getuid() === 0) {
    const home = await fs.promises.stat(os.homedir()).catch(() => null);
    if (home && home.uid !== 0) await fs.promises.chown(folder, home.uid, home.gid).catch(() => undefined);
  }
  return folder;
}
