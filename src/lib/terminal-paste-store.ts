// Where a picture pasted into the Terminal is kept. Server-only.
//
// `~/.cache/clawbox/terminal-paste/`, beside the box's other per-user cache
// files — not `data/`, which a delegated coding run is denied wholesale, and
// not /tmp, where a name another local account can squat is the rule's own
// exception. The folder is the owner's alone (0700) and so is each file
// (0600): the shell that reads it is the owner's, and a non-owner's Terminal
// runs as a different account that could not read it — which is why the route
// in front of this is owner-only.
//
// The file name is this module's, never a caller's: a stamp and eight random
// hex digits, no space and no shell character, with the extension the BYTES
// earn. The path is about to be typed at a prompt.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "./runtime-path";
import { DISK_FREE_RESERVE_BYTES } from "./disk-reserve";
import {
  TERMINAL_PASTE_MAX_BYTES,
  sniffPastedImage,
  type PastedImageFormat,
  type TerminalPasteRefusal,
} from "./terminal-paste";

/** A pasted picture is kept this long: the program it was pasted into may read it again. */
export const TERMINAL_PASTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** …and the folder is trimmed, oldest first, to this. */
export const TERMINAL_PASTE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** Nothing this young is removed: a save in flight is the newest file there. */
const PRUNE_MIN_AGE_MS = 60 * 1000;

export class TerminalPasteError extends Error {
  constructor(
    public readonly code: TerminalPasteRefusal,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TerminalPasteError";
  }
}

export interface SavedPaste {
  /** Absolute. */
  path: string;
  name: string;
  size: number;
  format: PastedImageFormat;
}

export function terminalPasteDir(home = process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox"): string {
  return path.join(path.resolve(home), ".cache", "clawbox", "terminal-paste");
}

/**
 * A real directory, where it says it is, and this account's. The folder
 * replaced by a link would turn every paste into a write somewhere else.
 */
function folderIsSafe(dir: string): boolean {
  try {
    const stat = fs.lstatSync(/* turbopackIgnore: true */ dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    const realParent = fs.realpathSync(/* turbopackIgnore: true */ path.dirname(dir));
    return fs.realpathSync(/* turbopackIgnore: true */ dir) === path.join(realParent, path.basename(dir));
  } catch {
    return false;
  }
}

function ensureFolder(dir: string): void {
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new TerminalPasteError("unsafe_folder", "The folder for pasted pictures could not be created.", 500);
  }
  if (!folderIsSafe(dir)) {
    throw new TerminalPasteError("unsafe_folder", "The folder for pasted pictures is not a regular folder.", 409);
  }
  try {
    // An older folder, or a umask that widened it: the owner's alone.
    fs.chmodSync(/* turbopackIgnore: true */ dir, 0o700);
  } catch {
    /* the 0600 on each file is what keeps a picture private */
  }
}

function hasRoom(dir: string, bytes: number): boolean {
  try {
    const stat = fs.statfsSync(/* turbopackIgnore: true */ dir);
    return stat.bavail * stat.bsize - DISK_FREE_RESERVE_BYTES >= bytes;
  } catch {
    // A filesystem that will not say how full it is does not block a 9 MiB write.
    return true;
  }
}

/** `paste-20261011-193355-1a2b3c4d.png`. */
const PASTE_NAME = /^paste-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp)$/;

function pasteName(now: Date, format: PastedImageFormat): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${String(now.getUTCFullYear()).padStart(4, "0")}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}` +
    `-${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  return `paste-${stamp}-${crypto.randomBytes(4).toString("hex")}.${format}`;
}

/**
 * Removes this module's own files that have aged out, then the oldest of the
 * rest until the folder is under its cap. Best effort: called for its side
 * effect before a write, so nothing it meets is raised. A file this module did
 * not name is never touched — the folder is one a person can open.
 */
export function pruneTerminalPastes(dir = terminalPasteDir(), now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(/* turbopackIgnore: true */ dir);
  } catch {
    return;
  }
  const kept: { file: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    if (!PASTE_NAME.test(name)) continue;
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(/* turbopackIgnore: true */ file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const age = now - stat.mtimeMs;
    if (age < PRUNE_MIN_AGE_MS) continue;
    if (age > TERMINAL_PASTE_MAX_AGE_MS) {
      try { fs.unlinkSync(/* turbopackIgnore: true */ file); } catch { /* raced another sweep */ }
      continue;
    }
    kept.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  let total = kept.reduce((sum, f) => sum + f.size, 0);
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of kept) {
    if (total <= TERMINAL_PASTE_MAX_TOTAL_BYTES) break;
    try {
      fs.unlinkSync(/* turbopackIgnore: true */ f.file);
      total -= f.size;
    } catch { /* raced another sweep */ }
  }
}

/**
 * Saves one pasted picture and answers where. The bytes must BE a PNG, JPEG,
 * GIF or WebP; the extension is taken from them, never from the caller.
 */
export function savePastedImage(bytes: Uint8Array, dir = terminalPasteDir(), now = new Date()): SavedPaste {
  if (bytes.byteLength === 0) throw new TerminalPasteError("empty", "The picture is empty.", 400);
  if (bytes.byteLength > TERMINAL_PASTE_MAX_BYTES) {
    throw new TerminalPasteError("too_large", "The picture is too large to paste.", 413);
  }
  const format = sniffPastedImage(bytes);
  if (!format) {
    throw new TerminalPasteError("not_an_image", "Only PNG, JPEG, GIF and WebP pictures can be pasted.", 415);
  }

  ensureFolder(dir);
  pruneTerminalPastes(dir, now.getTime());
  if (!hasRoom(dir, bytes.byteLength)) {
    throw new TerminalPasteError("disk_full", "There is not enough free disk space.", 507);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const name = pasteName(now, format);
    const target = path.join(dir, name);
    try {
      // `wx`: never overwrite, and never write through a link planted at the name.
      fs.writeFileSync(/* turbopackIgnore: true */ target, bytes, { flag: "wx", mode: 0o600 });
      return { path: target, name, size: bytes.byteLength, format };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      try { fs.unlinkSync(/* turbopackIgnore: true */ target); } catch { /* nothing was written */ }
      throw new TerminalPasteError("write_failed", "The picture could not be saved.", 500);
    }
  }
  throw new TerminalPasteError("write_failed", "A free name for the picture could not be found.", 500);
}
