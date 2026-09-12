/**
 * A worktree per coding RUN: its own working tree, its own branch, on the
 * project's own repository.
 *
 * WHY. Until now every run worked in the project folder ITSELF and the box
 * allowed exactly one at a time — the two facts were the same fact. Two runs
 * in one tree edit each other's half-written files, and each settle commits
 * "whatever changed" (`git add -A`), so run A's commit carries run B's
 * unfinished edits. That is the defect the coding TEAM already solved for its
 * workers (coding-team-worktree.ts); this is the same answer for ordinary
 * runs, and it is what makes `coding_agent_max_parallel_runs` safe.
 *
 * WHERE. `<project>/.clawbox/worktrees/<runId>`, the team's own layout, so
 * the runner's containment rule (a run works in a folder INSIDE the project
 * folder) holds with no new exception, `.git/info/exclude` keeps it out of
 * `git status`, and the project tree route already skips `.clawbox`.
 *
 * WHEN NOT. Three cases keep the old behaviour of working in the folder
 * itself, and each is a deliberate answer rather than a gap:
 *
 *   - the folder is not a git repository. There is nothing to fork; the
 *     settle still `git init`s and commits, as it always has.
 *   - the folder is not the repository's own ROOT. `git worktree add` forks
 *     the whole repository, so the new tree would be rooted at that root and
 *     not at the sub-folder the run was pointed at — a different folder with
 *     a different meaning. Refused rather than silently relocated.
 *   - the repository is ClawBox's own checkout, which is where every code
 *     project lives. `startRunBranch` refuses to branch it for the same
 *     reason: a worktree of the product's own repository, made by a run, is
 *     not something a run may have.
 *
 * THE LOCK is the team's (`withDirLock`): two git operations on one checkout
 * share ONE index, and a worktree add racing a merge trips over
 * `.git/index.lock`. Run worktrees and team worktrees are on the same
 * checkouts, so they must be on the same lock — which is why that helper is
 * imported rather than copied.
 */

import fs from "fs";
import path from "path";
import { failureDetail, type ChildResult } from "./child-run";
import { excludeWorktrees, gitIn, withDirLock, WORKTREES_DIR } from "./coding-team-worktree";
import { runBranchName } from "./coding-pr-state";

const ok = (r: ChildResult) => r.code === 0;
const out = (r: ChildResult) => r.stdout.trim();

/** Why a run works in the project folder itself rather than in a worktree of its own. */
export type NoWorktreeReason = "no_repository" | "not_repository_root" | "protected_checkout" | "failed";

export interface RunWorktreeAdded {
  ok: true;
  /** Absolute path of the tree the run works in. */
  path: string;
  /** The branch checked out there — the run's own. */
  branch: string;
  /** The branch it was forked from, and the one a settle merges back into. */
  base: string;
}

export interface RunWorktreeRefused {
  ok: false;
  reason: NoWorktreeReason;
  detail: string;
}

/** `<project>/.clawbox/worktrees/<runId>` — the path, without touching the disk. */
export function runWorktreePath(projectDir: string, runId: string): string {
  return path.join(path.resolve(projectDir), WORKTREES_DIR, runId);
}

/** The branch a run's worktree checks out: `clawbox/<runId>`, the same name the auto-PR flow has always used. */
export { runBranchName };

/**
 * Give this run a worktree and a branch of its own, forked from whatever the
 * project checkout is on now.
 *
 * `protectedRoot` is the ClawBox checkout — never branched, never forked.
 */
export function addRunWorktree(input: {
  projectDir: string;
  runId: string;
  protectedRoot: string;
}): Promise<RunWorktreeAdded | RunWorktreeRefused> {
  return withDirLock(input.projectDir, () => addRunWorktreeNow(input));
}

