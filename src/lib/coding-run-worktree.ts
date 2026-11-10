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
import path from "./runtime-path";
import { failureDetail, type ChildResult } from "./child-run";
import { excludeWorktrees, forkBase, gitIn, putBackFavicons, readCheckout, setAsideFavicons, TEAM_BRANCH_RE, withDirLock, WORKTREES_DIR } from "./coding-team-worktree";
import { codingGitIdentityArgs } from "./coding-git-identity";
import { runBranchName } from "./coding-pr-state";
import { writeRunMarker } from "./coding-folder-kind";

const ok = (r: ChildResult) => r.code === 0;
const out = (r: ChildResult) => r.stdout.trim();

/**
 * Who the box commits as, in THIS project.
 *
 * Needed on every call here that can CREATE a commit — the empty first commit
 * and the merge home. The environment these calls run in is built from
 * nothing (see `gitIn`), so git finds no `user.email` and refuses with
 * "Committer identity unknown": the merge then failed, the worktree was kept
 * with git's own four-line advice as the reason, and the run's work stayed off
 * the project's branch.
 *
 * It used to be a constant — the placeholder address that belongs to nobody —
 * and `commitRunWork` used the same one. It is now RESOLVED per project
 * (coding-git-identity.ts), because on a project wired to a host's GitHub
 * deployment integration that placeholder fails the check and the box's own
 * bookkeeping commits blocked the pull requests it opened. Still the same
 * identity `commitRunWork` uses, by the same resolver.
 *
 * A lookup git could not MAKE is reported, never papered over: the fallbacks
 * are for a project that HAS no identity, and using one because git was killed
 * mid-question would put a name nobody chose on the owner's branch.
 */
const asBox = (dir: string): Promise<{ ok: true; args: string[] } | { ok: false; detail: string }> =>
  codingGitIdentityArgs(dir);

/** Why a run works in the project folder itself rather than in a worktree of its own. */
export type NoWorktreeReason = "no_repository" | "not_repository_root" | "protected_checkout" | "no_base_branch" | "failed";

/**
 * Why a run's branch could not be brought home into the project.
 *
 * Named rather than inlined because it now travels: the settle records it on
 * the run (`RunWorktree.result`), the route answers it as a stable `code`, and
 * the card words each one in the owner's language with the next step that
 * clears it. Three of the four are the owner's own project standing in the
 * way and are fixable from the desk; `failed` is git refusing for a reason
 * only its own sentence can give. `stopped` is never `mergeRunBranch`'s: the
 * settle does not try a stopped run's merge at all — half-finished work stays
 * on its branch for the owner to decide on.
 */
export type MergeHomeBlocker = "not_on_base" | "dirty" | "conflict" | "failed" | "stopped";

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
  /** On `not_repository_root`: the repository the folder turned out to be part of. */
  root?: string;
}

/** `<project>/.clawbox/worktrees/<runId>` — the path, without touching the disk. */
export function runWorktreePath(projectDir: string, runId: string): string {
  return path.join(path.resolve(projectDir), WORKTREES_DIR, runId);
}

/** The branch a run's worktree checks out: `clawbox/<runId>`, the same name the auto-PR flow has always used. */
export { runBranchName };

/**
 * Give this run a worktree and a branch of its own, forked from whatever the
 * project checkout is on now — unless that is a coding team's branch, which
 * a team leaves checked out: then from the project's base (`forkBase`).
 *
 * `protectedRoot` is the ClawBox checkout — never branched, never forked.
 */
export function addRunWorktree(input: {
  projectDir: string;
  runId: string;
  protectedRoot: string;
  /** Fork from this branch (local, else `origin/<name>`) instead of the checkout's own. */
  baseBranch?: string | null;
}): Promise<RunWorktreeAdded | RunWorktreeRefused> {
  return withDirLock(input.projectDir, () => addRunWorktreeNow(input));
}

