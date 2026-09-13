/**
 * Removing a project folder — the one gesture in the Coding Agent that takes
 * the owner's own code away.
 *
 * WHY IT IS A LIBRARY AND NOT A ROUTE. Everything that decides whether a folder
 * may go is here, because the route, the dialog's preview and the tests all have
 * to reach the SAME verdict. A route that worked out "is this inside the project
 * folder" its own way would eventually disagree with the preview the owner was
 * shown, and the shape of that disagreement is a dialog that promises one thing
 * and a handler that does another.
 *
 * NOTHING HERE IS IRREVERSIBLE. There is no `rm -rf` in this file. A removed
 * project is MOVED — into `data/deleted-projects/<folder>--<timestamp>` — and
 * the answer says where it went, so the owner can carry it back with `mv` if the
 * click was a mistake. The whole point is that the destructive-sounding button
 * is not actually destructive for a month: see RETENTION below.
 *
 * THE TWO ROOTS, and why the check is "DIRECTLY inside". A project is a folder
 * directly inside the owner's project folder, or a code project under
 * `data/code-projects` — exactly what `listProjects` offers, and nothing else.
 * Not "somewhere under", because `~/Projects/shop/node_modules` is under the
 * root too and is not a project; a run works at any depth inside one, and a
 * delete must not. One `path.dirname` is the whole rule, and it is checked twice
 * — once on the path as typed, once on the path with every symlink resolved —
 * because a link is how a name directly inside a root points at a folder that is
 * not.
 *
 * RETENTION. A folder in the trash is kept for THIRTY DAYS and at most
 * `MAX_TRASH_ENTRIES` (10) are kept at a time; the prune runs after each
 * successful delete, oldest first, and removes whichever of the two bounds is
 * hit. The timestamp in the name is the record — nothing else is written, so a
 * restored folder is byte-for-byte the folder that was removed — and an entry
 * whose name this module did not write is never touched by the prune. That last
 * rule is deliberate: the trash is a directory a person can open, and a folder
 * somebody put there by hand is theirs, not ours.
 */

import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { gitIn, WORKTREES_DIR } from "@/lib/coding-team-worktree";
import type { ChildResult } from "@/lib/child-run";
import { isLive } from "@/lib/coding-agent-status";
import { getDefaultDirectory, listRuns, projectDirectoryOf, type CodingProjectKind, type CodingRun } from "@/lib/coding-agent";
import { deleteVercelLink, readVercelLink } from "@/lib/vercel-link";
import { deleteSecretsForScope, listSecrets } from "@/lib/project-secrets";

// ─── What may go wrong ───────────────────────────────────────────────────────

/**
 * Why a project folder was not removed.
 *
 * A stable code per reason, because the UI words each one in the owner's
 * language and the box's own English sentence is the fallback. `unsaved_work` is
 * the ONLY one a force flag clears — the other five are facts about the request
 * or the box, and no flag makes them untrue.
 */
export type ProjectDeleteRefusal =
  | "invalid"
  | "not_found"
  | "confirm_mismatch"
  | "outside_roots"
  | "path_escape"
  | "protected_checkout"
  | "live_run"
  | "unsaved_work"
  | "trash_failed";

export class ProjectDeleteError extends Error {
  constructor(readonly code: ProjectDeleteRefusal, message: string) {
    super(message);
    this.name = "ProjectDeleteError";
  }
}

/** The HTTP status each refusal is answered with — one table, so nothing drifts. */
export const PROJECT_DELETE_STATUS: Record<ProjectDeleteRefusal, number> = {
  invalid: 400,
  not_found: 404,
  confirm_mismatch: 400,
  outside_roots: 403,
  path_escape: 403,
  protected_checkout: 403,
  live_run: 409,
  unsaved_work: 409,
  trash_failed: 500,
};

// ─── The roots ───────────────────────────────────────────────────────────────

/** Where code projects live. The same join `listProjects` makes. */
export function codeProjectsRoot(): string {
  return path.join(DATA_DIR, "code-projects");
}

