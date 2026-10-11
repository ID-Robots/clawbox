// The screenshots folder on disk: list, save, delete. Server-only.
//
// Every path this module touches is `<Files root>/Screenshots/<one validated
// name>` — the name is checked by files.ts before a path is built, and the
// built path is checked again to sit directly in the folder. A caller cannot
// make it write, read or remove anything anywhere else.

import fs from "fs";
import path from "@/lib/runtime-path";
import { DISK_FREE_RESERVE_BYTES } from "@/lib/disk-reserve";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";
import {
  MAX_RECENT_SCREENSHOTS,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOTS_DIR,
  isValidScreenshotName,
  screenshotFormatOf,
  sniffImageFormat,
  uniqueScreenshotName,
} from "./files";

export interface ScreenshotEntry {
  name: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

export type ScreenshotRefusal =
  | "invalid_name"
  | "too_large"
  | "empty"
  | "not_an_image"
  | "type_mismatch"
  | "unsafe_folder"
  | "disk_full"
  | "not_found";

export class ScreenshotError extends Error {
  constructor(
    public readonly code: ScreenshotRefusal,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ScreenshotError";
  }
}

export function screenshotsDir(): string {
  return path.join(path.resolve(filesBrowseRoot()), SCREENSHOTS_DIR);
}

/**
 * The absolute path of screenshot `name`, or null when the name is not one or
 * the path would not sit directly inside the folder.
 */
export function resolveScreenshotPath(name: unknown, dir = screenshotsDir()): string | null {
  if (!isValidScreenshotName(name)) return null;
  const base = path.resolve(dir);
  const resolved = path.resolve(base, name);
  if (path.dirname(resolved) !== base || path.basename(resolved) !== name) return null;
  if (isProtectedFilePath(resolved)) return null;
  return resolved;
}

/**
 * Whether the folder is a real directory where it says it is. `Screenshots`
 * replaced by a link to somewhere else would turn every save into a write
 * there, so a folder that resolves anywhere but its own place is refused.
 */
function folderIsSafe(dir: string): boolean {
  try {
    const stat = fs.lstatSync(/* turbopackIgnore: true */ dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(/* turbopackIgnore: true */ path.dirname(dir));
    return fs.realpathSync(/* turbopackIgnore: true */ dir) === path.join(realRoot, path.basename(dir));
  } catch {
    return false;
  }
}

function ensureFolder(dir: string): void {
  if (!fs.existsSync(/* turbopackIgnore: true */ dir)) {
    try {
      fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
    } catch {
      throw new ScreenshotError("unsafe_folder", "The Screenshots folder could not be created.", 500);
    }
  }
  if (isProtectedFilePath(dir) || !folderIsSafe(dir)) {
    throw new ScreenshotError("unsafe_folder", "The Screenshots folder is not a regular folder.", 409);
  }
}

/** The newest screenshots first. A folder that does not exist yet is an empty list, not an error. */
export function listScreenshots(limit = MAX_RECENT_SCREENSHOTS, dir = screenshotsDir()): ScreenshotEntry[] {
  if (!fs.existsSync(/* turbopackIgnore: true */ dir) || !folderIsSafe(dir)) return [];
  const entries: ScreenshotEntry[] = [];
  for (const dirent of fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true })) {
    // Regular files only: a link in the folder is not a screenshot this app wrote.
    if (!dirent.isFile() || !isValidScreenshotName(dirent.name)) continue;
    try {
      const stat = fs.statSync(/* turbopackIgnore: true */ path.join(dir, dirent.name));
      entries.push({ name: dirent.name, size: stat.size, modified: Math.round(stat.mtimeMs) });
    } catch {
      // Removed between the listing and the stat: it is simply not there.
    }
  }
  entries.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  return entries.slice(0, Math.max(0, limit));
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

/**
 * Writes one image into the folder and returns the entry it became. The bytes
 * must BE a PNG or a JPEG and agree with the name's extension; a name already
 * taken gets a numbered sibling rather than overwriting what is there.
 */
export function saveScreenshot(name: unknown, bytes: Uint8Array, dir = screenshotsDir()): ScreenshotEntry {
  if (!isValidScreenshotName(name)) {
    throw new ScreenshotError("invalid_name", "That is not a valid screenshot name.", 400);
  }
  if (bytes.byteLength === 0) throw new ScreenshotError("empty", "The image is empty.", 400);
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new ScreenshotError("too_large", "The image is too large to save.", 413);
  }
  const actual = sniffImageFormat(bytes);
  if (!actual) throw new ScreenshotError("not_an_image", "Only PNG and JPEG images can be saved.", 415);
  if (actual !== screenshotFormatOf(name)) {
    throw new ScreenshotError("type_mismatch", "The image does not match its file extension.", 415);
  }

  ensureFolder(dir);
  if (!hasRoom(dir, bytes.byteLength)) {
    throw new ScreenshotError("disk_full", "There is not enough free disk space.", 507);
  }

  let taken: string[] = [];
  try {
    taken = fs.readdirSync(/* turbopackIgnore: true */ dir);
  } catch {
    /* an unreadable folder fails at the write below, with the real error */
  }
  let finalName = uniqueScreenshotName(name, taken);
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = resolveScreenshotPath(finalName, dir);
    if (!target) throw new ScreenshotError("invalid_name", "That is not a valid screenshot name.", 400);
    try {
      // `wx`: never overwrite, and never write through a link planted at the name.
      fs.writeFileSync(/* turbopackIgnore: true */ target, bytes, { flag: "wx", mode: 0o644 });
      const stat = fs.statSync(/* turbopackIgnore: true */ target);
      return { name: finalName, size: stat.size, modified: Math.round(stat.mtimeMs) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another save took the name in between; ask for the next one.
      taken.push(finalName);
      finalName = uniqueScreenshotName(name, taken);
    }
  }
  throw new ScreenshotError("invalid_name", "A free name for the screenshot could not be found.", 409);
}

export function deleteScreenshot(name: unknown, dir = screenshotsDir()): void {
  const target = resolveScreenshotPath(name, dir);
  if (!target) throw new ScreenshotError("invalid_name", "That is not a valid screenshot name.", 400);
  if (!folderIsSafe(dir)) throw new ScreenshotError("not_found", "That screenshot does not exist.", 404);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(/* turbopackIgnore: true */ target);
  } catch {
    throw new ScreenshotError("not_found", "That screenshot does not exist.", 404);
  }
  if (!stat.isFile()) throw new ScreenshotError("not_found", "That screenshot does not exist.", 404);
  fs.unlinkSync(/* turbopackIgnore: true */ target);
}
