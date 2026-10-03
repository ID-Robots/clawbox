import path from "@/lib/runtime-path";
import fsp from "fs/promises";
import { getActiveHarness } from "@/lib/harness";
import { OPENCLAW_HOME } from "@/lib/openclaw-config";
import { DATA_DIR } from "@/lib/config-store";

/**
 * Where chat's files live on THIS box — attachments on the way in, generated
 * pictures on the way out. SERVER ONLY.
 *
 * Both `chat/attachments` and `chat/media` used to hardcode
 * `OPENCLAW_HOME/media`, and on a Hermes SKU that is a directory the box does
 * not have: `~/.openclaw` there holds `openclaw.json` and nothing else
 * (verified on the live box, 2026-08-22). So staging wrote into a tree the
 * reader then could not find, and the reader was rooted on a tree nothing wrote
 * into. One resolved root fixes both ends.
 *
 * On OpenClaw the answer is byte-identical to the constant it replaces, which
 * is the point: this must be a no-op there. The OpenClaw path is not just a
 * convention either — the harness maintains a fixed allowlist of media roots
 * (`buildMediaLocalRoots`) and `<stateDir>/media` is on it, so a staged file
 * anywhere else gets "Local media path is not under an allowed directory" from
 * the agent's own image tool. Hermes has no such allowlist (it opens any
 * readable absolute path), which is exactly why its files may live beside the
 * rest of the app's data instead.
 */

/** The `media` subtree, per edition. Callers name their own subdirectory in it. */
export async function chatMediaRoot(): Promise<string> {
  const harness = await getActiveHarness();
  return harness === "hermes"
    ? path.join(DATA_DIR, "chat-media")
    : path.join(OPENCLAW_HOME, "media");
}

/** Where an uploaded attachment is staged. */
export async function chatAttachmentDir(): Promise<string> {
  return path.join(await chatMediaRoot(), "chat-attachments");
}

/** Where a picture this box generated is written. */
export async function chatGeneratedImageDir(): Promise<string> {
  return path.join(await chatMediaRoot(), "chat-generated");
}

/** Where a reply this box spoke aloud is written. */
export async function chatSpokenReplyDir(): Promise<string> {
  return path.join(await chatMediaRoot(), "chat-spoken");
}

/**
 * How long a spoken reply is kept.
 *
 * The same 30 days as a picture, for the same reason — the clip and the bubble
 * naming it must age out together — but a much smaller cap: a clip is a few
 * seconds of WAV, every reply can have one, and they are re-playable rather
 * than precious. 100 MB is thousands of them and still bounded on a device
 * whose disk is shared with the models.
 */
export const SPOKEN_REPLY_RETENTION: MediaRetention = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxBytes: 100 * 1024 * 1024,
};

/**
 * How long a generated picture is kept, for whichever path drew it.
 *
 * ONE set of numbers because there is one directory: the composer writes its
 * own generation into `chat-generated` and the agent path copies its own in
 * beside it, so a retention that lived with only one of them would leave the
 * tree unbounded the moment the other became the box's way of drawing.
 *
 * 30 days matches the transcript sweep, so a picture and the bubble naming it
 * age out together instead of leaving a transcript full of broken thumbnails;
 * 500 MB is roughly 350 pictures at the size the proxy returns.
 */
export const GENERATED_IMAGE_RETENTION: MediaRetention = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxBytes: 500 * 1024 * 1024,
};

/**
 * Nothing this young is ever removed, whatever the totals say.
 *
 * A file being written by a concurrent request is the newest thing in the
 * directory, and deleting it out from under an in-flight write would hand the
 * caller back a path with nothing at it.
 */
const RETENTION_MIN_AGE_MS = 60 * 1000;

export interface MediaRetention {
  /** Anything older than this goes, regardless of how much room is left. */
  maxAgeMs: number;
  /** What age left behind is then trimmed oldest-first down to this. */
  maxBytes: number;
  /**
   * Sweep the directory's FOLDERS too, each as one item: its age is its
   * newest entry's, its size the whole tree's, and it goes whole. For the
   * attachment staging directory, where a folder dropped on the composer is
   * staged as a folder. Off for every other tree, whose folders are not ours.
   */
  folders?: boolean;
}

/** Entries one folder's measurement walks before it stops counting — a bound, not a policy. */
const MAX_FOLDER_WALK_ENTRIES = 100_000;

/**
 * A staged folder's bytes and its newest entry's mtime. Links are not
 * followed (lstat), so a link inside a folder can neither inflate it nor send
 * the walk out of the tree.
 */