async function addRunWorktreeNow({ projectDir, runId, protectedRoot }: {
  projectDir: string;
  runId: string;
  protectedRoot: string;
}): Promise<RunWorktreeAdded | RunWorktreeRefused> {
  const dir = path.resolve(projectDir);
  const top = await gitIn(dir, ["rev-parse", "--show-toplevel"]);
  if (!ok(top)) {
    // A folder git says is not a work tree is a FACT the caller acts on (the
    // run works in place and the settle makes the repository); a killed or
    // missing git is a failure, and the caller treats both the same way —
    // it simply must not be told the second is the first.
    const notARepo = top.code === 128 && !top.timedOut && !top.signal && /not a git repository/i.test(top.stderr);
    return {
      ok: false,
      reason: notARepo ? "no_repository" : "failed",
      detail: notARepo ? "Not a git repository yet." : failureDetail(top, "Reading the git repository"),
    };
  }
  const root = path.resolve(out(top));
  if (root === path.resolve(protectedRoot)) {
    return {
      ok: false,
      reason: "protected_checkout",
      detail: "This folder is inside ClawBox's own checkout, so a worktree would fork ClawBox itself.",
    };
  }
  if (root !== dir) {
    return {
      ok: false,
      reason: "not_repository_root",
      detail: `This folder is part of the repository at ${root} rather than being one, so a worktree of it would be a different folder.`,
    };
  }

  // Unborn HEAD: `git worktree add -b x <path> HEAD` has nothing to fork
  // from. Give the base branch one empty commit, exactly as startRunBranch
  // does and for the same reason — a fork needs something to fork from.
  const head = await gitIn(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!ok(head)) {
    const seeded = await gitIn(dir, ["commit", "--allow-empty", "-m", "Initial commit"]);
    if (!ok(seeded)) return { ok: false, reason: "failed", detail: failureDetail(seeded, "Making the first commit") };
  }
  const current = await gitIn(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = ok(current) && out(current) && out(current) !== "HEAD" ? out(current) : "main";
  const branch = runBranchName(runId);
  const target = runWorktreePath(dir, runId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, reason: "failed", detail: `Could not make the worktrees folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  const added = await gitIn(dir, ["worktree", "add", "-b", branch, target, base]);
  if (!ok(added)) return { ok: false, reason: "failed", detail: failureDetail(added, `Making a worktree for ${runId}`) };
  await excludeWorktrees(dir);
  linkSharedNodeModules(dir, target);
  return { ok: true, path: target, branch, base };
}

/**
 * `node_modules` from the project root, as a symlink, when the project has
 * one and the worktree does not.
 *
 * A fresh worktree has no dependencies, and `npm install` on a Jetson for
 * every run is minutes of disk and CPU for a tree that is about to be thrown
 * away. The link is what makes a worktree usable at once. Only the project's
 * OWN folder is linked (never a path outside it), it is never created over
 * anything already there, and a failure is silent: a run that has to install
 * its own dependencies is slow, not wrong.
 */
export function linkSharedNodeModules(projectDir: string, worktreePath: string): boolean {
  const source = path.join(path.resolve(projectDir), "node_modules");
  const target = path.join(path.resolve(worktreePath), "node_modules");
  try {
    if (!fs.statSync(source).isDirectory()) return false;
    // lstat, not exists: a dangling link left by an earlier run is still
    // something that is there, and replacing it is not this function's call.
    try {
      fs.lstatSync(target);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    fs.symlinkSync(source, target, "dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a worktree back where its record says it was — the resume path.
 *
 * A settle removes the worktree of a run that left nothing behind, and
 * `resumeRun` refuses a run whose folder is gone. The branch is still there,
 * so the tree can be made again from it and the resume carries on. `true`
 * when the path is usable afterwards, whether it was there already or not.
 */
export function restoreRunWorktree(projectDir: string, worktreePath: string, branch: string): Promise<boolean> {
  return withDirLock(projectDir, async () => {
    try {
      if (fs.statSync(worktreePath).isDirectory()) return true;
    } catch {
      // not there: make it
    }
    const dir = path.resolve(projectDir);
    // A record of the removed tree can outlive its files; without this the
    // add is refused with "already registered".
    await gitIn(dir, ["worktree", "prune"]);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const added = await gitIn(dir, ["worktree", "add", worktreePath, branch]);
    if (!ok(added)) return false;
    linkSharedNodeModules(dir, worktreePath);
    return true;
  });
}

/** The worktree's files go; the branch stays as history unless the caller asks otherwise. */
export function removeRunWorktree(projectDir: string, worktreePath: string): Promise<void> {
  return withDirLock(projectDir, async () => {
    await gitIn(path.resolve(projectDir), ["worktree", "remove", "--force", worktreePath]);
    await gitIn(path.resolve(projectDir), ["worktree", "prune"]);
  });
}

/** Delete a branch this box made and nothing needs. Force, because an unmerged run branch is exactly what the caller has decided to drop. */
export function deleteRunBranch(projectDir: string, branch: string): Promise<boolean> {
  return withDirLock(projectDir, async () => ok(await gitIn(path.resolve(projectDir), ["branch", "-D", branch])));
}

/** How many commits `branch` has that `base` does not. 0 means the run left nothing on it; null means git could not say. */
export async function commitsAhead(projectDir: string, branch: string, base: string): Promise<number | null> {
  const r = await gitIn(path.resolve(projectDir), ["rev-list", "--count", `${base}..${branch}`]);
  if (!ok(r)) return null;
  const n = Number(out(r));
  return Number.isFinite(n) ? n : null;
}

/**
 * Is every commit on `branch` already reachable from somewhere that keeps it?
 *
 * `base` first, because that is where a settle merges a run's work. The
 * remote tracking branch of the base as well, since a run whose pull request
 * was merged on GitHub has its commits in `origin/<base>` and nowhere local —
 * the sweep must not read that as work about to be lost. Null when git could
 * not answer, which every caller reads as "keep it".
 */
export async function branchIsMerged(projectDir: string, branch: string, base: string): Promise<boolean | null> {
  const dir = path.resolve(projectDir);
  let asked = false;
  for (const into of [base, `origin/${base}`]) {
    const exists = await gitIn(dir, ["rev-parse", "--verify", "--quiet", `${into}^{commit}`]);
    if (!ok(exists)) continue;
    asked = true;
    const ahead = await commitsAhead(dir, branch, into);
    if (ahead === null) continue;
    if (ahead === 0) return true;
  }
  return asked ? false : null;
}

/** Does this branch still exist? A branch the owner deleted by hand is not work to protect. */
export async function branchExists(projectDir: string, branch: string): Promise<boolean> {
  const r = await gitIn(path.resolve(projectDir), ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return ok(r) && out(r) !== "";
}

/** One linked worktree of a repository, as `git worktree list --porcelain` reports it. */
export interface LinkedWorktree {
  path: string;
  branch: string | null;
}

/**
 * The repository's linked worktrees UNDER `.clawbox/worktrees` — the box's
 * own, never the owner's. Parsed from `--porcelain`, whose records are blank-
 * line separated `worktree <path>` / `branch refs/heads/<name>` lines; the
 * first record is the main checkout and has no `.clawbox` in its path.
 */
export async function listRunWorktrees(projectDir: string): Promise<LinkedWorktree[]> {
  const dir = path.resolve(projectDir);
  const r = await gitIn(dir, ["worktree", "list", "--porcelain"]);
  if (!ok(r)) return [];
  const prefix = path.join(dir, WORKTREES_DIR) + path.sep;
  const found: LinkedWorktree[] = [];
  let current: { path: string; branch: string | null } | null = null;
  const flush = () => {
    if (current && path.resolve(current.path).startsWith(prefix)) found.push(current);
    current = null;
  };
  for (const line of r.stdout.split("\n")) {
    const text = line.trim();
    if (!text) {
      flush();
      continue;
    }
    if (text.startsWith("worktree ")) {
      flush();
      current = { path: text.slice("worktree ".length), branch: null };
    } else if (text.startsWith("branch ") && current) {
      current.branch = text.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return found;
}

/** How old a worktree has to be before the sweep will even look at it. */
export const WORKTREE_SWEEP_AGE_MS = 14 * 24 * 60 * 60_000;

export interface SweepOutcome {
  removed: string[];
  kept: string[];
}

/**
 * Prune the run worktrees this project has accumulated: older than
 * `olderThanMs`, and only where the branch is merged or gone.
 *
 * The age is the WORKTREE's own mtime, not the run record's: records are
 * trimmed to thirty and a worktree can outlive the run that made it, so the
 * folder is the only thing that can still say when it was last touched. A
 * worktree with unmerged commits is never removed however old it is — that is
 * work nobody has looked at, and disk is cheaper than losing it.
 */
export async function sweepRunWorktrees(projectDir: string, options: {
  olderThanMs?: number;
  /** Paths a live run is working in right now; never touched whatever their age. */
  inUse?: ReadonlySet<string>;
  now?: number;
} = {}): Promise<SweepOutcome> {
  const { olderThanMs = WORKTREE_SWEEP_AGE_MS, inUse, now = Date.now() } = options;
  const dir = path.resolve(projectDir);
  const outcome: SweepOutcome = { removed: [], kept: [] };
  const trees = await listRunWorktrees(dir);
  if (trees.length === 0) return outcome;
  const base = await currentBranch(dir);
  for (const tree of trees) {
    const resolved = path.resolve(tree.path);
    if (inUse?.has(resolved)) {
      outcome.kept.push(resolved);
      continue;
    }
    let age: number;
    try {
      age = now - fs.statSync(resolved).mtimeMs;
    } catch {
      // The files are gone and only git's record of them is left: prune it.
      await removeRunWorktree(dir, resolved);
      outcome.removed.push(resolved);
      continue;
    }
    if (age < olderThanMs) {
      outcome.kept.push(resolved);
      continue;
    }
    if (tree.branch) {
      const merged = await branchIsMerged(dir, tree.branch, base);
      // `null` is "git could not say", which is not permission to delete.
      if (merged !== true) {
        outcome.kept.push(resolved);
        continue;
      }
    }
    await removeRunWorktree(dir, resolved);
    if (tree.branch) await deleteRunBranch(dir, tree.branch);
    outcome.removed.push(resolved);
  }
  return outcome;
}

/** What the main checkout is on, or "main" when git will not say (a detached HEAD, a fresh repository). */
export async function currentBranch(projectDir: string): Promise<string> {
  const r = await gitIn(path.resolve(projectDir), ["rev-parse", "--abbrev-ref", "HEAD"]);
  return ok(r) && out(r) && out(r) !== "HEAD" ? out(r) : "main";
}
