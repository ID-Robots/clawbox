import path, { untraced } from "./runtime-path";
import fs from "fs/promises";
import { randomBytes } from "crypto";
import { DATA_DIR } from "./config-store";
import { sanitizeDesktopState, type DesktopState } from "./desktop-state";

// Each ClawBox user's open windows (TASK-1306), one file per user under
// data/desktop-state/: the desktop page writes it as windows move and reads it
// back on a refresh — in this browser or any other the user signs in from.
// Per user, not box-wide like the preferences, because a multi-user box
// (TASK-1256) must never show one user another's windows or hand them the ids
// of another's terminal sessions.

const STATE_DIR = path.join(DATA_DIR, "desktop-state");

/**
 * The file a user's state lives in. The name is REBUILT from an alphabet that
 * cannot leave the directory rather than tested and passed through: every
 * character outside [a-z0-9_-] (a capital in the install user's name, a dot) is
 * spelled `~<hex>`, and `~` is itself outside the alphabet, so two names never
 * share a file.
 */
export function desktopStateFile(username: string): string {
  const safe = Array.from(username.slice(0, 64))
    .map((ch) => (/^[a-z0-9_-]$/.test(ch) ? ch : `~${ch.codePointAt(0)!.toString(16)}`))
    .join("");
  return path.join(STATE_DIR, `${safe || "~"}.json`);
}

/** The user's saved state, or null when there is none (or it cannot be read as one). */
export async function readDesktopState(username: string): Promise<DesktopState | null> {
  let text: string;
  try {
    text = await fs.readFile(desktopStateFile(username), "utf-8");
  } catch {
    return null;
  }
  try {
    return sanitizeDesktopState(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Replace the user's saved state — atomically, readable by the web server's account only. */
export async function writeDesktopState(username: string, state: DesktopState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = desktopStateFile(username);
  // A name of its own per write: two tabs saving at once must not rename one
  // another's half-written file into place.
  const tmp = untraced(`${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Forget a user's windows — they were removed from the box. */
export async function removeDesktopState(username: string): Promise<void> {
  await fs.rm(desktopStateFile(username), { force: true });
}