/**
 * ClawBox's own checkout. `DATA_DIR` is `<clawbox>/data`, so its parent is the
 * product's own repository — the same derivation `protectedCheckout()` makes in
 * coding-agent.ts for the worktree guard, spelled again here rather than
 * exported from a 10,000-line module for one line.
 */
export function protectedCheckoutRoot(): string {
  return path.dirname(DATA_DIR);
}

/** The two places a project may be, and the one place it may never be. */
export interface ProjectRoots {
  /** The owner's project folder, or null when none is set. */
  ownerFolder: string | null;
  codeProjects: string;
  checkout: string;
}

export async function projectRoots(): Promise<ProjectRoots> {
  return {
    ownerFolder: await getDefaultDirectory(),
    codeProjects: codeProjectsRoot(),
    checkout: protectedCheckoutRoot(),
  };
}

// ─── The path guards ─────────────────────────────────────────────────────────

/**
 * Is `child` a name sitting DIRECTLY in `parent` — one level down, no deeper?
 *
 * Pure, and the whole of the containment rule. `isInside` (file-guard) answers
 * "anywhere under", which is the right question for a run's file tools and the
 * wrong one here: every `node_modules` and every `.git` on the box is "under" a
 * project root somewhere, and none of them is a project. Trailing separators and
 * `.`/`..` segments are normalised away first, so `~/Projects/shop/../shop` is
 * the same answer as `~/Projects/shop`.
 */
export function isDirectlyInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return false;
  return path.dirname(c) === p;
}

/** A folder name, checked before it is ever joined to a root. */
const FOLDER_RE = /^[^/\\\0]+$/;

function requireFolderName(folder: unknown): string {
  if (typeof folder !== "string" || !folder.trim()) {
    throw new ProjectDeleteError("invalid", "Name the project to remove.");
  }
  const name = folder.trim();
  // Rebuilt-from-nothing is not available here — a folder of the owner's may be
  // called anything their filesystem allows — so the rule is what a single path
  // SEGMENT is: no separator, no NUL, and never a traversal segment. A name that
  // fails this is refused before `path.join` gets a chance to climb.
  if (!FOLDER_RE.test(name) || name === "." || name === "..") {
    throw new ProjectDeleteError("invalid", "A project is one folder name, not a path.");
  }
  return name;
}

/** The project a request named, once the box has agreed it is one. */
export interface ProjectTarget {
  folder: string;
  kind: CodingProjectKind;
  /** The path as the roots spell it — what the listing shows. */
  directory: string;
  /** The same folder with every symlink resolved. This is what gets moved. */
  real: string;
}

/**
 * Turn `{ folder, kind? }` into a folder this box agrees may be removed, or
 * throw the refusal the owner is shown.
 *
 * IN THIS ORDER, and the order is the point:
 *
 *   1. the name is one path segment (`invalid`);
 *   2. it sits directly in a root that EXISTS (`outside_roots` / `not_found`);
 *   3. the real path is directly in the real root, and the entry is not a link
 *      (`path_escape`);
 *   4. it is not ClawBox's own checkout (`protected_checkout`).
 *
 * Step 4 comes last and cannot be skipped by reaching step 2 first: the owner's
 * project folder may perfectly well be the parent of the ClawBox checkout, in
 * which case the checkout IS a folder directly inside a root and every earlier
 * check passes it.
 *
 * `roots` is a parameter rather than a read, so a test can state the two roots
 * and a caller reads them once for a preview and an act that must agree.
 */