async function addRunWorktreeNow({ projectDir, runId, protectedRoot, baseBranch }: {
  projectDir: string;
  runId: string;
  protectedRoot: string;
  baseBranch?: string | null;
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
      root,
      detail: `This folder is part of the repository at ${root} rather than being one, so a worktree of it would be a different folder.`,
    };
  }

  // Unborn HEAD: `git worktree add -b x <path> HEAD` has nothing to fork
  // from. Give the base branch one empty commit, exactly as startRunBranch
  // does and for the same reason — a fork needs something to fork from.
  const head = await gitIn(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!ok(head)) {
    const as = await asBox(dir);
    if (!as.ok) return { ok: false, reason: "failed", detail: as.detail };
    const seeded = await gitIn(dir, [...as.args, "commit", "--allow-empty", "-m", "Initial commit"]);
    if (!ok(seeded)) return { ok: false, reason: "failed", detail: failureDetail(seeded, "Making the first commit") };
  }
  // A base the caller named wins; otherwise never a coding team's branch a
  // team left checked out (`forkBase`). A named branch that is checked out is
  // the ordinary fork; one that is not merges home only by pull request (the
  // settle's not_on_base), which is what a fork from elsewhere is for.
  const fork = baseBranch ? await namedBase(dir, baseBranch) : await forkBase(dir);
  if (!fork.ok) return { ok: false, reason: baseBranch ? "no_base_branch" : "failed", detail: fork.detail };
  const base = fork.base;
  const branch = runBranchName(runId);
  const target = runWorktreePath(dir, runId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, reason: "failed", detail: `Could not make the worktrees folder: ${err instanceof Error ? err.message : String(err)}` };
  }
  const added = await gitIn(dir, ["worktree", "add", ...(fork.from ? ["--no-track", "-b", branch, target, fork.from] : ["-b", branch, target, base])]);
  if (!ok(added)) return { ok: false, reason: "failed", detail: failureDetail(added, `Making a worktree for ${runId}`) };
  await excludeWorktrees(dir);
  await shareNodeModules(dir, target);
  // Under `.clawbox/`, which excludeWorktrees keeps out of `git status`: a
  // copy of this tree is then still known for one (coding-folder-kind.ts).
  writeRunMarker(target, { kind: "run", id: runId, project: dir });
  return { ok: true, path: target, branch, base };
}

/** The caller's named base: the local branch, else the remote's, else a refusal naming it. */
async function namedBase(dir: string, name: string): Promise<{ ok: true; base: string; from: string | null } | { ok: false; detail: string }> {
  const on = await currentBranch(dir);
  if (on === name) return { ok: true, base: name, from: null };
  if (ok(await gitIn(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]))) return { ok: true, base: name, from: name };
  if (ok(await gitIn(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]))) return { ok: true, base: name, from: `origin/${name}` };
  return { ok: false, detail: `There is no branch "${name}" in this project, locally or on its origin, to fork the run from.` };
}

/**
 * `node_modules` from the project root, as a symlink, when the project has
 * one and the worktree does not — the FALLBACK since 2026-11-10: a worktree
 * gets a hard-linked tree first (`hardlinkSharedNodeModules`), and this link
 * only where that could not be made.
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

/** More entries than this and the copy is not tried: the link costs nothing whatever the size, and a monorepo's tree is not seconds of work. */
const MAX_HARDLINKED_ENTRIES = 250_000;

