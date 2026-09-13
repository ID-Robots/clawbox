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
 * NOTHING HERE IS IRREVERSIBLE. There is no `rm -rf` of a project in this file.
 * A removed project is MOVED — into `<its own root>/.deleted-projects/<folder>--<timestamp>`
 * — and the answer says where it went, so the owner can carry it back with `mv`
 * if the click was a mistake. The whole point is that the destructive-sounding
 * button is not actually destructive for a month: see RETENTION below.
 *
 * THE TRASH SITS IN THE PROJECT'S OWN ROOT, and that is a SAFETY property
 * rather than a filing preference. A project is a folder directly inside its
 * root, so a folder beside it in that same root is on the same filesystem as it
 * — which makes `rename` atomic, and the move therefore all-or-nothing.
 *
 * When the trash lived under `data/` that was not true: the owner's project
 * folder can be a different mount (a USB disk, an NFS home), `rename` answered
 * EXDEV, and the fallback was copy-then-remove — a recursive copy with a live
 * window in the middle. An audit lost a file down exactly that window: a run
 * started during the copy and wrote into the original after that part of it had
 * been copied, so the remove took the only version there was. The fallback is
 * GONE, and with it the fifty lines that existed to make a half-finished copy
 * survivable. A `rename` that still fails is now a refusal with the project
 * untouched (`trash_failed`); only a project folder that is ITSELF a mount
 * point can produce one, and refusing there loses nothing.
 *
 * It is a DOT folder because `readFolderNames` skips those: the trash must not
 * come back as a row in the projects listing with a Delete button of its own.
 * `resolveProjectTarget` refuses the name outright for the same reason.
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
 * RETENTION IS TWO BOUNDS, AND BOTH ARE THE OWNER'S BUSINESS. A folder in the
 * trash is kept for UP TO thirty days, and only while it is among the
 * `MAX_TRASH_ENTRIES` (10) most recently removed. The prune runs after each
 * successful delete, oldest first, and applies both. The count is counted ACROSS
 * the roots, not per root: "this box keeps the 10 most recently removed
 * projects" is what the dialog says, and a per-root bound would make that
 * sentence wrong by a factor of the number of roots.
 *
 * The count bound is not housekeeping detail: it is the bound that makes "kept
 * for 30 days" FALSE. An eleventh removal deletes the oldest for good, possibly
 * minutes after it was put there, and for a while this module reported only
 * `retentionDays` — so the dialog promised a month and the box could take the
 * folder the same afternoon. That is a consent defect, not a rounding error:
 * the owner agreed to a recoverable delete on the strength of the sentence they
 * were shown. So `planTrashPrune` says which entries go for WHICH reason,
 * `trashPurgedByOneMore` lets the preview name what this removal would take
 * before it is done, and both bounds travel on the preview and the outcome.
 * The count stays, because an appliance cannot keep an unbounded shelf of whole
 * project folders; what changed is that it is now stated.
 *
 * The timestamp in the name is the record — nothing else is written, so a
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
import { beginProjectRemoval, runStartingIn } from "@/lib/coding-project-removal-lock";
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
  /**
   * The trash is full of projects still inside their thirty days, so this
   * removal would delete one of them for good.
   *
   * Its own refusal rather than a silent purge with a warning beside it: the
   * folders at risk are OTHER projects the owner was promised a month for, and
   * "informed" is not the same as "authorised". Cleared by `purgeOldest`, which
   * the dialog offers only once it has named what would go.
   */
  | "trash_full"
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
  trash_full: 409,
  trash_failed: 500,
};

// The run half of this exclusion lives in `assertDirectoryFree`
// (coding-agent.ts); the set itself is a leaf module both can import without
// closing a cycle. Re-exported here so a caller of this library has one import.
export { beginProjectRemoval, isProjectBeingRemoved } from "@/lib/coding-project-removal-lock";

// ─── The roots ───────────────────────────────────────────────────────────────

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
    // The same join `listProjects` makes.
    codeProjects: path.join(DATA_DIR, "code-projects"),
    // `DATA_DIR` is `<clawbox>/data`, so its parent is the product's own
    // repository — the derivation `protectedCheckout()` makes in coding-agent.ts
    // for the worktree guard, spelled again rather than exported from a
    // 10,000-line module for one line.
    checkout: path.dirname(DATA_DIR),
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

/**
 * Is `child` anywhere UNDER `parent` — at any depth, and never `parent` itself?
 *
 * The other half of the containment arithmetic. `isDirectlyInside` answers the
 * question a project has to pass; this answers the question the two guards below
 * it ask — "does this folder hold something it must not take with it" — where
 * depth is exactly what matters.
 */
