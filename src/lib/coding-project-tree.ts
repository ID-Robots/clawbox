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
 * Read-only. A run edits files; the owner reads them.
 */

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

/** Folders a project explorer has no business opening. */
const SKIPPED_DIRS = new Set([".git"]);
/** A folder lists this many entries at most. */
export const MAX_TREE_ENTRIES = 1000;
/** A file is read up to here; the rest is cut and said so. */
export const MAX_TREE_FILE_BYTES = 512 * 1024;

/**
 * `rel` (as the page names it; "" or "." is the project itself) resolved to a
 * real path inside `projectDir`, or the status to answer. The lexical check
 * comes first so `..` never reaches the filesystem; the realpath check comes
 * second so a link cannot take the walk elsewhere.
 */
export async function resolveInsideProject(
  projectDir: string,
  rel: string,
): Promise<{ ok: true; root: string; abs: string; rel: string } | TreeRefusal> {
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
    return { ok: true, root, abs: real, rel: cleaned };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  }
}

/** One folder's entries, folders first, `.git` left out, links skipped. */
export async function listProjectDir(projectDir: string, rel: string): Promise<({ ok: true } & TreeListing) | TreeRefusal> {
  const resolved = await resolveInsideProject(projectDir, rel);
  if (!resolved.ok) return resolved;
  let dirents: import("fs").Dirent[];
  try {
    const stat = await fsp.stat(resolved.abs);
    if (!stat.isDirectory()) return { ok: false, status: 404 };
    dirents = await fsp.readdir(resolved.abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  }
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    // `isDirectory()`/`isFile()` are both false for a symlink: a link is left
    // out rather than followed, the way the Files app and the picker do it.
    const isDir = d.isDirectory();
    if (!isDir && !d.isFile()) continue;
    if (isDir && SKIPPED_DIRS.has(d.name)) continue;
    const abs = path.join(resolved.abs, d.name);
    if (isProtectedFilePath(abs)) continue;
    let size: number | null = null;
    let modified: string | null = null;
    try {
      const s = await fsp.stat(abs);
      size = isDir ? null : s.size;
      modified = s.mtime.toISOString();
    } catch {
      // Listed by name alone.
    }
    entries.push({ name: d.name, type: isDir ? "directory" : "file", size, modified });
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
  const truncated = entries.length > MAX_TREE_ENTRIES;
  return { ok: true, path: resolved.rel, entries: truncated ? entries.slice(0, MAX_TREE_ENTRIES) : entries, truncated };
}

/** One file's text, cut at MAX_TREE_FILE_BYTES; a binary file is flagged and
 *  carries no content — the page offers nothing to render for it. */
export async function readProjectFile(projectDir: string, rel: string): Promise<({ ok: true } & TreeFile) | TreeRefusal> {
  const resolved = await resolveInsideProject(projectDir, rel);
  if (!resolved.ok) return resolved;
  if (!resolved.rel) return { ok: false, status: 404 };
  let handle: fsp.FileHandle | null = null;
  try {
    // One open handle, stat'ed and read through it: never stat-then-open, so
    // the file that is read is the file that was checked.
    handle = await fsp.open(resolved.abs, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, status: 404 };
    const want = Math.min(stat.size, MAX_TREE_FILE_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buf, got, want - got, got);
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
    await handle?.close().catch(() => {});
  }
}
