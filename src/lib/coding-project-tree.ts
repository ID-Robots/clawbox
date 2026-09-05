/**
 * The Coding Agent project page's file explorer: a listing of one folder
 * inside a project, and the text of one file in it.
 *
 * Its own module rather than the Files app's route, because the two walk
 * different trees. `/setup-api/files` is rooted at the owner's home, and a
 * project folder can be anywhere `setDefaultDirectory` accepted — so the root
 * here is the PROJECT, resolved by the caller through the same
 * `resolveWorkingDirectory` a run goes through, and nothing outside it is
 * reachable however the path is spelled. The two checks the browse route makes
 * are made here in the same order: lexical containment on the path as typed,
 * then again on the realpath (a symlink inside the project can point out of
 * it), then the secret-store guard, since a project may sit inside the
 * checkout and `data/` is where the tokens live.
 *
 * Reading, and ONE write: the owner's edit of a file that is already there,
 * through the same walk. The editor never creates or removes a file — a run
 * does that, and the Files app can.
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { isProtectedFilePath } from "@/lib/file-guard";
import { safeProjectRelativePath } from "@/lib/coding-git";

export interface TreeEntry {
  name: string;
  type: "file" | "directory";
  size: number | null;
  /** ISO time, null when the entry could not be stat'ed. */
  modified: string | null;
}