async function measureFolder(dir: string, ownMtimeMs: number): Promise<{ size: number; newestMs: number }> {
  let size = 0;
  let newestMs = ownMtimeMs;
  let walked = 0;
  const stack = [dir];
  while (stack.length > 0 && walked < MAX_FOLDER_WALK_ENTRIES) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = await fsp.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++walked > MAX_FOLDER_WALK_ENTRIES) break;
      const full = path.join(current, name);
      let stat;
      try {
        stat = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) size += stat.size;
    }
  }
  return { size, newestMs };
}

async function removeItem(full: string, folder: boolean): Promise<void> {
  if (folder) await fsp.rm(full, { recursive: true, force: true });
  else await fsp.unlink(full);
}

/**
 * Drop files that are old, then oldest-first until the directory fits.
 *
 * Shared by both ends of the chat's media tree — staged uploads on the way in
 * and generated pictures on the way out — because the two need exactly this
 * policy with different numbers, and a second copy of it is a second place to
 * forget that a directory entry can vanish mid-sweep.
 *
 * BEST EFFORT BY CONSTRUCTION. It is called for its side effect before
 * something is written, and every failure — an unreadable entry, a file another
 * sweep already removed, a stat racing an unlink — is skipped rather than
 * raised. Directories (unless `retention.folders` says they are ours to
 * sweep) and anything else that is not a regular file are left untouched.
 */
export async function pruneMediaDir(dirReal: string, retention: MediaRetention): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirReal);
  } catch {
    return;
  }
  const now = Date.now();
  const kept: { path: string; mtimeMs: number; size: number; folder: boolean }[] = [];
  for (const name of entries) {
    const full = path.join(dirReal, name);
    let stat;
    try {
      stat = await fsp.lstat(full);
    } catch {
      continue;
    }
    const folder = stat.isDirectory() && retention.folders === true;
    if (!stat.isFile() && !folder) continue;
    // A folder still being filled is as young as its newest file, so a drop
    // that is uploading is never swept out from under itself.
    const { size, newestMs } = folder ? await measureFolder(full, stat.mtimeMs) : { size: stat.size, newestMs: stat.mtimeMs };
    const age = now - newestMs;
    if (age < RETENTION_MIN_AGE_MS) continue;
    if (age > retention.maxAgeMs) {
      try { await removeItem(full, folder); } catch { /* raced another sweep */ }
      continue;
    }
    kept.push({ path: full, mtimeMs: newestMs, size, folder });
  }
  let total = kept.reduce((sum, f) => sum + f.size, 0);
  if (total <= retention.maxBytes) return;
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of kept) {
    if (total <= retention.maxBytes) break;
    try {
      await removeItem(f.path, f.folder);
      total -= f.size;
    } catch { /* raced another sweep */ }
  }
}

/**
 * Resolve one caller-supplied path against the media root, or null.
 *
 * Used where a path is about to become an ARGV ELEMENT for the Hermes CLI. No
 * shell is involved, so this is not about injection; it is about the two things
 * that are still true of argv:
 *
 *   1. a value starting with "-" is read by the CLI as a FLAG, so a file named
 *      `--yolo` would be one;
 *   2. the agent opens any readable absolute path it is handed, so a path that
 *      escapes the staging tree hands it `~/.hermes/.env` — the file with every
 *      provider key in it — as a "picture" to look at and describe.
 *
 * The symlink resolution is what makes (2) hold: a lexical check alone passes a
 * link planted INSIDE the staging tree that points at the config (CWE-59).
 * Both the logical root and its realpath are accepted as the base, for the same
 * reason `chat/media` accepts both — a relocated tree gives one legitimate file
 * two spellings, and rejecting the logical one 404s every real read.
 */
export async function resolveInMediaRoot(candidate: string): Promise<string | null> {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  if (!path.isAbsolute(candidate)) return null;
  const root = await chatMediaRoot();
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    // No staging tree on this box yet, so nothing can be inside it.
    return null;
  }
  const resolved = path.resolve(candidate);
  const logicalRel = path.relative(root, resolved);
  const realRel = path.relative(realRoot, resolved);
  const rel = contained(logicalRel) ? logicalRel : contained(realRel) ? realRel : null;
  if (rel === null) return null;
  let real: string;
  try {
    real = await fsp.realpath(path.join(realRoot, rel));
  } catch {
    // A path that does not exist is a miss, not an error — and for the argv
    // case it MUST be: `hermes --image` on a missing file fails the whole turn,
    // and the path-in-prompt convention silently drops it.
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  // Rebuilt from the resolved root plus the segment just cleared, so what is
  // handed onward is constructed from trusted parts rather than carried down
  // from the request. A leading "-" cannot survive this: every result begins
  // with the absolute root.
  const cleared = path.relative(realRoot, real);
  if (!contained(cleared)) return null;
  const safe = path.join(realRoot, cleared);
  try {
    if (!(await fsp.stat(safe)).isFile()) return null;
  } catch {
    return null;
  }
  return safe;
}

function contained(rel: string): boolean {
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}