/**
 * `node_modules` from the project root as a tree of HARD LINKS: real folders
 * in the worktree, every file the same bytes on disk as the project's.
 *
 * WHY NOT THE LINK. A bundler that will not follow a link out of its own
 * folder cannot build through `linkSharedNodeModules`' symlink: Next.js 16
 * (Turbopack) stops with "Could not find the Next.js package" and its
 * filesystem-root message. Every run on the owner's Next apps met it — one
 * moved the link aside and installed again, one wrote `turbopack.root` into
 * the app's config and took it out, one copied the whole project to a folder
 * of its own — and the review pass's preview, which runs the app's own start
 * command, failed on it and the pass looked at nothing (run-xa50zhht,
 * 2026-11-10). Measured on this box: the same app builds from a hard-linked
 * tree, and making one took 0.2 s for 10,659 files.
 *
 * WHAT IT COSTS. No bytes — the files are links — and folders' worth of
 * inodes, gone with the worktree. A package manager's install in the
 * worktree REPLACES files (unlink, then write), so it never reaches the
 * project's own; with the old link the same install rewrote the project's
 * tree in place.
 *
 * Links inside the tree (`.bin`, a package manager's own store) are copied
 * as links, with the target as written. Anything that is not a file, a
 * folder or a link is left out. Never over something already there. A tree
 * too large, a project whose `node_modules` is itself a link, another
 * filesystem, or any failure: `false`, with whatever was made taken away
 * again — half a tree would be worse than none — and the caller falls back
 * to the link.
 */
