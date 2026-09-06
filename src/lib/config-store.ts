import path from "path";
import fs from "fs";

/**
 * Where this ClawBox is installed, resolved AT CALL TIME.
 *
 * `CONFIG_ROOT` below is the same answer captured at import time, and it is
 * what almost everything should use. Call this instead only where the root can
 * still change after the module is loaded — the tests set `CLAWBOX_ROOT` in a
 * `beforeEach`, which a module-level constant never sees.
 *
 * NOT `process.cwd()` outside development: the production server chdirs into
 * `.next/standalone` (Next's standalone `server.js` does `process.chdir`), so
 * the cwd there is the build output, not the install.
 */
export function resolveConfigRoot(): string {
  return process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
}

export const CONFIG_ROOT = resolveConfigRoot();
export const DATA_DIR = path.join(CONFIG_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// Simple JSON file-based key-value store — works with both Node.js and Bun

function readConfig(): Record<string, unknown> {
  try {
    return readConfigStrict();
  } catch {
    return {};
  }
}

/**
 * The same read, without the swallow.
 *
 * `readConfig()` answers `{}` to a missing file, an EACCES, an EIO and a
 * half-written JSON alike, which is fine for the settings it was written for
 * and wrong for a caller deciding whether two bots collide: "we could not read
 * the file" is not evidence that a key is unset. Only an ABSENT file is that,
 * and only that case returns here — everything else throws, so the caller can
 * answer "we could not find out" instead of guessing.
 *
 * A file holding valid JSON that is not an object (`null`, a number, an array)
 * is a read failure too: `config[key]` on `null` throws a TypeError from
 * whichever route touched it next, which is a 500 with no explanation.
 */
function readConfigStrict(): Record<string, unknown> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("data/config.json does not hold a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** One key, tri-state: `known: false` when the store could not be read. */
export async function getKnown(key: string): Promise<{ value: unknown; known: boolean }> {
  try {
    return { value: readConfigStrict()[key], known: true };
  } catch (err) {
    // The message only: a JSON parse error quotes a window of the INPUT, and
    // this file holds the mailbox password and both bot tokens.
    console.error(
      "[config-store] data/config.json could not be read:",
      err instanceof Error ? err.message : err,
    );
    return { value: undefined, known: false };
  }
}

function writeConfig(data: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // config.json holds real secrets (clawai portal token, telegram bot token).
  // Write to a fresh temp file at 0o600 then atomically rename over the target,
  // so the live config is never briefly world-readable (writeFileSync's `mode`
  // is ignored when the destination already exists, e.g. a 0644 file from an
  // older build). chmod the temp too, in case a stale temp survived a crash
  // and pre-existed at 0644 (rename would then carry those perms across).
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break config writes
  }
  fs.renameSync(tmp, CONFIG_PATH);
}

export async function get(key: string): Promise<unknown> {
  const config = readConfig();
  return config[key];
}

/**
 * A write reads the whole store first, so it may NOT read it forgivingly.
 *
 * `writeConfig` temp-writes and renames, which needs write permission on
 * `data/` and not on the file — so building the new object out of `readConfig()`'s
 * `{}` succeeded on a store nobody could read and REPLACED it with the one key
 * being saved. A `data/config.json` left root-owned by a `sudo` script (the same
 * provenance this module's readers now refuse to guess about) would lose the
 * mailbox password, both bot tokens, the approved-sender names and the session
 * generation the next time the owner touched any setting — reported as
 * `success: true`, one `chmod` after they were all still there.
 *
 * So a write over an unreadable store throws. ENOENT still means `{}`: a box
 * that has never saved anything is the ordinary first write.
 */
export async function set(key: string, value: unknown): Promise<void> {
  const config = readConfigStrict();
  if (value === undefined) {
    delete config[key];
  } else {
    config[key] = value;
  }
  writeConfig(config);
}

/**
 * Set `key` and return what it held — read and written in ONE synchronous step.
 *
 * `get` then `set` is not the same thing. The `await` between them is a point
 * where another request can land its own write, and the caller then reasons
 * about a predecessor its call never actually replaced. Here the read and the
 * write are in the same event-loop turn, so no other caller IN THIS PROCESS can
 * land a config write between them. It says nothing about another process
 * writing the same file — the rename in `writeConfig` is what covers that.
 *
 * Replaces only. To delete a key, `set` it to `undefined`.
 *
 * Same strict read as `set`, for the same reason: a write over a store nobody
 * can read must throw rather than replace it with the one key being saved.
 */
export async function swap(key: string, value: unknown): Promise<unknown> {
  const config = readConfigStrict();
  const previous = config[key];
  config[key] = value;
  writeConfig(config);
  return previous;
}

export async function setMany(entries: Record<string, unknown>): Promise<void> {
  const config = readConfigStrict();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  }
  writeConfig(config);
}

export async function getAll(): Promise<Record<string, unknown>> {
  return readConfig();
}