export async function resolveProjectTarget(
  input: { folder: unknown; kind?: unknown },
  roots: ProjectRoots,
): Promise<ProjectTarget> {
  const folder = requireFolderName(input.folder);
  const kind: CodingProjectKind | null = input.kind === "folder" || input.kind === "codeProject" ? input.kind : null;

  // Which root to look in. A caller that says gets that one; a caller that does
  // not is looked up the way the listing builds itself — the owner's folder
  // first, then code projects — so a name that exists in both resolves to the
  // row the owner was actually shown.
  const candidates: Array<{ base: string; kind: CodingProjectKind }> = [];
  if (roots.ownerFolder && kind !== "codeProject") candidates.push({ base: roots.ownerFolder, kind: "folder" });
  if (kind !== "folder") candidates.push({ base: roots.codeProjects, kind: "codeProject" });
  if (!candidates.length) {
    throw new ProjectDeleteError(
      "outside_roots",
      "This ClawBox has no project folder set, so it has no folder project to remove.",
    );
  }

  let found: { directory: string; kind: CodingProjectKind } | null = null;
  for (const candidate of candidates) {
    const directory = path.join(path.resolve(candidate.base), folder);
    // `lstat`, never `stat`: a dangling link and a link to a directory must both
    // be recognised as what they are, and `stat` answers about the target.
    const entry = await fs.promises.lstat(directory).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      throw new ProjectDeleteError(
        "path_escape",
        `${folder} is a link, not a folder. This ClawBox only removes a real folder it can see directly inside one of its two project roots.`,
      );
    }
    if (!entry.isDirectory()) continue;
    found = { directory, kind: candidate.kind };
    break;
  }
  if (!found) {
    throw new ProjectDeleteError("not_found", `There is no project called ${folder} on this ClawBox.`);
  }

  // Belt to the brace of `requireFolderName`: the join above cannot climb out of
  // the root, but this is the fact the rest of the module depends on and it is
  // one comparison to assert rather than assume.
  const base = found.kind === "folder" ? roots.ownerFolder! : roots.codeProjects;
  if (!isDirectlyInside(found.directory, base)) {
    throw new ProjectDeleteError(
      "outside_roots",
      `${folder} is not directly inside this ClawBox's project folder or its code projects, so it is not a project this box may remove.`,
    );
  }

  // THE SYMLINK FENCE, second half. The entry itself is not a link (checked
  // above), but a root can be reached THROUGH one — `~/Projects` may itself be a
  // link, and so may anything above it. Resolve both ends and ask the same
  // question again: a folder whose real path is not directly inside the real
  // root is a folder some link elsewhere in the chain has moved, and a delete
  // that followed it would take away something the owner never saw listed.
  const real = await fs.promises.realpath(found.directory).catch(() => null);
  const realBase = await fs.promises.realpath(base).catch(() => path.resolve(base));
  if (!real) {
    throw new ProjectDeleteError("not_found", `There is no project called ${folder} on this ClawBox.`);
  }
  if (!isDirectlyInside(real, realBase)) {
    throw new ProjectDeleteError(
      "path_escape",
      `${folder} leads out of this ClawBox's project folders (${real}), so it is not a project this box may remove.`,
    );
  }

  const checkout = path.resolve(roots.checkout);
  const realCheckout = await fs.promises.realpath(checkout).catch(() => checkout);
  if (real === realCheckout || real === checkout) {
    throw new ProjectDeleteError(
      "protected_checkout",
      "That folder is ClawBox's own checkout — the operating system this box is running. It is never removed from here.",
    );
  }

  return { folder, kind: found.kind, directory: found.directory, real };
}

// ─── Is anybody still in there? ──────────────────────────────────────────────

/** A live run this project would have pulled out from under. */
export interface LiveRunInProject {
  id: string;
  task: string;
}

/**
 * Every run still RUNNING in the project — the folder itself, a sub-folder of
 * it, or the copy of it a run works in (`<project>/.clawbox/worktrees/<id>`).
 *
 * `isLive` alone, not `isHeld`: a paused run and an unstarted draft hold a
 * session, not a process, and refusing over one would mean a draft written a
 * month ago could keep a folder undeletable for ever. What a live run has is a
 * shell with an open file handle in that tree, and moving the tree out from
 * under it is how a run ends up writing into a folder in the trash.
 */