export interface TreeListing {
  /** The folder, relative to the project; "" for the project itself. */
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface TreeFile {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export type TreeRefusal = { ok: false; status: 403 | 404 };
/** A save refused: the same 403/404 as a read, or 413 for a text past the cap. */
export type WriteRefusal = { ok: false; status: 403 | 404 | 413 };

/** Folders a project explorer has no business opening. */
const SKIPPED_DIRS = new Set([".git"]);
/** A folder lists this many entries at most. */
export const MAX_TREE_ENTRIES = 1000;
/** A file is read up to here; the rest is cut and said so. */
export const MAX_TREE_FILE_BYTES = 512 * 1024;
/** A save may be this large at most — the read cap, so what was opened whole can be saved whole. */
export const MAX_TREE_WRITE_BYTES = MAX_TREE_FILE_BYTES;

/**
 * `rel` (as the page names it; "" or "." is the project itself) resolved to a
 * real path inside `projectDir`, or the status to answer. The lexical check
 * comes first so `..` never reaches the filesystem; the realpath check comes
 * second so a link cannot take the walk elsewhere.
 */
export async function resolveInsideProject(
  projectDir: string,
  rel: string,
): Promise<{ ok: true; root: string; abs: string; lexical: string; rel: string } | TreeRefusal> {
  const cleaned = rel === "" || rel === "." ? "" : safeProjectRelativePath(rel);
  if (cleaned === null) return { ok: false, status: 404 };
  let root: string;
  try {
    root = await fsp.realpath(path.resolve(projectDir));
  } catch {
    return { ok: false, status: 404 };
  }
  const candidate = path.resolve(root, cleaned);
  const lexical = path.relative(root, candidate);
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) return { ok: false, status: 404 };
  try {
    const real = await fsp.realpath(candidate);
    const realRel = path.relative(root, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { ok: false, status: 404 };
    if (isProtectedFilePath(real)) return { ok: false, status: 404 };
    if (realRel.split(path.sep).some((seg) => SKIPPED_DIRS.has(seg))) return { ok: false, status: 404 };
    // `abs` is where the path really points (checked above); `lexical` is the
    // path as spelled. Neither is opened by name afterwards: the readers reach
    // `rel` from `root` one descriptor at a time (openThroughDescriptors).
    return { ok: true, root, abs: real, lexical: candidate, rel: cleaned };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  }
}

/**
 * Open `rel` under `root` the way openat(2) would: the root first, then every
 * component through the descriptor of the one before it, each opened with
 * O_NOFOLLOW (and O_DIRECTORY for all but a file at the end). No component
 * of the path is ever resolved by name against the live filesystem after the
 * checks above — a run working in this folder can replace an ancestor with a
 * link between the check and the read, and this walk would then refuse it
 * (ELOOP) rather than read through it. `/proc/self/fd/<n>/<name>` names a
 * child of an OPEN directory, whatever the path is swapped for meanwhile.
 *
 * Returns the descriptor of the target; the caller closes it.
 */
function openThroughDescriptors(root: string, rel: string, target: "directory" | "file", access: "read" | "write" = "read"): number {
  const parts = rel === "" ? [] : rel.split("/");
  let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      // Writing opens the file itself for writing and nothing else: every
      // folder on the way is still opened read-only, and never created.
      const flags = last && target === "file"
        ? (access === "write" ? fs.constants.O_WRONLY : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      const next = fs.openSync(path.join(`/proc/self/fd/${fd}`, parts[i]), flags);
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    throw err;
  }
}

/** One folder's entries, folders first, `.git` left out, links skipped. */
export async function listProjectDir(projectDir: string, rel: string): Promise<({ ok: true } & TreeListing) | TreeRefusal> {
  const resolved = await resolveInsideProject(projectDir, rel);
  if (!resolved.ok) return resolved;
  // ONE handle for the folder, reached component by component without
  // following a link (openThroughDescriptors), and every read below goes
  // through it. Read entry by entry and stop past the cap: a generated
  // folder with a hundred thousand files must not be allocated whole — this
  // runs on the appliance.
  const entries: TreeEntry[] = [];
  let truncated = false;
  let fd: number | null = null;
  try {
    fd = openThroughDescriptors(resolved.root, resolved.rel, "directory");
    const viaFd = `/proc/self/fd/${fd}`;
    const dir = await fsp.opendir(viaFd);
    try {
      for await (const d of dir) {
        // `isDirectory()`/`isFile()` are both false for a symlink: a link is
        // left out rather than followed, the way the Files app and the picker
        // do it.
        const isDir = d.isDirectory();
        if (!isDir && !d.isFile()) continue;
        if (isDir && SKIPPED_DIRS.has(d.name)) continue;
        if (isProtectedFilePath(path.join(resolved.abs, d.name))) continue;
        if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; break; }
        let size: number | null = null;
        let modified: string | null = null;
        try {
          // Through the handle, and never following the entry itself.
          const s = await fsp.lstat(path.join(viaFd, d.name));
          size = isDir ? null : s.size;
          modified = s.mtime.toISOString();
        } catch {
          // Listed by name alone.
        }
        entries.push({ name: d.name, type: isDir ? "directory" : "file", size, modified });
      }
    } finally {
      // Left open by a `break`; closed twice is harmless.
      await dir.close().catch(() => {});
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOTDIR is a file, ELOOP a link where a folder was expected: both 404.
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
  return { ok: true, path: resolved.rel, entries, truncated };
}

/** One file's text, cut at MAX_TREE_FILE_BYTES; a binary file is flagged and
 *  carries no content — the page offers nothing to render for it. */
export async function readProjectFile(projectDir: string, rel: string): Promise<({ ok: true } & TreeFile) | TreeRefusal> {
  const resolved = await resolveInsideProject(projectDir, rel);
  if (!resolved.ok) return resolved;
  if (!resolved.rel) return { ok: false, status: 404 };
  let fd: number | null = null;
  try {
    // One descriptor, reached component by component without following a
    // link, stat'ed and read through it: never stat-then-open by name, so
    // the file that is read is the file that was checked, and a link planted
    // anywhere in its path is refused.
    fd = openThroughDescriptors(resolved.root, resolved.rel, "file");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, status: 404 };
    const want = Math.min(stat.size, MAX_TREE_FILE_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const bytesRead = fs.readSync(fd, buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const bytes = buf.subarray(0, got);
    const binary = bytes.subarray(0, 8192).includes(0);
    return {
      ok: true,
      path: resolved.rel,
      content: binary ? "" : bytes.toString("utf8"),
      size: stat.size,
      truncated: stat.size > want,
      binary,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * The owner's edit, saved over a file that is already in the project. The
 * parent folder is reached by the same walk as a read — component by
 * component, no link followed — and the target is inspected through it
 * (a plain file, and its mode) with O_NOFOLLOW. The new text then lands in
 * a SIBLING first: created fresh (O_EXCL) with the target's own mode,
 * written and fsync'ed, and given the target's name in one rename — so a
 * disk that fills halfway through leaves the old file whole rather than
 * empty. No file is created under the owner's name (a typo is a 404, not a
 * new file); a folder, a link and the project root are refused alike; the
 * sibling is removed on any failure.
 */
export async function writeProjectFile(projectDir: string, rel: string, content: string): Promise<{ ok: true; path: string; size: number } | WriteRefusal> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_TREE_WRITE_BYTES) return { ok: false, status: 413 };
  const resolved = await resolveInsideProject(projectDir, rel);
  if (!resolved.ok) return resolved;
  if (!resolved.rel) return { ok: false, status: 404 };
  const slash = resolved.rel.lastIndexOf("/");
  const parentRel = slash === -1 ? "" : resolved.rel.slice(0, slash);
  const name = slash === -1 ? resolved.rel : resolved.rel.slice(slash + 1);
  let dirFd: number | null = null;
  let tmpName: string | null = null;
  try {
    dirFd = openThroughDescriptors(resolved.root, parentRel, "directory");
    const viaDir = `/proc/self/fd/${dirFd}`;
    const targetFd = fs.openSync(path.join(viaDir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let mode: number;
    try {
      const stat = fs.fstatSync(targetFd);
      if (!stat.isFile()) return { ok: false, status: 404 };
      mode = stat.mode & 0o777;
    } finally {
      fs.closeSync(targetFd);
    }
    // Named apart from the target: a name near the filesystem's component
    // limit would make its sibling too long to create.
    tmpName = `.clawbox-save-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const tmpFd = fs.openSync(path.join(viaDir, tmpName), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try {
      let written = 0;
      while (written < bytes.length) {
        written += fs.writeSync(tmpFd, bytes, written, bytes.length - written, written);
      }
      fs.fsyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }
    fs.renameSync(path.join(viaDir, tmpName), path.join(viaDir, name));
    tmpName = null;
    try { fs.fsyncSync(dirFd); } catch { /* the rename is on disk either way; the folder's sync is best effort */ }
    return { ok: true, path: resolved.rel, size: bytes.length };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  } finally {
    if (tmpName !== null && dirFd !== null) { try { fs.unlinkSync(path.join(`/proc/self/fd/${dirFd}`, tmpName)); } catch { /* never made */ } }
    if (dirFd !== null) { try { fs.closeSync(dirFd); } catch { /* already closed */ } }
  }
}
