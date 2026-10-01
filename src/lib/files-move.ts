import fs from "fs";
import path from "@/lib/runtime-path";
import { canonicalPath, isInside, isProtectedContainer, isProtectedFilePath } from "@/lib/file-guard";

// ── Moving files and folders into another folder ────────────────────────────
//
// The Files app's "Move to…" and its drag-and-drop onto a folder, as ONE batch
// request. A batch rather than one rename per item because the refusals are
// about the batch: a name that already exists in the destination has to be
// asked about BEFORE anything moves ("keep both or skip?"), and asking after
// half the selection has left its folder leaves the owner with two folders to
// sort out instead of one question to answer.
//
// So it runs in two passes. The first judges every item and moves nothing —
// an invalid or protected path, a folder dropped into itself or one of its own
// subfolders, a missing item — and with the default policy it refuses the
// whole batch over any name clash, answering the clashing names. The second
// moves, item by item, and reports what happened to each; a failure there (a
// permission, a file that vanished in between) does not undo the ones before.
//
// The rules are the rename route's, applied to each item: the source may not
// be a PROTECTED CONTAINER (`data/`, the browse root, `~/.config` — moving one
// takes every store inside it out from under the guard), and the landing path
// may be neither a protected store nor a protected container's name. Paths
// reach this module already through the route's `safePath`; `null` is how an
// item that failed it arrives.

/** What to do about an item whose name the destination already holds. */
export type MoveConflictPolicy = "fail" | "rename" | "skip";

/** Items one request may move. A selection is what the owner can see; ten thousand is far past it. */
export const MAX_MOVE_ITEMS = 10_000;

export interface MoveSource {
  /** Browse-relative, as the Files app sent it. */
  rel: string;
  /** The route's `safePath` answer for it; null when that refused it. */
  abs: string | null;
}

export interface MoveRefusal {
  status: number;
  body: {
    error: string;
    code: string;
    /** The item the refusal is about, when it is about one. */
    path?: string;
    /** For `conflict`: every item whose name the destination already holds. */
    conflicts?: { path: string; name: string }[];
  };
}

export interface MoveOutcome {
  moved: { from: string; to: string; name: string }[];
  skipped: { path: string; reason: "same_folder" | "exists" }[];
  failed: { path: string; code: string; error: string }[];
}

export type MoveResult = { ok: true; outcome: MoveOutcome } | { ok: false; refusal: MoveRefusal };

function refuse(status: number, code: string, error: string, extra: Omit<MoveRefusal["body"], "error" | "code"> = {}): MoveResult {
  return { ok: false, refusal: { status, body: { error, code, ...extra } } };
}