export function liveRunsInProject(target: Pick<ProjectTarget, "folder" | "kind" | "directory" | "real">): LiveRunInProject[] {
  const roots = [path.resolve(target.directory), path.resolve(target.real)];
  return listRuns()
    .filter((run) => {
      if (!isLive(run.status)) return false;
      if (target.kind === "codeProject" && run.projectId === target.folder) return true;
      const worked = [run.directory, projectDirectoryOf(run)].filter((d): d is string => typeof d === "string" && !!d);
      return worked.some((dir) => roots.some((root) => {
        const resolved = path.resolve(dir);
        return resolved === root || resolved.startsWith(root + path.sep);
      }));
    })
    .map((run) => ({ id: run.id, task: run.task }));
}

// ─── What would be lost ──────────────────────────────────────────────────────

/**
 * Work in the folder that exists nowhere else.
 *
 * Three separate questions, reported separately, because the sentence the dialog
 * has to show is "here is exactly what you are about to lose" and a single
 * "it is dirty" boolean cannot say it:
 *
 *   - `dirty` — files git would list as changed, added, deleted or untracked;
 *   - `unpushed` — commits on HEAD that no remote-tracking branch has. `null`
 *     when the project has no upstream at all, which is NOT zero: a project that
 *     was never pushed has every one of its commits nowhere else, and telling
 *     the owner "0 unpushed" about it would be a lie in the dangerous direction;
 *   - `worktrees` — a run's own copy still sitting under `.clawbox/worktrees`,
 *     which by definition holds commits the project folder does not.
 *
 * A folder that is not a repository at all answers `notARepository`, and that
 * counts as unsaved work of its own: there is no history anywhere, so every byte
 * in it is only in it.
 */
export interface UnsavedWork {
  /** Changed/added/deleted/untracked paths, bounded — see MAX_DIRTY_LISTED. */
  dirty: string[];
  dirtyCount: number;
  /** More changed files than `dirty` lists. */
  dirtyTruncated: boolean;
  /** Commits ahead of the upstream. Null when there is no upstream to be ahead of. */
  unpushed: number | null;
  /** Leftover run copies under `.clawbox/worktrees`, by folder name. */
  worktrees: string[];
  notARepository: boolean;
  /** Anything at all that a force flag would be needed for. */
  any: boolean;
}

/** The most changed paths the preview names one by one. The rest is a count. */
export const MAX_DIRTY_LISTED = 12;

const emptyWork = (): UnsavedWork => ({
  dirty: [],
  dirtyCount: 0,
  dirtyTruncated: false,
  unpushed: null,
  worktrees: [],
  notARepository: false,
  any: false,
});

export async function unsavedWorkIn(directory: string): Promise<UnsavedWork> {
  const dir = path.resolve(directory);
  const work = emptyWork();

  const inside = await gitIn(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    // Not a repository — or git could not be asked. Either way nothing here is
    // known to be saved anywhere else, and that is what a force flag is for.
    work.notARepository = true;
    work.any = true;
    work.worktrees = await leftoverWorktrees(dir);
    return work;
  }

  // TWO commands that answer BARE PATHS rather than one `status --porcelain`,
  // and the reason is the runner: `runChild` trims its stdout, and porcelain's
  // record is `XY<space><path>` whose X is a space for every unstaged
  // modification — so the first record of the commonest case arrives a
  // character short and `index.html` is read as `ndex.html` (caught by the
  // route test). `--name-only` and `ls-files` have no prefix for a trim to
  // eat. `diff … HEAD` covers staged and unstaged alike, deletions included.
  const [tracked, untracked, ahead, trees] = await Promise.all([
    gitIn(dir, ["diff", "--name-only", "HEAD"]),
    gitIn(dir, ["ls-files", "--others", "--exclude-standard"]),
    gitIn(dir, ["rev-list", "--count", "@{upstream}..HEAD"]),
    leftoverWorktrees(dir),
  ]);

  const lines = (r: ChildResult): string[] =>
    (r.code === 0 ? r.stdout.split("\n") : []).map((l) => l.trim()).filter(Boolean);
  // An UNBORN HEAD makes the diff above fail; its staged additions are still
  // work that exists nowhere else, so they are asked for separately rather
  // than counted as nothing.
  const trackedNames = tracked.code === 0
    ? lines(tracked)
    : lines(await gitIn(dir, ["diff", "--name-only", "--cached"]));
  const changed = [...new Set([...trackedNames, ...lines(untracked)])].sort();
  work.dirtyCount = changed.length;
  work.dirty = changed.slice(0, MAX_DIRTY_LISTED);
  work.dirtyTruncated = changed.length > work.dirty.length;

  // A non-zero exit is "there is no upstream", which is `null` and not 0 — see
  // the interface. A repository with no commits at all answers the same way.
  const count = ahead.code === 0 ? Number(ahead.stdout.trim()) : Number.NaN;
  work.unpushed = Number.isFinite(count) ? count : null;
  if (work.unpushed === null) {
    const anyCommits = await gitIn(dir, ["rev-list", "--count", "HEAD"]);
    const total = anyCommits.code === 0 ? Number(anyCommits.stdout.trim()) : 0;
    // No upstream and commits of its own: every one of them is only here.
    work.unpushed = Number.isFinite(total) && total > 0 ? total : null;
  }

  work.worktrees = trees;
  work.any = work.dirtyCount > 0 || (work.unpushed ?? 0) > 0 || work.worktrees.length > 0;
  return work;
}