function contains(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c !== p && c.startsWith(p + path.sep);
}

/** A folder name, checked before it is ever joined to a root. */
const FOLDER_RE = /^[^/\\\0]+$/;

function requireFolderName(folder: unknown): string {
  if (typeof folder !== "string" || !folder.trim()) {
    throw new ProjectDeleteError("invalid", "Name the project to remove.");
  }
  // NOT TRIMMED, and that is the whole of this line's job. A trailing space is a
  // perfectly legal character in a folder name on Linux, and `listProjects`
  // hands one to the app exactly as it found it — so trimming here made
  // `"shop "` resolve to `"shop"`, a DIFFERENT project, and the dialog would
  // have named one folder while the box moved another. The worst outcome this
  // feature has, reachable from an ordinary row. A name that is nothing BUT
  // whitespace is still refused above: no listing produces one, and it is far
  // more likely to be a caller's mistake than a folder.
  const name = folder;
  // Rebuilt-from-nothing is not available here — a folder of the owner's may be
  // called anything their filesystem allows — so the rule is what a single path
  // SEGMENT is: no separator, no NUL, and never a traversal segment. A name that
  // fails this is refused before `path.join` gets a chance to climb.
  if (!FOLDER_RE.test(name) || name === "." || name === "..") {
    throw new ProjectDeleteError("invalid", "A project is one folder name, not a path.");
  }
  // The trash lives in the same root as the projects, so its own name is a
  // folder directly inside a root and would otherwise pass every check below.
  // Removing it would move the box's whole shelf of recoverable projects into
  // itself. The listing never offers it (`readFolderNames` skips dot names);
  // this is the floor under a caller that names it anyway.
  if (name === TRASH_DIR_NAME) {
    throw new ProjectDeleteError("invalid", "That is where this ClawBox keeps removed projects, not a project.");
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
  /**
   * The root this project sits directly inside — carried rather than re-derived.
   *
   * It is where the trash goes, and therefore the whole of the same-filesystem
   * guarantee. Settled HERE, by the one function that has already proved the
   * folder is directly inside it, so no later step has to ask again and get a
   * different answer.
   */
  root: string;
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
  // AND a folder that HOLDS the checkout, which the equality above let through.
  // The owner's project folder is normally nowhere near the checkout, but
  // config.json is a file they can edit — `listProjects` defends against a
  // hand-set project folder for the same reason — and one pointed a level or two
  // above the checkout makes the folder containing the running OS an ordinary
  // row in the list with a Delete button on it.
  //
  // Today the move itself would fail anyway: the trash lives INSIDE the
  // checkout, so renaming an ancestor of it into that trash is a rename into
  // the folder's own descendant, which the kernel answers EINVAL and `fs.cp`
  // refuses outright. That is the filesystem saving us, not this guard, and what
  // the owner would see is a raw errno instead of the reason. Refused here, by
  // name, before anything is touched.
  if (contains(real, realCheckout) || contains(real, checkout)) {
    throw new ProjectDeleteError(
      "protected_checkout",
      "That folder holds ClawBox's own checkout — the operating system this box is running — so removing it would take the box with it.",
    );
  }

  return { folder, kind: found.kind, directory: found.directory, real, root: base };
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
  /**
   * Commits on ANY local branch that no remote has. Null only when git could
   * not be asked.
   *
   * `--branches --not --remotes`, deliberately, and not `@{upstream}..HEAD`:
   * the upstream form asks only about the branch that happens to be checked
   * out, so a finished feature branch nobody pushed reported ZERO and the
   * folder deleted without `force`. A project with no remote at all answers its
   * whole history, which is the right number — none of it is anywhere else.
   */
  unpushed: number | null;
  /**
   * Entries on the stash. They live in `refs/stash` and in nothing else: no
   * branch carries them, no push takes them, and `git status` is silent about
   * them — so a folder with three stashed experiments looked spotless.
   */
  stashes: number;
  /**
   * IGNORED files and folders the project keeps, collapsed to one entry per
   * ignored directory (`--directory`), bounded like `dirty`.
   *
   * Counted as work that exists nowhere else, because that is what it is: git
   * ignores `node_modules/` and it ignores `app.db` and `.env` by exactly the
   * same rule, and the box cannot tell a reproducible one from the only copy of
   * a database. Listing them by name is what lets the OWNER tell the difference
   * before they agree — which is the whole shape of the force flag.
   */
  ignored: string[];
  ignoredCount: number;
  ignoredTruncated: boolean;
  /** Leftover run copies under `.clawbox/worktrees`, by folder name. */
  worktrees: string[];
  /**
   * The folder has no repository OF ITS OWN.
   *
   * True for a plain folder, and true for one NESTED inside somebody else's
   * repository — a code project under the ClawBox checkout, say. That second
   * case is why this is decided by `--show-toplevel` and not by
   * `--is-inside-work-tree`: the inside test answers YES for a nested folder,
   * and every check below it then ran against the PARENT repository, which is
   * clean and pushed and knows nothing about the folder being removed. It
   * reported spotless and deleted without `force`.
   */
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
  stashes: 0,
  ignored: [],
  ignoredCount: 0,
  ignoredTruncated: false,
  worktrees: [],
  notARepository: false,
  any: false,
});