export async function hardlinkSharedNodeModules(projectDir: string, worktreePath: string): Promise<boolean> {
  const source = path.join(path.resolve(projectDir), "node_modules");
  const target = path.join(path.resolve(worktreePath), "node_modules");
  try {
    if (!(await fs.promises.lstat(source)).isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    await fs.promises.lstat(target);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  let entries = 0;
  const copy = async (from: string, to: string): Promise<void> => {
    await fs.promises.mkdir(to);
    const listed = await fs.promises.readdir(from, { withFileTypes: true });
    entries += listed.length;
    if (entries > MAX_HARDLINKED_ENTRIES) throw new Error("too many entries");
    const folders: string[] = [];
    await Promise.all(listed.map(async (entry) => {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) folders.push(entry.name);
      else if (entry.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(a), b);
      else if (entry.isFile()) await fs.promises.link(a, b);
    }));
    // One folder at a time: a wide tree opened all at once runs out of descriptors.
    for (const name of folders) await copy(path.join(from, name), path.join(to, name));
  };
  try {
    await copy(source, target);
    return true;
  } catch {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
}

/** A worktree's dependencies: the hard-linked tree where it can be made, the link where it cannot. */
async function shareNodeModules(projectDir: string, worktreePath: string): Promise<void> {
  if (!(await hardlinkSharedNodeModules(projectDir, worktreePath))) linkSharedNodeModules(projectDir, worktreePath);
}

/**
 * Put a worktree back where its record says it was — the resume path.
 *
 * A settle removes the worktree of a run that left nothing behind, and
 * `resumeRun` refuses a run whose folder is gone. Two endings to restore
 * from, and both have to work:
 *
 *   - the branch is still there (the settle merged it home, or the owner
 *     pressed Remove worktree over unmerged work): check it out again;
 *   - the branch is gone, because the run left NOTHING on it and an empty
 *     `clawbox/<runId>` branch per run would be litter in the owner's
 *     repository. Fork it again from `base` — which is exactly what the
 *     original was, a fork of base with no commits on it.
 *
 * `true` when the path is usable afterwards, whether it was there already or
 * not.
 */
export function restoreRunWorktree(projectDir: string, worktreePath: string, branch: string, base: string): Promise<boolean> {
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
    const known = ok(await gitIn(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
    const added = known
      ? await gitIn(dir, ["worktree", "add", worktreePath, branch])
      : await gitIn(dir, ["worktree", "add", "-b", branch, worktreePath, base]);
    if (!ok(added)) return false;
    await shareNodeModules(dir, worktreePath);
    return true;
  });
}

/**
 * Bring a run's branch home into the project's own base branch.
 *
 * WHY AT ALL. Before worktrees, a run's commits landed in the project folder
 * and the owner saw its work there. A worktree that merely accumulated
 * branches would make every run's work invisible in the folder it was asked
 * to work in, which is a worse device, not a safer one. So the settle merges
 * it back — and does it CONSERVATIVELY, because the project checkout belongs
 * to the owner and not to the box:
 *
 *   - only when the checkout is on the branch the run forked from. It may
 *     have been moved since, and merging into whatever happens to be checked
 *     out now is a guess. ONE exception, and it is not a guess: a checkout
 *     sitting on a coding TEAM's branch (`clawbox/team-…`) was left there by
 *     the box, not moved there by the owner — a team leaves the checkout on
 *     its branch — and a run started in that project forks from the base
 *     (`forkBase`), so its merge home was refused before it began. Runs worked
 *     for hours and then "did not land" (team-yykapje9, 95M tokens,
 *     2026-11-07). A CLEAN checkout on a team's branch is put back on the
 *     base first; the team's branch stays, with everything on it. Only a
 *     FINISHED team's (`teamLive`): a team still working merges its workers
 *     into whatever the checkout is on, so its checkout is never moved;
 *   - only when the checkout is clean. The team's merge commits what it finds
 *     lying there first; that is right for a tree only the team uses and
 *     wrong for the owner's own folder, where uncommitted work is theirs.
 *     The favicons the box itself draws at the root are not theirs and do not
 *     count (`readCheckout`): drawn there while the run is out in its
 *     worktree, they refused the merge home of every run that had pictures
 *     on. One the branch brings its own of is moved aside for the merge, so
 *     the run's file wins and git does not refuse to write over it;
 *   - a conflict is ABORTED and named, never resolved by guess. The worktree
 *     then stays, which is what the card's Remove worktree is for.
 */
export function mergeRunBranch(input: {
  projectDir: string;
  branch: string;
  base: string;
  message: string;
  /**
   * Is this coding team's branch one a team is STILL working on? Asked before
   * the checkout is put back on the base from it: a live team merges its
   * workers into whatever the checkout is on, so moving it would land their
   * work on the base, past the team's own review and pull request. Without it
   * every team's branch is taken for a finished team's.
   */
  teamLive?: (branch: string) => Promise<boolean>;
}): Promise<
  /** `returnedFrom`: the coding team's branch the checkout was on, when it was put back on the base for this merge. */
  | { ok: true; merged: boolean; commit: string | null; returnedFrom?: string }
  | { ok: false; reason: MergeHomeBlocker; detail: string }
> {
  return withDirLock(input.projectDir, async () => {
    const dir = path.resolve(input.projectDir);
    let on = await currentBranch(dir);
    let returnedFrom: string | undefined;
    if (on !== input.base) {
      // On a coding team's branch, clean, with work to land: back to the base.
      // With nothing to land the checkout is left where the team left it.
      if (TEAM_BRANCH_RE.test(on) && ((await commitsAhead(dir, input.branch, input.base)) ?? 0) > 0) {
        // A team that is still working owns the checkout: left exactly where it is.
        if (input.teamLive && (await input.teamLive(on))) {
          return { ok: false, reason: "not_on_base", detail: `the project is on ${on}, the branch of a coding team that is still working` };
        }
        const seen = await readCheckout(dir, "normal");
        if (seen.ok && !seen.changed && ok(await gitIn(dir, ["checkout", "-q", input.base]))) {
          returnedFrom = on;
          on = await currentBranch(dir);
        }
      }
      if (on !== input.base) {
        return { ok: false, reason: "not_on_base", detail: `the project is on ${returnedFrom ?? on}, not on ${input.base}` };
      }
    }
    const ahead = await commitsAhead(dir, input.branch, input.base);
    if (ahead === 0) return { ok: true, merged: false, commit: null, ...(returnedFrom ? { returnedFrom } : {}) };
    const seen = await readCheckout(dir, "normal");
    if (!seen.ok) return { ok: false, reason: "failed", detail: failureDetail(seen.failed, "Reading the project before the merge") };
    if (seen.changed) return { ok: false, reason: "dirty", detail: "the project folder has uncommitted changes of its own" };
    const as = await asBox(dir);
    if (!as.ok) return { ok: false, reason: "failed", detail: as.detail };
    const aside = await setAsideFavicons(dir, input.branch, seen.favicons);
    const merged = await gitIn(dir, [...as.args, "merge", "--no-ff", "--no-edit", "-m", input.message, input.branch]);
    if (ok(merged)) {
      putBackFavicons(aside);
      // The merge commit, for the record and for the card's "the work is now
      // in <base>, as <sha>". Best-effort: a rev-parse that will not answer
      // does not turn a landed merge into a failed one.
      const head = await gitIn(dir, ["rev-parse", "HEAD"]);
      return { ok: true, merged: true, commit: ok(head) && out(head) ? out(head) : null, ...(returnedFrom ? { returnedFrom } : {}) };
    }
    const conflict = /CONFLICT|Automatic merge failed/i.test(merged.stdout + merged.stderr);
    await gitIn(dir, ["merge", "--abort"]);
    putBackFavicons(aside);
    return {
      ok: false,
      reason: conflict ? "conflict" : "failed",
      detail: conflict ? "it conflicts with the project's own changes" : failureDetail(merged, `Merging ${input.branch}`),
    };
  });
}

/** Why the project folder could not be brought up to its base as GitHub has it (`bringBaseHome`). */
export type BaseHomeBlocker = "fetch" | "dirty" | "diverged" | "failed";

/**
 * Bring the project folder up to its BASE BRANCH AS GITHUB HAS IT — the step
 * after a pull request into that base was merged there.
 *
 * `mergeRunBranch` brings a run's work home when there is no pull request.
 * With one, the merge happens on GitHub, and nothing brought it back: the
 * project folder stayed on the base as it was before the run, so the app the
 * box serves from that folder was still the old one under a run that said
 * "Merged into the base branch", and the NEXT run forked from the old base
 * and never saw the work (Habit Tracker 1.3.0, run-deyse3g9, 2026-11-10:
 * merged on GitHub, 1.2.1 in the folder and on the desktop).
 *
 * FAST-FORWARD ONLY, and that is the whole safety argument: nothing is ever
 * merged, rebased or overwritten here, so there is nothing to resolve and
 * nothing to lose.
 *   - `origin`'s base is fetched; a fetch that fails (no remote, offline, a
 *     sign-in that expired) is said and nothing else happens;
 *   - already there: nothing moves, and the caller says nothing;
 *   - checked out: `merge --ff-only`, and GIT decides whether uncommitted
 *     work is in the way — it refuses to write over a changed file and moves
 *     nothing then (`dirty`), and takes no notice of one the merge does not
 *     touch. NOT the merge home's "only when clean": five of the owner's
 *     projects track `.clawbox/run-notes.md` (a team's merge committed it
 *     once), the box itself writes a run's lessons there, and a rule that
 *     asked for a clean folder would never have moved one of them. A favicon
 *     the box drew that the base brings its own of is moved aside first
 *     (`setAsideFavicons`), as for the merge home;
 *   - the folder is on ANOTHER branch (a coding team's, the owner's own):
 *     only the base's ref moves, by a fetch into it, which git refuses unless
 *     it is a fast-forward. The tree is not touched (`checkedOut: false`);
 *   - a base that has commits GitHub's has not is `diverged`: the owner's to
 *     sort out, never the box's.
 */
export function bringBaseHome(input: { projectDir: string; base: string }): Promise<
  | { ok: true; moved: boolean; commit: string | null; checkedOut: boolean }
  | { ok: false; reason: BaseHomeBlocker; detail: string }
> {
  return withDirLock(input.projectDir, async () => {
    const dir = path.resolve(input.projectDir);
    const { base } = input;
    const fetched = await gitIn(dir, ["fetch", "--quiet", "origin", base]);
    if (!ok(fetched)) return { ok: false, reason: "fetch", detail: failureDetail(fetched, `Fetching ${base} from GitHub`) };
    const theirs = await gitIn(dir, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
    if (!ok(theirs) || !out(theirs)) return { ok: false, reason: "failed", detail: failureDetail(theirs, `Reading ${base} as GitHub has it`) };
    const commit = out(theirs);
    const on = await currentBranch(dir);
    const mine = await gitIn(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`]);
    if (ok(mine) && out(mine) === commit) return { ok: true, moved: false, commit, checkedOut: on === base };
    // Ahead of GitHub, or beside it: not a fast-forward, whichever way it is looked at.
    if (ok(mine) && out(mine) && !ok(await gitIn(dir, ["merge-base", "--is-ancestor", out(mine), commit]))) {
      return { ok: false, reason: "diverged", detail: `${base} in the project folder has commits that GitHub's ${base} does not` };
    }
    if (on !== base) {
      const moved = await gitIn(dir, ["fetch", "--quiet", "origin", `${base}:${base}`]);
      if (!ok(moved)) return { ok: false, reason: "failed", detail: failureDetail(moved, `Moving ${base} forward`) };
      return { ok: true, moved: true, commit, checkedOut: false };
    }
    const seen = await readCheckout(dir, "normal");
    if (!seen.ok) return { ok: false, reason: "failed", detail: failureDetail(seen.failed, "Reading the project folder") };
    const aside = await setAsideFavicons(dir, commit, seen.favicons);
    const forward = await gitIn(dir, ["merge", "--ff-only", "--quiet", commit]);
    putBackFavicons(aside);
    if (ok(forward)) return { ok: true, moved: true, commit, checkedOut: true };
    // Git's own refusal to write over a file the folder has changed or added: nothing moved.
    return /would be overwritten/i.test(forward.stdout + forward.stderr)
      ? { ok: false, reason: "dirty", detail: "uncommitted changes there are in files the merge also changes" }
      : { ok: false, reason: "failed", detail: failureDetail(forward, `Moving ${base} forward`) };
  });
}

/**
 * The worktree's files go; the branch stays as history unless the caller asks
 * otherwise.
 *
 * Answers whether the files are actually GONE, not whether git was happy:
 * `worktree remove --force` can fail on a busy file, a permission error or an
 * index lock, and a caller that recorded the removal on git's word alone would
 * leave a record claiming the copy is gone while it sits on the disk — and the
 * owner's Remove button, which returns early on that record, would never try
 * again. A path that is not there is a success whatever git said, which is the
 * case where only git's own registration was stale.
 */
export function removeRunWorktree(projectDir: string, worktreePath: string): Promise<boolean> {
  return withDirLock(projectDir, async () => {
    const removed = await gitIn(path.resolve(projectDir), ["worktree", "remove", "--force", worktreePath]);
    await gitIn(path.resolve(projectDir), ["worktree", "prune"]);
    if (ok(removed)) return true;
    try {
      fs.statSync(worktreePath);
      return false;
    } catch (err) {
      // ENOENT and nothing else. EACCES or EPERM is a path that may be sitting
      // there perfectly well behind a mode bit, and reading "I cannot look" as
      // "it is gone" would have the caller record a removal that did not
      // happen — the exact thing this answer exists to stop.
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
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
 * Does the worktree hold changes its branch does not — staged, modified, or
 * untracked and not ignored? `commitsAhead` cannot see them (a commit that
 * failed after its `git add -A` leaves the work staged and the branch where
 * it was), and `removeRunWorktree` forces them away. The `node_modules` at its
 * root is left out: that is the project's own, linked in by
 * `linkSharedNodeModules`, and git lists a link as untracked whatever a
 * `node_modules/` ignore line says. Null means git could not say.
 */
export async function worktreeHasChanges(worktreePath: string): Promise<boolean | null> {
  const r = await gitIn(path.resolve(worktreePath), ["status", "--porcelain", "--untracked-files=normal", "--", ".", ":(exclude)node_modules"]);
  if (!ok(r)) return null;
  return out(r) !== "";
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

/** What the main checkout is on, or "main" when git will not say (a detached HEAD, a fresh repository). */
export async function currentBranch(projectDir: string): Promise<string> {
  const r = await gitIn(path.resolve(projectDir), ["rev-parse", "--abbrev-ref", "HEAD"]);
  return ok(r) && out(r) && out(r) !== "HEAD" ? out(r) : "main";
}