/**
 * Run copies still on disk under `.clawbox/worktrees`, by name.
 *
 * Read from the DIRECTORY rather than from `git worktree list`, deliberately: a
 * tree whose administrative record git has already pruned still has the owner's
 * files in it, and that is the thing being weighed. Never throws — a folder with
 * no `.clawbox` is the normal case and answers with none.
 */
async function leftoverWorktrees(directory: string): Promise<string[]> {
  const dir = path.join(path.resolve(directory), WORKTREES_DIR);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// ─── How big is it ───────────────────────────────────────────────────────────

/** What a directory takes up, as the dialog quotes it. */
export interface DirectorySize {
  bytes: number;
  files: number;
  /** The walk hit its bound and stopped; the figures are a floor, not a total. */
  truncated: boolean;
}

/**
 * The most entries the size walk visits before it gives up.
 *
 * A project folder with a `node_modules` in it is comfortably a quarter of a
 * million files, and this runs on a Jetson while the owner waits for a dialog to
 * open. Past the bound the answer is reported as a FLOOR (`truncated`) rather
 * than as a total, because "at least 900 MB" is honest and "900 MB" would not be.
 */
export const MAX_SIZE_WALK_ENTRIES = 40_000;

/**
 * Bytes and files under a folder, links counted as themselves and never
 * followed: a link into `/` must not make the dialog say the project is the size
 * of the disk. Iterative rather than recursive, so a pathological tree cannot
 * take the stack out.
 */
export async function directorySize(directory: string): Promise<DirectorySize> {
  const out: DirectorySize = { bytes: 0, files: 0, truncated: false };
  const queue = [path.resolve(directory)];
  let visited = 0;
  while (queue.length) {
    const dir = queue.pop()!;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++visited > MAX_SIZE_WALK_ENTRIES) {
        out.truncated = true;
        return out;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.lstat(full).catch(() => null);
      if (!stat) continue;
      out.bytes += stat.size;
      out.files += 1;
    }
  }
  return out;
}

// ─── The trash ───────────────────────────────────────────────────────────────

/** Where a removed project goes. Under `data/`, like every other store. */
export function projectTrashDir(): string {
  return path.join(DATA_DIR, "deleted-projects");
}

/** How long a removed project is kept before the prune takes it. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** How many removed projects are kept at once, whatever their age. */
export const MAX_TRASH_ENTRIES = 10;

/** The retention rule, in the two numbers a surface has to quote. */
export const TRASH_RETENTION_DAYS = Math.round(TRASH_RETENTION_MS / (24 * 60 * 60_000));

/** `<folder>--<YYYYMMDDTHHMMSSZ>` — the trash name this module writes. */
const TRASH_NAME_RE = /^(.+)--(\d{8}T\d{6}Z)$/;