export async function unsavedWorkIn(directory: string): Promise<UnsavedWork> {
  const dir = path.resolve(directory);
  const work = emptyWork();

  // `--show-toplevel`, NOT `--is-inside-work-tree`. See `notARepository`: the
  // inside test says yes for a folder nested in somebody else's repository, and
  // every check below would then have described that OTHER repository.
  const top = await gitIn(dir, ["rev-parse", "--show-toplevel"]);
  const topLevel = top.code === 0 ? path.resolve(top.stdout.trim()) : null;
  if (!topLevel || topLevel !== dir) {
    // No history of its own — a plain folder, or one inside a repository that
    // is not it. Either way nothing here is known to be saved anywhere else,
    // and that is what a force flag is for.
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
  const [tracked, untracked, ignored, ahead, stashed, trees] = await Promise.all([
    gitIn(dir, ["diff", "--name-only", "HEAD"]),
    gitIn(dir, ["ls-files", "--others", "--exclude-standard"]),
    // One entry per ignored DIRECTORY rather than per file inside it, or a
    // project with a `node_modules` would answer thirty thousand paths.
    gitIn(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]),
    // Every local branch, minus everything any remote holds. See `unpushed`.
    gitIn(dir, ["rev-list", "--count", "--branches", "--not", "--remotes"]),
    gitIn(dir, ["stash", "list", "--format=%H"]),
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

  const ignoredNames = lines(ignored).sort();
  work.ignoredCount = ignoredNames.length;
  work.ignored = ignoredNames.slice(0, MAX_DIRTY_LISTED);
  work.ignoredTruncated = ignoredNames.length > work.ignored.length;

  // Null ONLY when git could not answer. A repository with no remote answers
  // its whole history here, which is the honest number.
  const count = ahead.code === 0 ? Number(ahead.stdout.trim()) : Number.NaN;
  work.unpushed = Number.isFinite(count) ? count : null;

  work.stashes = lines(stashed).length;
  work.worktrees = trees;
  work.any = work.dirtyCount > 0
    || (work.unpushed ?? 0) > 0
    || work.stashes > 0
    || work.ignoredCount > 0
    || work.worktrees.length > 0;
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

/**
 * The trash folder's name, inside whichever root the project lived in.
 *
 * A DOT name, so `readFolderNames` (coding-agent.ts) leaves it out of the
 * projects listing — otherwise the owner's deleted projects would arrive back
 * as a project called `.deleted-projects` with a Delete button on it.
 */
export const TRASH_DIR_NAME = ".deleted-projects";

/**
 * Where a removed project goes: beside it, in its own root.
 *
 * Same root means same filesystem means an atomic `rename` — see the header.
 * The root, not `DATA_DIR`, is the whole point of the argument.
 */
export function projectTrashDir(root: string): string {
  return path.join(path.resolve(root), TRASH_DIR_NAME);
}

/** Every trash folder on this box — one per root that exists. */
function trashDirs(roots: ProjectRoots): string[] {
  return [roots.ownerFolder, roots.codeProjects]
    .filter((r): r is string => typeof r === "string" && !!r)
    .map(projectTrashDir);
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
 * Move the folder into its root's trash and answer where it went.
 *
 * ONE `rename`, and nothing else. The trash is a folder in the same root as the
 * project, so the two are on the same filesystem and the rename is atomic: the
 * project is either where it was or where it went, never spread across both and
 * never half of each.
 *
 * There is deliberately NO copy-then-remove fallback. It existed because the
 * trash used to live under `data/`, which can be a different mount from the
 * owner's project folder — and it was the one path in this feature that could
 * lose a file outright (see the header). A `rename` that fails now is refused
 * with the project untouched, which is the honest answer and costs nothing.
 */
export async function moveProjectToTrash(real: string, root: string, at: number): Promise<{ trashPath: string; trashName: string }> {
  const trash = projectTrashDir(root);
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
  } catch (err) {
    // EXDEV lands here like any other errno. The only arrangement that still
    // produces it is a project folder that is itself a mount point, and the
    // right answer to that is the same as for a permission error: say so, and
    // leave the folder exactly where it is.
    throw new ProjectDeleteError(
      "trash_failed",
      `This ClawBox could not move that folder aside, so nothing was removed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { trashPath, trashName };
}

/** One trash entry, as the prune arithmetic sees it. */
interface TrashEntry {
  name: string;
  at: number;
  /** Which root's trash it is in — there is one per root, and the bounds span both. */
  dir: string;
}

/** What a prune would take, and WHY — the two reasons said apart. */
export interface TrashPrunePlan {
  /** Past the thirty days. Nobody was promised these. */
  expired: string[];
  /**
   * Taken by the COUNT bound while still inside their thirty days.
   *
   * This list is the whole reason the plan is split. "Kept for 30 days" is what
   * the dialog says, and for these entries it is not true — they go early so the
   * shelf stays the size an appliance can afford. A surface that cannot name
   * them cannot tell the owner the truth about their own consent.
   */
  early: string[];
}

/** What the prune actually managed to remove, beside the plan it was working to. */
export interface TrashPruneOutcome extends TrashPrunePlan {
  /** Everything that really went — `expired` and `early` minus anything that would not delete. */
  removed: string[];
}

/**
 * Which entries the rule takes, given the shelf and how many more are arriving.
 *
 * Pure, so the PREVIEW and the prune itself work from one piece of arithmetic:
 * the preview asks with `incoming = 1` (the folder about to be moved is not
 * there yet) and the real prune with `incoming = 0` (by then it is). Without
 * that the dialog could not say "removing this one takes that one with it"
 * before the owner had already done it.
 *
 * Age first, then the count bound on whatever is left, oldest first. An arriving
 * entry is by definition the newest, so it is never among the early ones.
 */
function selectTrashPrune(entries: readonly TrashEntry[], now: number, incoming: number): { expired: TrashEntry[]; early: TrashEntry[] } {
  const expired = entries.filter((e) => now - e.at >= TRASH_RETENTION_MS);
  // By IDENTITY and not by name: two roots can each hold a `shop--<stamp>`, and
  // a name-keyed set would drop one of them out of the count.
  const doomed = new Set<TrashEntry>(expired);
  const keeping = entries.filter((e) => !doomed.has(e));
  const overflow = Math.max(0, keeping.length + incoming - MAX_TRASH_ENTRIES);
  return { expired, early: keeping.slice(0, overflow) };
}

/**
 * The trash as it stands, oldest first, entries this module named and no others.
 *
 * ACROSS EVERY ROOT, because the count bound the owner is promised is one
 * number for the box. Reading only one root would let a box with two roots keep
 * twice what the dialog says it keeps.
 */
async function readTrashEntries(roots: ProjectRoots): Promise<TrashEntry[]> {
  const perDir = await Promise.all(trashDirs(roots).map(async (dir) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, at: trashEntryTime(e.name), dir }));
  }));
  return perDir
    .flat()
    .filter((e): e is TrashEntry => e.at !== null)
    .sort((a, b) => a.at - b.at);
}

/**
 * What removing one more project would take out of the trash early.
 *
 * The preview's half of the arithmetic above. Answers the names alone, because
 * that is what the dialog has to put in front of the owner before they agree to
 * anything — the count bound is not a detail of housekeeping when it is the
 * thing that makes "kept for 30 days" untrue.
 */
export async function trashPurgedByOneMore(roots: ProjectRoots, now = Date.now()): Promise<{ count: number; early: string[] }> {
  const entries = await readTrashEntries(roots);
  return { count: entries.length, early: selectTrashPrune(entries, now, 1).early.map((e) => e.name) };
}

/**
 * Apply the retention rule. Answers what went and under which of the two bounds.
 *
 * Only entries this module named (`<folder>--<stamp>`) are ever considered — see
 * the header. Never throws: a prune that could not run is not a reason to fail
 * the delete that has already happened.
 */
export async function pruneProjectTrash(roots: ProjectRoots, now = Date.now()): Promise<TrashPruneOutcome> {
  const { expired, early } = selectTrashPrune(await readTrashEntries(roots), now, 0);

  const removed: string[] = [];
  for (const entry of [...expired, ...early]) {
    // This is the one `rm -r` in the file, and it is bounded three ways: the
    // folder is inside a trash this module owns, it carries a name this module
    // wrote, and it is past one of the two bounds stated in the header.
    const ok = await fs.promises.rm(path.join(entry.dir, entry.name), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    if (ok) removed.push(entry.name);
  }
  return {
    expired: expired.map((e) => e.name),
    early: early.map((e) => e.name),
    removed: removed.sort(),
  };
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
   * The OTHER half of the retention rule, and it has to travel with the first.
   *
   * The trash holds at most this many removed projects. A dialog handed
   * `retentionDays` alone can only promise "kept for 30 days", which stops being
   * true the moment an eleventh removal arrives — possibly minutes later. Two
   * numbers, because the rule is two numbers.
   */
  retentionMax: number;
  /** How many removed projects are on the shelf right now. */
  trashCount: number;
  /**
   * What THIS removal would delete for good, straight away, to make room.
   *
   * Empty almost always. When it is not, the dialog must say so before the
   * owner agrees: these are folders still inside their thirty days, and nothing
   * else on any surface would tell them.
   */
  wouldPurge: string[];
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
  const shelf = await trashPurgedByOneMore(roots);

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
    retentionMax: MAX_TRASH_ENTRIES,
    trashCount: shelf.count,
    wouldPurge: shelf.early,
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
  /**
   * The LATEST the prune will take it — the age bound alone.
   *
   * Not a guarantee, and the field below is why: the count bound can take this
   * folder earlier, once `retentionMax` newer removals have arrived. Read
   * together with `retentionMax`, never on its own.
   */
  keptUntil: number;
  retentionDays: number;
  /** The count bound. See `ProjectDeletePreview.retentionMax`. */
  retentionMax: number;
  /** Was a Vercel link taken down with it? */
  vercelLinkRemoved: boolean;
  /** The project-scoped secrets that went with it, by name. */
  secretsRemoved: string[];
  /**
   * The path of a project that still answers to the same scope, when one does —
   * in which case the secrets and the Vercel link were deliberately LEFT.
   *
   * Null in the ordinary case. When it is not null, `secretsRemoved` is empty
   * and `vercelLinkRemoved` false because another project is still using them,
   * not because there were none.
   */
  metadataKeptFor: string | null;
  /** Older trash entries the retention rule removed on the way past. */
  pruned: string[];
  /**
   * Of those, the ones taken EARLY by the count bound — still inside their
   * thirty days when this removal pushed them off the shelf.
   *
   * Reported apart from `pruned` because they are the only ones the owner was
   * told would be kept. The dialog names them; an expired entry needs no
   * sentence at all.
   */
  prunedEarly: string[];
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
  purgeOldest?: unknown;
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

  // CLAIMED FIRST, and synchronously, so no run can be let into this folder
  // while the checks below are running — see `beginProjectRemoval`. Everything
  // from here to the move is inside the claim.
  const release = beginProjectRemoval(target.real);
  try {
    assertNobodyWorkingIn(target);

    const force = input.force === true;
    const unsaved = await unsavedWorkIn(target.real);
    if (unsaved.any && !force) throw new ProjectDeleteError("unsaved_work", unsavedMessage(target.folder, unsaved));

    // Would this removal delete somebody ELSE's recoverable project? Refused
    // rather than warned about: those folders are inside the thirty days they
    // were promised, and the owner has to say yes to losing them by name.
    const deletedAt = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
    const shelf = await trashPurgedByOneMore(roots, deletedAt);
    if (shelf.early.length && input.purgeOldest !== true) {
      throw new ProjectDeleteError("trash_full", trashFullMessage(shelf.early));
    }

    // THE LAST LOOK, immediately before the move and after every await above.
    // A run whose record landed while the git checks were running would not
    // have been seen by the first check.
    assertNobodyWorkingIn(target);

    const runsKept = listRuns().filter((run) => belongsToProject(run, target)).length;
    const { trashPath, trashName } = await moveProjectToTrash(target.real, target.root, deletedAt);

    // ONLY AFTER THE MOVE LANDED. The link and the secrets are the folder's
    // references, and taking them down first would leave a project that is still
    // on disk with its deploy target and its credentials gone — the worst of both
    // outcomes, and one nothing in the UI could explain. Each is caught on its own
    // so a store that cannot be written does not undo a removal that is already
    // complete; the answer then says what did NOT go, rather than claiming it did.
    //
    // AND NOT AT ALL when another project still answers to the same scope: a
    // folder project and a code project may share a name, the secret store and
    // the Vercel link are keyed by that name alone, and clearing them here took
    // the credentials of a project that is still on disk and possibly mid-run.
    // Moving the removed folder back would not bring them back either.
    const sharedWith = await otherProjectWithSameScope(target, roots);
    const vercelLinkRemoved = sharedWith ? false : await deleteVercelLink(target.folder).catch(() => false);
    const secretsRemoved = sharedWith ? [] : await deleteSecretsForScope(target.folder).catch(() => [] as string[]);
    const pruned = await pruneProjectTrash(roots, deletedAt)
      .catch(() => ({ removed: [] as string[], expired: [] as string[], early: [] as string[] }));

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
      retentionMax: MAX_TRASH_ENTRIES,
      vercelLinkRemoved,
      secretsRemoved,
      metadataKeptFor: sharedWith,
      pruned: pruned.removed,
      // Only the ones that were REALLY removed AND were early: a plan entry the
      // `rm` could not take is still on the shelf and must not be reported gone.
      prunedEarly: pruned.early.filter((name) => pruned.removed.includes(name)),
      runsKept,
      forced: force && unsaved.any,
    };
  } finally {
    release();
  }
}

/**
 * Refuse if anybody is working in this project — or is about to be.
 *
 * TWO QUESTIONS, and the second is the one an audit got past. `listRuns` knows
 * about runs that have been WRITTEN to the store; it knows nothing about a run
 * that cleared `assertDirectoryFree` a moment ago and is still several awaits
 * from `insertRun`. That run has already been told it may have this folder, so
 * a removal that only asked the store moved the project out from under it —
 * and no amount of re-checking the store later would have found it, because it
 * is not in the store yet. `runStartingIn` is the claim that start leaves
 * behind; see coding-project-removal-lock.ts for why the two cannot miss each
 * other.
 *
 * Both spellings of the folder are asked about, because a run records the
 * directory it works in symlink-resolved and the listing shows it as typed.
 */
function assertNobodyWorkingIn(target: ProjectTarget): void {
  const live = liveRunsInProject(target);
  if (live.length) throw new ProjectDeleteError("live_run", liveRunMessage(target.folder, live));
  if (runStartingIn(target.real) || runStartingIn(target.directory)) {
    throw new ProjectDeleteError(
      "live_run",
      `A coding run is starting in ${target.folder} right now. Wait for it to appear, then stop it.`,
    );
  }
}

/**
 * The OTHER project that answers to the same secret scope, if there is one.
 *
 * A folder project and a code project may both be called `shop`, and
 * `projectScopeFor` resolves both to `"shop"` — so the secret store and the
 * Vercel link cannot tell them apart. Answers that project's path, so the
 * removal can say WHY it left the credentials alone.
 */
async function otherProjectWithSameScope(target: ProjectTarget, roots: ProjectRoots): Promise<string | null> {
  const otherBase = target.kind === "folder" ? roots.codeProjects : roots.ownerFolder;
  if (!otherBase) return null;
  const candidate = path.join(path.resolve(otherBase), target.folder);
  if (path.resolve(candidate) === target.real) return null;
  // `stat` and not `lstat`: a link in the other root pointing at a real project
  // folder is still a project the owner uses, and its secrets are still filed
  // under this scope. Every error this can answer — no such entry, a dangling
  // link, a loop — means "nothing of the sort is there", which is the same
  // `null`. The direction of the doubt is deliberate: a false POSITIVE only
  // leaves credentials in place, while a false negative deletes the working
  // project's own.
  const entry = await fs.promises.stat(candidate).catch(() => null);
  return entry?.isDirectory() ? candidate : null;
}

function trashFullMessage(early: string[]): string {
  const names = early.join(", ");
  return `This ClawBox is already keeping ${MAX_TRASH_ENTRIES} removed projects, all of them still inside their ${TRASH_RETENTION_DAYS} days.`
    + ` Removing another would delete ${names} for good. Say so explicitly, or empty the deleted projects first.`;
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
  if (work.stashes > 0) parts.push(`${work.stashes} stashed change${work.stashes === 1 ? "" : "s"}`);
  if (work.ignoredCount > 0) parts.push(`${work.ignoredCount} ignored file${work.ignoredCount === 1 ? "" : "s"}`);
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
