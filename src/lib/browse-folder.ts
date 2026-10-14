/**
 * The one rule for "the owner picked this folder": it must sit inside the tree
 * the Files app browses (after links are resolved, not only as typed), must
 * not be a protected credential store, and must be a directory.
 *
 * Shared by every route that takes a folder from the folder picker — Memory
 * Shard's sources and Prime Radiant's ingest — so the two cannot disagree
 * about which folders an owner may hand the box to read.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";

export type BrowseFolderResult = { ok: true; dir: string } | { ok: false; status: 400 | 403 | 404 };

export async function resolveFolderInsideBrowseRoot(asked: unknown): Promise<BrowseFolderResult> {
  if (!asked || typeof asked !== "string") return { ok: false, status: 400 };
  const configured = path.resolve(filesBrowseRoot());
  let root: string;
  try {
    root = await fs.realpath(configured);
  } catch {
    root = configured;
  }
  // Written as relative-then-join rather than a `startsWith` helper, the same
  // way the folder picker's own resolveDir is: it is the same rule, but a
  // scanner can only tie a guard to the sink when the guard is inline on the
  // very value that reaches it (js/path-injection). `rel` is empty for the
  // root itself, so the root still resolves.
  const requested = path.isAbsolute(asked) ? path.resolve(asked) : path.resolve(root, asked);
  const rel = path.relative(root, requested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, status: 404 };
  const candidate = path.join(root, rel);
  try {
    // Checked AGAIN after resolving links: the lexical check above cannot see
    // that a folder inside the root is a symlink pointing out of it.
    const real = await fs.realpath(candidate);
    const realRel = path.relative(root, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { ok: false, status: 404 };
    if (isProtectedFilePath(real)) return { ok: false, status: 404 };
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return { ok: false, status: 400 };
    return { ok: true, dir: real };
  } catch {
    return { ok: false, status: 404 };
  }
}