/** A name is taken by anything at all, a dangling link included — `rename(2)` would replace it. */
function exists(abs: string): boolean {
  try {
    fs.lstatSync(/* turbopackIgnore: true */ abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first of `name (2)`, `name (3)`, … that `dir` does not hold, keeping the
 * extension where it is: `report.pdf` → `report (2).pdf`, `.env` → `.env (2)`.
 * Null only when ten thousand are taken, which is a folder nobody can use.
 */
export function nextFreeName(dir: string, name: string): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  return null;
}

function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function moveErrorOf(err: unknown): { code: string; error: string } {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EXDEV") return { code: "cross_device", error: "Cannot move between different drives" };
  if (code === "EACCES" || code === "EPERM") return { code: "permission_denied", error: "Permission denied" };
  if (code === "ENOENT") return { code: "not_found", error: "Not found" };
  if (code === "ENOTEMPTY" || code === "EEXIST") return { code: "conflict", error: "Already exists" };
  return { code: "move_failed", error: "Failed to move" };
}

/**
 * Move `sources` into `destAbs` under `root` (the browse root), with
 * `conflict` deciding what a name clash does. `destAbs` is the route's
 * `safePath` answer for the destination (null when it refused it).
 */
export function moveEntries({ root, sources, destAbs, conflict }: {
  root: string;
  sources: readonly MoveSource[];
  destAbs: string | null;
  conflict: MoveConflictPolicy;
}): MoveResult {
  const base = path.resolve(root);
  if (!destAbs) return refuse(400, "invalid_destination", "Invalid destination");
  let destStat: fs.Stats;
  try {
    destStat = fs.statSync(/* turbopackIgnore: true */ destAbs);
  } catch {
    return refuse(404, "not_found", "Destination folder not found");
  }
  if (!destStat.isDirectory()) return refuse(400, "not_directory", "The destination is not a folder");
  const destReal = canonicalPath(destAbs) ?? destAbs;

  // ── Pass one: judge everything, move nothing ──
  const skipped: MoveOutcome["skipped"] = [];
  const plan: { rel: string; abs: string; name: string }[] = [];
  const conflicts: { path: string; name: string }[] = [];
  const seen = new Set<string>();
  // Names this batch will put into the destination, so two items of one name
  // (a selection drawn from search results) clash with each other too.
  const claimed = new Set<string>();
  for (const source of sources) {
    const { rel, abs } = source;
    if (!abs) return refuse(400, "invalid_path", "Invalid path", { path: rel });
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (abs === base || isProtectedContainer(abs)) {
      return refuse(400, "protected_container", "This folder holds the box's own state and cannot be moved or deleted here", { path: rel });
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(/* turbopackIgnore: true */ abs);
    } catch {
      return refuse(404, "not_found", "Not found", { path: rel });
    }
    // Into itself, as typed and as the links really lead. The lexical test
    // covers every kind of item (a link moved under its own spelling is a
    // loop the owner did not mean); the canonical one only a real folder,
    // since moving a LINK moves the link, not what it points at.
    const srcReal = stat.isDirectory() ? canonicalPath(abs) ?? abs : abs;
    if (isInside(destAbs, abs) || (stat.isDirectory() && isInside(destReal, srcReal))) {
      return refuse(400, "into_itself", "A folder cannot be moved into itself", { path: rel });
    }
    const parent = path.dirname(abs);
    if (parent === destAbs || (canonicalPath(parent) ?? parent) === destReal) {
      skipped.push({ path: rel, reason: "same_folder" });
      continue;
    }
    const name = path.basename(abs);
    const target = path.join(destAbs, name);
    if (isProtectedFilePath(target)) return refuse(400, "invalid_destination", "Invalid destination", { path: rel });
    if (isProtectedContainer(target)) {
      return refuse(400, "protected_container", "This folder holds the box's own state and cannot be moved or deleted here", { path: rel });
    }
    if (claimed.has(name) || exists(target)) conflicts.push({ path: rel, name });
    claimed.add(name);
    plan.push({ rel, abs, name });
  }
  if (conflict === "fail" && conflicts.length > 0) {
    return refuse(409, "conflict", conflicts.length === 1
      ? `"${conflicts[0].name}" already exists in the destination`
      : `${conflicts.length} items already exist in the destination`, { conflicts });
  }

  // ── Pass two: move, reporting each ──
  const moved: MoveOutcome["moved"] = [];
  const failed: MoveOutcome["failed"] = [];
  for (const item of plan) {
    let target = path.join(destAbs, item.name);
    if (exists(target)) {
      if (conflict === "skip") {
        skipped.push({ path: item.rel, reason: "exists" });
        continue;
      }
      const free = conflict === "rename" ? nextFreeName(destAbs, item.name) : null;
      if (!free) {
        failed.push({ path: item.rel, code: "conflict", error: "Already exists" });
        continue;
      }
      target = path.join(destAbs, free);
      // A name of our own making is still a landing path: judged again.
      if (isProtectedFilePath(target) || isProtectedContainer(target)) {
        failed.push({ path: item.rel, code: "invalid_destination", error: "Invalid destination" });
        continue;
      }
    }
    try {
      fs.renameSync(item.abs, target);
    } catch (err) {
      failed.push({ path: item.rel, ...moveErrorOf(err) });
      continue;
    }
    moved.push({ from: item.rel, to: relOf(base, target), name: path.basename(target) });
  }
  return { ok: true, outcome: { moved, skipped, failed } };
}