function stampFor(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** The moment a trash name says it was written, or null when it is not one of ours. */
export function trashEntryTime(name: string): number | null {
  const m = TRASH_NAME_RE.exec(name);
  if (!m) return null;
  const [, , stamp] = m;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T`
    + `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

/**
 * Move the folder into the trash and answer where it went.
 *
 * `rename` first, which is atomic and instant on one filesystem. The owner's
 * project folder can perfectly well be a different mount from `data/` (a USB
 * disk, an NFS home), and `rename` answers EXDEV for that — so the fallback is
 * copy-then-remove, and its failure mode is handled in the safe direction: a
 * copy that did not finish is cleaned up and the refusal is raised with the
 * ORIGINAL still in place. A half-copied project that reported success is the
 * one outcome this function must never produce.
 */
export async function moveProjectToTrash(real: string, at: number): Promise<{ trashPath: string; trashName: string }> {
  const trash = projectTrashDir();
  await fs.promises.mkdir(trash, { recursive: true }).catch(() => {});
  const base = path.basename(real);
  const stamp = stampFor(at);

  // Two removals of the same folder inside one second is not a thing a person
  // does, but a retry that raced its own first attempt is — so the name is made
  // unique rather than assumed to be.
  let trashName = `${base}--${stamp}`;
  let trashPath = path.join(trash, trashName);
  for (let n = 2; fs.existsSync(trashPath) && n < 100; n += 1) {
    trashName = `${base}-${n}--${stamp}`;
    trashPath = path.join(trash, trashName);
  }

  try {
    await fs.promises.rename(real, trashPath);
    return { trashPath, trashName };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") {
      throw new ProjectDeleteError(
        "trash_failed",
        `This ClawBox could not move that folder aside: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    // `verbatimSymlinks`, so a link inside the project is copied as the link it
    // is rather than as a second copy of whatever it points at — which is both
    // what "put this folder back" means and what stops a link to `/` turning a
    // 4 MB project into a full disk.
    await fs.promises.cp(real, trashPath, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.promises.rm(real, { recursive: true, force: true });
    return { trashPath, trashName };
  } catch (err) {
    await fs.promises.rm(trashPath, { recursive: true, force: true }).catch(() => {});
    throw new ProjectDeleteError(
      "trash_failed",
      `This ClawBox could not move that folder aside, so nothing was removed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Apply the retention rule. Answers the names actually removed.
 *
 * Only entries this module named (`<folder>--<stamp>`) are ever considered — see
 * the header. Age first, then the count bound on whatever is left, oldest first.
 * Never throws: a prune that could not run is not a reason to fail the delete
 * that has already happened.
 */
export async function pruneProjectTrash(now = Date.now()): Promise<string[]> {
  const trash = projectTrashDir();
  const entries = await fs.promises.readdir(trash, { withFileTypes: true }).catch(() => []);
  const ours = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, at: trashEntryTime(e.name) }))
    .filter((e): e is { name: string; at: number } => e.at !== null)
    .sort((a, b) => a.at - b.at);

  const doomed = new Set<string>();
  for (const entry of ours) {
    if (now - entry.at >= TRASH_RETENTION_MS) doomed.add(entry.name);
  }
  const keeping = ours.filter((e) => !doomed.has(e.name));
  for (const entry of keeping.slice(0, Math.max(0, keeping.length - MAX_TRASH_ENTRIES))) {
    doomed.add(entry.name);
  }

  const removed: string[] = [];
  for (const name of doomed) {
    // This is the one `rm -r` in the file, and it is bounded three ways: the
    // folder is inside the trash this module owns, it carries a name this module
    // wrote, and it is past the retention rule stated in the header.
    const ok = await fs.promises.rm(path.join(trash, name), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    if (ok) removed.push(name);
  }
  return removed.sort();
}

// ─── What the dialog is shown, and what the button does ──────────────────────

/** Everything the delete dialog needs in order to state what it is about to do. */
export interface ProjectDeletePreview {
  folder: string;
  kind: CodingProjectKind;
  directory: string;
  size: DirectorySize;
  unsaved: UnsavedWork;
  liveRuns: LiveRunInProject[];
  /** Whether this project has a Vercel link that would go with it. */
  vercelLinked: boolean;
  /** The names of the project-scoped secrets that would go with it. */
  secretNames: string[];
  /** How many runs in the history worked here. They are KEPT — this is a count, not a warning. */
  runCount: number;
  retentionDays: number;
  /**
   * The refusal this project would meet right now, or null. `unsaved_work` is
   * reported here too even though the dialog can offer force past it: the whole
   * design of that button is that it appears only once the box has said exactly
   * what would be lost.
   */
  refusal: { code: ProjectDeleteRefusal; message: string } | null;
}

/** Everything a caller needs to know about a project before it decides. */
export async function previewProjectDelete(input: { folder: unknown; kind?: unknown }): Promise<ProjectDeletePreview> {
  const roots = await projectRoots();
  const target = await resolveProjectTarget(input, roots);

  const [size, unsaved, secretNames, vercelLink] = await Promise.all([
    directorySize(target.real),
    unsavedWorkIn(target.real),
    projectSecretNames(target.folder),
    readLink(target.folder),
  ]);
  const liveRuns = liveRunsInProject(target);
  const runCount = listRuns().filter((run) => belongsToProject(run, target)).length;

  return {
    folder: target.folder,
    kind: target.kind,
    directory: target.directory,
    size,
    unsaved,
    liveRuns,
    vercelLinked: vercelLink,
    secretNames,
    runCount,
    retentionDays: TRASH_RETENTION_DAYS,
    refusal: liveRuns.length
      ? { code: "live_run", message: liveRunMessage(target.folder, liveRuns) }
      : unsaved.any
        ? { code: "unsaved_work", message: unsavedMessage(target.folder, unsaved) }
        : null,
  };
}

/** What the owner is told when the project is gone. */
export interface ProjectDeleteOutcome {
  ok: true;
  folder: string;
  kind: CodingProjectKind;
  /** Where it was. */
  directory: string;
  /** Where it is now — the sentence the app shows afterwards. */
  trashPath: string;
  trashName: string;
  deletedAt: number;
  /** When the prune will take it, on the rule stated in this module's header. */
  keptUntil: number;
  retentionDays: number;
  /** Was a Vercel link taken down with it? */
  vercelLinkRemoved: boolean;
  /** The project-scoped secrets that went with it, by name. */
  secretsRemoved: string[];
  /** Older trash entries the retention rule removed on the way past. */
  pruned: string[];
  /** Runs that worked here and are KEPT — the app says so on each of their pages. */
  runsKept: number;
  /** It was removed over `unsaved_work` because the caller said so explicitly. */
  forced: boolean;
}

/**
 * Remove one project folder.
 *
 * `confirm` must be the folder's own name, exactly. Not a checkbox and not a
 * boolean: the request has to NAME the thing twice, so a body that reached this
 * route by any route other than the owner reading a dialog and typing cannot
 * satisfy it. The comparison is byte-for-byte against the name as resolved, so
 * "shop " does not delete "shop".
 *
 * `force` clears `unsaved_work` and nothing else. It exists because "this folder
 * has changes nowhere else" is a judgement only the owner can make, and the
 * dialog offers the flag only after the box has listed exactly what those
 * changes are.
 */
export async function deleteProject(input: {
  folder: unknown;
  kind?: unknown;
  confirm: unknown;
  force?: unknown;
  now?: number;
}): Promise<ProjectDeleteOutcome> {
  const roots = await projectRoots();
  const target = await resolveProjectTarget(input, roots);

  if (typeof input.confirm !== "string" || input.confirm !== target.folder) {
    throw new ProjectDeleteError(
      "confirm_mismatch",
      `To remove this project, type its folder name — ${target.folder} — exactly.`,
    );
  }

  const live = liveRunsInProject(target);
  if (live.length) throw new ProjectDeleteError("live_run", liveRunMessage(target.folder, live));

  const force = input.force === true;
  const unsaved = await unsavedWorkIn(target.real);
  if (unsaved.any && !force) throw new ProjectDeleteError("unsaved_work", unsavedMessage(target.folder, unsaved));

  const runsKept = listRuns().filter((run) => belongsToProject(run, target)).length;
  const deletedAt = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const { trashPath, trashName } = await moveProjectToTrash(target.real, deletedAt);

  // ONLY AFTER THE MOVE LANDED. The link and the secrets are the folder's
  // references, and taking them down first would leave a project that is still
  // on disk with its deploy target and its credentials gone — the worst of both
  // outcomes, and one nothing in the UI could explain. Each is caught on its own
  // so a store that cannot be written does not undo a removal that is already
  // complete; the answer then says what did NOT go, rather than claiming it did.
  const vercelLinkRemoved = await deleteVercelLink(target.folder).catch(() => false);
  const secretsRemoved = await deleteSecretsForScope(target.folder).catch(() => [] as string[]);
  const pruned = await pruneProjectTrash(deletedAt).catch(() => [] as string[]);

  return {
    ok: true,
    folder: target.folder,
    kind: target.kind,
    directory: target.directory,
    trashPath,
    trashName,
    deletedAt,
    keptUntil: deletedAt + TRASH_RETENTION_MS,
    retentionDays: TRASH_RETENTION_DAYS,
    vercelLinkRemoved,
    secretsRemoved,
    pruned,
    runsKept,
    forced: force && unsaved.any,
  };
}

// ─── The sentences, and the small readers behind the preview ─────────────────

function liveRunMessage(folder: string, runs: LiveRunInProject[]): string {
  const ids = runs.map((r) => r.id).join(", ");
  return runs.length === 1
    ? `A coding run is working in ${folder} right now (${ids}). Stop it first.`
    : `${runs.length} coding runs are working in ${folder} right now (${ids}). Stop them first.`;
}

function unsavedMessage(folder: string, work: UnsavedWork): string {
  if (work.notARepository) {
    return `${folder} has no git history of its own, so nothing in it is saved anywhere else.`;
  }
  const parts: string[] = [];
  if (work.dirtyCount > 0) parts.push(`${work.dirtyCount} uncommitted change${work.dirtyCount === 1 ? "" : "s"}`);
  if ((work.unpushed ?? 0) > 0) parts.push(`${work.unpushed} unpushed commit${work.unpushed === 1 ? "" : "s"}`);
  if (work.worktrees.length) parts.push(`${work.worktrees.length} leftover run cop${work.worktrees.length === 1 ? "y" : "ies"}`);
  return `${folder} has ${parts.join(", ")} that exist nowhere else.`;
}

/** Whether a run in the history worked in this project. The listing's own rule. */
function belongsToProject(run: CodingRun, target: Pick<ProjectTarget, "folder" | "kind" | "directory" | "real">): boolean {
  if (target.kind === "codeProject" && run.projectId === target.folder) return true;
  if (run.projectId) return false;
  if (typeof run.directory !== "string" || !run.directory) return false;
  const worked = path.resolve(projectDirectoryOf(run));
  return [target.directory, target.real].some((root) => {
    const resolved = path.resolve(root);
    return worked === resolved || worked.startsWith(resolved + path.sep);
  });
}

/**
 * The project-scoped secret NAMES, for the dialog's "what goes with it" list.
 *
 * Names only — that is all the store ever answers with, and all a dialog needs
 * in order to say "your VERCEL_TOKEN for this project goes too". A store this
 * box cannot read answers with none rather than taking the preview down: the
 * dialog's job is to describe the FOLDER, and it can still do that.
 */
async function projectSecretNames(folder: string): Promise<string[]> {
  return listSecrets()
    .then((secrets) => secrets.filter((s) => s.scope === folder).map((s) => s.name))
    .catch(() => []);
}

async function readLink(folder: string): Promise<boolean> {
  return readVercelLink(folder).then((link) => link !== null).catch(() => false);
}
