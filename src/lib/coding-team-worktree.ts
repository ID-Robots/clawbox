/**
 * A coding team's git plumbing: one branch for the team, one worktree per
 * worker, and the merge that brings a worker's commits back.
 *
 * WHY WORKTREES. Two workers in ONE checkout would write over each other's
 * half-done files, and each run's settle commits "whatever changed"
 * (`git add -A`), so worker A's commit would carry worker B's unfinished
 * edits. A worktree gives each worker its own working tree and its own
 * branch on the SAME repository — the way Claude Code's own teams work —
 * and the team merges each branch into its branch as the worker settles.
 * A merge git cannot do alone (two workers touched the same lines) is not
 * guessed at: it is aborted, the task fails with the conflict named, and
 * the task is offered once more — the next attempt starts from the merged
 * state and sees the other worker's lines.
 *
 * WHERE. `<project>/.clawbox/worktrees/<task>-<attempt>`: inside the
 * project, so the runner's containment rule (a run works in a folder
 * inside the project folder) holds without a new exception, and excluded
 * through `.git/info/exclude` so it never shows as untracked. The project
 * tree route skips `.clawbox` the way it skips `.git`.
 */

import path from "./runtime-path";
import fs from "fs";
import { runChild, failureDetail, type ChildResult } from "./child-run";
import { codingGitIdentityArgs } from "./coding-git-identity";
import { BOX_FAVICONS } from "./project-icon";

const CALL_TIMEOUT_MS = 60_000;
export const WORKTREES_DIR = path.join(".clawbox", "worktrees");

/**
 * One `git -C <dir>` with the coding agent's own environment. Exported
 * because the RUN worktrees (coding-run-worktree.ts) are the same plumbing on
 * the same checkouts and must not grow a second copy of it.
 */
export function gitIn(dir: string, args: string[]): Promise<ChildResult> {
  return runChild("git", ["-C", dir, ...args], {
    timeoutMs: CALL_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/clawbox",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

const git = gitIn;
const ok = (r: ChildResult) => r.code === 0;
const out = (r: ChildResult) => r.stdout.trim();

/**
 * Who the box commits as, in THIS project — the project's own git identity,
 * then the owner's setting, then the placeholder (coding-git-identity.ts).
 *
 * Passed on every call below that CREATES a commit, which is what the
 * environment `gitIn` builds requires: it carries nothing of the server's, so
 * a repository with no identity of its own answers "Committer identity
 * unknown" and the commit never happens. The placeholder that used to be
 * spelled out here also fails a host's deployment check on a project wired to
 * its GitHub integration, which is the reason this is resolved rather than
 * written down.
 *
 * A lookup git could not MAKE is reported rather than fallen back from: the
 * fallbacks answer "this project has no identity", not "git was killed while
 * being asked", and only the first is a reason to commit as somebody else.
 */
const asBox = (dir: string): Promise<{ ok: true; args: string[] } | { ok: false; detail: string }> =>
  codingGitIdentityArgs(dir);

/**
 * One lock per repository: workers settle in any order, and two merges (or a
 * merge and a worktree add) on the same checkout share ONE git index — the
 * second would trip over `.git/index.lock`, or its `merge --abort` would undo
 * the first's conflict. Every operation below that touches the main
 * checkout runs under the folder's lock, in the order it was asked.
 */
const dirLocks = new Map<string, Promise<void>>();
export async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const previous = dirLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => mine);
  dirLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (dirLocks.get(key) === chained) dirLocks.delete(key);
  }
}

export function teamBranchName(teamId: string): string {
  return `clawbox/${teamId}`;
}

/** `clawbox/<team>-<task>-<attempt>`, a sibling of the team branch: git refuses a branch UNDER another branch's name (`clawbox/team-x/t1` beside `clawbox/team-x`). */
export function workerBranchName(teamId: string, taskId: string, attempt: number): string {
  return `clawbox/${teamId}-${taskId}-${attempt}`;
}

/** A coding team's own branch or one of its workers' (`clawbox/team-<id>…`): never a base anything forks from. */
export const TEAM_BRANCH_RE = /^clawbox\/team-[a-z0-9]{8}(?:-.+)?$/;

/**
 * What a new team or run forks from: the branch the checkout is on — unless
 * that is a coding team's own branch. A team leaves the checkout on its branch
 * (`ensureTeamBranch`), and one that failed leaves its fixes there: a team
 * restarted in the same folder forked from it, carried the old fixes, rebuilt
 * them anyway, and its merges conflicted with themselves (night run,
 * 2026-10-29). The base is then the one that team recorded (`recordedBase`,
 * followed back past teams that forked from teams), else the remote's default
 * branch, else main, master or develop, whichever exists. `from` is the start
 * point, null for HEAD.
 */
export async function forkBase(dir: string, recordedBase: (branch: string) => string | null = () => null): Promise<{ ok: true; base: string; from: string | null } | { ok: false; detail: string }> {
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const on = ok(current) && out(current) && out(current) !== "HEAD" ? out(current) : null;
  if (!on || !TEAM_BRANCH_RE.test(on)) return { ok: true, base: on ?? "main", from: null };
  const candidates: string[] = [];
  const seen = new Set<string>();
  let recorded: string | null = on;
  while (recorded && TEAM_BRANCH_RE.test(recorded) && !seen.has(recorded)) {
    seen.add(recorded);
    recorded = recordedBase(recorded);
  }
  if (recorded && !TEAM_BRANCH_RE.test(recorded)) candidates.push(recorded);
  const remoteHead = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (ok(remoteHead) && out(remoteHead).startsWith("origin/")) candidates.push(out(remoteHead).slice("origin/".length));
  candidates.push("main", "master", "develop");
  for (const name of candidates) {
    if (ok(await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]))) return { ok: true, base: name, from: name };
    if (ok(await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]))) return { ok: true, base: name, from: `origin/${name}` };
  }
  return { ok: false, detail: `The checkout is on ${on}, a coding team's branch, and no base branch (main, master, develop or the remote's default) was found to fork from. Check out the project's base branch first.` };
}

/**
 * The team's own branch, forked from the project's base (`forkBase`) and
 * CHECKED OUT in the main checkout, so every merge lands on it and the project
 * page's Create PR has the base to compare against. A repository with no
 * commits gets an empty first one, for the same reason startRunBranch does:
 * `checkout -b` on an unborn HEAD renames it rather than forking.
 */
export function ensureTeamBranch(dir: string, teamId: string, recordedBase?: (branch: string) => string | null): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string }> {
  return withDirLock(dir, () => ensureTeamBranchNow(dir, teamId, recordedBase));
}

async function ensureTeamBranchNow(dir: string, teamId: string, recordedBase?: (branch: string) => string | null): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string }> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!ok(inside)) return { ok: false, detail: failureDetail(inside, "Reading the git repository", "Make the folder a git repository first.") };
  const head = await git(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!ok(head)) {
    const as = await asBox(dir);
    if (!as.ok) return { ok: false, detail: as.detail };
    const seeded = await git(dir, [...as.args, "commit", "--allow-empty", "-m", "Initial commit"]);
    if (!ok(seeded)) return { ok: false, detail: failureDetail(seeded, "Making the first commit") };
  }
  const fork = await forkBase(dir, recordedBase);
  if (!fork.ok) return fork;
  const branch = teamBranchName(teamId);
  const made = await git(dir, fork.from ? ["checkout", "--no-track", "-b", branch, fork.from] : ["checkout", "-b", branch]);
  if (!ok(made)) return { ok: false, detail: failureDetail(made, `Creating the team branch ${branch}`) };
  await excludeWorktrees(dir);
  return { ok: true, branch, base: fork.base };
}

/**
 * Artifacts a build or an interpreter writes on its own. None of these is
 * ever source, so a worker that produces one has not strayed and must not
 * commit it.
 *
 * WHY THIS LIST IS SHORT. `dist/`, `build/`, `.next/` and `coverage/` are
 * generated too, but a task can legitimately be asked to produce them, and
 * excluding those would silently drop the very work the task was given. A
 * false alert costs a retry; dropped work is not recoverable. Only names
 * that are never a task's output are here.
 */
export const GENERATED_ARTIFACT_EXCLUDES = [
  "__pycache__/",
  "*.py[cod]",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "node_modules/",
  // The LINK a run's worktree gets (linkSharedNodeModules): a pattern with a
  // trailing slash matches directories only, so `node_modules/` let a settle's
  // `git add -A` commit the symlink — an absolute path into the project that
  // is broken in every other checkout (bench kanban-app, 2026-10-18: the
  // merged project could not start or run its tests anywhere else).
  "/node_modules",
  ".venv/",
  "venv/",
  ".DS_Store",
  "*.tsbuildinfo",
] as const;

const ARTIFACT_MATCHERS: RegExp[] = [
  /(^|\/)__pycache__(\/|$)/,
  /\.py[cod]$/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.mypy_cache(\/|$)/,
  /(^|\/)\.ruff_cache(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.?venv(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /\.tsbuildinfo$/,
];

/** True for a path git should never have been handed in the first place. */
export function isGeneratedArtifact(relPath: string): boolean {
  const p = relPath.replace(/^\.\//, "").replace(/\\/g, "/");
  return ARTIFACT_MATCHERS.some((re) => re.test(p));
}

/**
 * `.clawbox/` and the generated artifacts out of `git status`, once, without
 * touching the project's own .gitignore. Written to the repository's
 * `info/exclude`, which every linked worktree shares, so a worker's
 * `git add -A` cannot sweep a `.pyc` into its branch and make an
 * unmergeable binary out of it (team-6rgz8cyx, 2026-09-06).
 */
export async function excludeWorktrees(dir: string): Promise<void> {
  const gitDir = await git(dir, ["rev-parse", "--git-dir"]);
  if (!ok(gitDir)) return;
  const exclude = path.resolve(dir, out(gitDir), "info", "exclude");
  try {
    // Read, never exists-then-read: a file that appears in between is read
    // as it is, and one that is not there reads as empty.
    let current = "";
    try {
      current = fs.readFileSync(exclude, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const lines = current.split("\n").map((l) => l.trim());
    const wanted = ["/.clawbox/", ...GENERATED_ARTIFACT_EXCLUDES];
    const missing = wanted.filter((w) => !lines.includes(w));
    if (missing.length === 0) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const lead = current.endsWith("\n") || current === "" ? "" : "\n";
    fs.appendFileSync(exclude, `${lead}${missing.join("\n")}\n`);
  } catch {
    // Best effort: a worktree that shows as untracked is untidy, not wrong.
  }
}

/** A worker's own worktree and branch, forked from the team branch as it stands now. */
export function addWorkerWorktree(dir: string, teamId: string, taskId: string, attempt: number): Promise<{ ok: true; path: string; branch: string } | { ok: false; detail: string }> {
  return withDirLock(dir, () => addWorkerWorktreeNow(dir, teamId, taskId, attempt));
}

async function addWorkerWorktreeNow(dir: string, teamId: string, taskId: string, attempt: number): Promise<{ ok: true; path: string; branch: string } | { ok: false; detail: string }> {
  const branch = workerBranchName(teamId, taskId, attempt);
  const target = path.join(dir, WORKTREES_DIR, `${taskId}-${attempt}`);
  fs.mkdirSync(path.join(dir, WORKTREES_DIR), { recursive: true });
  const added = await git(dir, ["worktree", "add", "-b", branch, target, teamBranchName(teamId)]);
  if (!ok(added)) return { ok: false, detail: failureDetail(added, `Making a worktree for ${taskId}`) };
  return { ok: true, path: target, branch };
}

/**
 * A checkout's uncommitted state as a merge home has to read it: `changed` is
 * anything git lists APART from `favicons` — the box's own (`BOX_FAVICONS`)
 * lying untracked at the folder's root, named relative to `dir`, the way the
 * pathspecs and the files below want them. Shared by a team's merge and a
 * run's merge home (coding-run-worktree.ts), so the two cannot disagree about
 * which files are the box's.
 *
 * A favicon is the box's only when `?? <name>` is ALL git says of that path:
 * one the project tracks, changed, renamed or dropped from the index, is the
 * project's own and stays in `changed`. Porcelain paths are the repository's
 * whatever folder git runs in, and a team may work in a sub-folder of one, so
 * the folder's prefix goes in front. `-z` because a path then comes as it is:
 * never quoted, and never a leading space the trimmed output could eat.
 */
export async function readCheckout(dir: string, untracked: "normal" | "all"): Promise<{ ok: true; changed: boolean; favicons: string[] } | { ok: false; failed: ChildResult }> {
  const shown = await git(dir, ["rev-parse", "--show-prefix"]);
  if (!ok(shown)) return { ok: false, failed: shown };
  const prefix = out(shown);
  const status = await git(dir, ["status", "--porcelain", "-z", `--untracked-files=${untracked}`]);
  if (!ok(status)) return { ok: false, failed: status };
  // `XY <path>` each, and a rename's source after it as a bare path.
  const entries = status.stdout.split("\0").filter(Boolean);
  const favicons = BOX_FAVICONS.filter((name) => {
    const file = prefix + name;
    const mentions = entries.filter((e) => e === file || e.slice(3) === file);
    return mentions.length === 1 && mentions[0] === `?? ${file}`;
  });
  const box = new Set(favicons.map((name) => `?? ${prefix}${name}`));
  return { ok: true, changed: entries.some((e) => !box.has(e)), favicons };
}

/** A box favicon moved out of a merge's way, with what it takes to put it back. */
export interface FaviconAside {
  file: string;
  bytes: Buffer;
  mode: number;
}

/**
 * The box's untracked favicons that `branch` brings its own of, moved out of
 * the merge's way. Git refuses to write over an untracked file even when the
 * bytes are the same ("untracked working tree files would be overwritten by
 * merge"), and a favicon the branch brought is the work: it wins. Held in
 * memory rather than deleted, so `putBackFavicons` can return each one the
 * merge left room for.
 */
export async function setAsideFavicons(dir: string, branch: string, favicons: readonly string[]): Promise<FaviconAside[]> {
  const aside: FaviconAside[] = [];
  for (const name of favicons) {
    // `./`: the path relative to `dir` in the branch's tree, not to the repository's root.
    if (!ok(await git(dir, ["cat-file", "-e", `${branch}:./${name}`]))) continue;
    const file = path.join(dir, name);
    // One handle for the check and the read: O_NOFOLLOW refuses a symlink, and
    // stat/readFile on the same handle cannot race a swap of the path, so the
    // bytes put back are the favicon's and nothing else's. Handle methods, not
    // fs calls on a descriptor, which the build would trace (runtime-path.ts).
    let handle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      // Left where it lies: the merge then says why it cannot go on, in git's words.
      continue;
    }
    try {
      const stat = await handle.stat();
      // The box writes plain files; anything else is not its to move.
      if (!stat.isFile()) continue;
      const bytes = await handle.readFile();
      fs.unlinkSync(file);
      aside.push({ file, bytes, mode: stat.mode & 0o777 });
    } catch {
      // Left where it lies, as above.
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return aside;
}

/**
 * Each favicon `setAsideFavicons` moved, back where it was if the name is
 * still free: after a merge that did not land, or one whose result has no
 * such file. Never over one ('wx'), so a favicon the branch brought stays.
 */
export function putBackFavicons(aside: readonly FaviconAside[]): void {
  for (const { file, bytes, mode } of aside) {
    try {
      fs.writeFileSync(file, bytes, { flag: "wx", mode });
    } catch {
      // EEXIST is the branch's own favicon in its place, which is the point;
      // anything else is a favicon the next run's start draws again.
    }
  }
}

/**
 * Bring a worker's branch into the team branch (the main checkout is on
 * it). `merged: false` when the branch added nothing. A conflict is
 * aborted, never resolved by guess, and reported with git's own words.
 */
export function mergeWorkerBranch(dir: string, branch: string, message: string): Promise<{ ok: true; merged: boolean } | { ok: false; conflict: boolean; detail: string }> {
  return withDirLock(dir, async () => {
    const ahead = await git(dir, ["rev-list", "--count", `HEAD..${branch}`]);
    if (ok(ahead) && out(ahead) === "0") return { ok: true, merged: false };
    // Resolved ONCE, after the early return: both commits below want it, and
    // a branch that added nothing needs neither.
    const as = await asBox(dir);
    if (!as.ok) return { ok: false, conflict: false, detail: as.detail };
    // Whatever landed in the team's checkout uncommitted while the workers
    // were out goes on the team branch first: a merge refuses to overwrite an
    // untracked file a worker's branch also brought, and "MERGE FAILED …
    // untracked working tree files would be overwritten" rejected finished
    // work for that (team-8l9oudxd, t1, 2026-09-05). An identical file then
    // merges as one; a different one conflicts honestly, below.
    //
    // Never the favicons the box draws at a run's start (`readCheckout`):
    // they are not the team's work, and this commit put them in the owner's
    // history. They stay untracked, and one a worker's branch brings its own
    // of is moved aside for the merge instead, so the branch's file wins.
    const seen = await readCheckout(dir, "all");
    if (!seen.ok) return { ok: false, conflict: false, detail: failureDetail(seen.failed, "Reading the team checkout before the merge") };
    if (seen.changed) {
      const added = await git(dir, ["add", "-A", "--", ":/", ...seen.favicons.map((name) => `:(exclude)${name}`)]);
      if (!ok(added)) return { ok: false, conflict: false, detail: failureDetail(added, "Staging the team checkout's files before the merge") };
      const kept = await git(dir, [...as.args, "commit", "-q", "--no-verify", "-m", "Coding team: files present in the checkout before a merge"]);
      if (!ok(kept)) return { ok: false, conflict: false, detail: failureDetail(kept, "Committing the team checkout's files before the merge") };
    }
    const aside = await setAsideFavicons(dir, branch, seen.favicons);
    // `--no-ff` always writes a merge COMMIT, so this needs an identity for the
    // same reason the preservation commit above does — and for the same reason
    // the run worktrees' merge home has always passed one.
    const merged = await git(dir, [...as.args, "merge", "--no-ff", "--no-edit", "-m", message, branch]);
    if (ok(merged)) {
      putBackFavicons(aside);
      return { ok: true, merged: true };
    }
    const conflict = /CONFLICT|Automatic merge failed/i.test(merged.stdout + merged.stderr);
    await git(dir, ["merge", "--abort"]);
    putBackFavicons(aside);
    return { ok: false, conflict, detail: failureDetail(merged, `Merging ${branch} into the team branch`) };
  });
}

/**
 * What a worker left UNCOMMITTED in its worktree, committed on its branch —
 * the harvest before the team judges a branch that came home empty. A worker
 * whose run settled without the runner's commit (team-v0wcl4mj, t1,
 * 2026-09-26: two files written in the worktree, nothing on the branch, no
 * commit error) otherwise merged an empty branch, was accepted by rule, and
 * three more tasks built against files that were never there.
 *
 * Generated artifacts and `.clawbox/` stay out, the way `info/exclude` keeps
 * them out of a worker's own `git add -A` — named here too, because that
 * exclude is written best effort and a project's own history may track one.
 * `files` is empty when there was nothing else to commit.
 */
export async function harvestWorktree(worktreePath: string, message: string): Promise<{ ok: true; files: string[] } | { ok: false; detail: string }> {
  const status = await git(worktreePath, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
  if (!ok(status)) return { ok: false, detail: failureDetail(status, "Reading the worker's worktree") };
  const { files, left } = leftovers(status.stdout);
  if (files.length === 0) return { ok: true, files: [] };
  const as = await asBox(worktreePath);
  if (!as.ok) return { ok: false, detail: as.detail };
  // Everything, the way the runner's own commit stages it — a rename's old
  // name and a deletion included, which a list of paths would have to get
  // exactly right — then what is never a task's output back out of the
  // index, left where it lies. Literal pathspecs: `*.pyc` names one file.
  const added = await git(worktreePath, ["add", "-A"]);
  if (!ok(added)) return { ok: false, detail: failureDetail(added, "Staging the files the worker left uncommitted") };
  if (left.length) {
    const unstaged = await git(worktreePath, ["--literal-pathspecs", "reset", "-q", "--", ...left]);
    if (!ok(unstaged)) return { ok: false, detail: failureDetail(unstaged, "Keeping generated files out of the worker's commit") };
  }
  const committed = await git(worktreePath, [...as.args, "commit", "-q", "--no-verify", "-m", message]);
  if (!ok(committed)) return { ok: false, detail: failureDetail(committed, "Committing the files the worker left uncommitted") };
  return { ok: true, files };
}

/**
 * Commits a run MADE in this worktree and left on a branch of its own — a
 * branch it made with `git checkout -b fix/…`, or its HEAD detached there —
 * that `branch`, the one the box gave it, does not hold. Oldest first.
 *
 * "Made here" is read off this worktree's own HEAD reflog: the entries that
 * wrote a commit (a commit, an amend, a cherry-pick, a revert, a rebase's
 * picks, a merge commit). A commit HEAD merely stood on — a base branch the
 * run checked out, a sibling worker's commit — is never one, and a commit no
 * branch holds any more (amended, reset away) was undone by the run itself.
 * A coding team's or another run's branch is never a source.
 */
export async function ownBranchWork(worktreePath: string, branch: string): Promise<Array<{ name: string; commit: string }>> {
  const ref = `refs/heads/${branch}`;
  const given = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const log = await git(worktreePath, ["reflog", "show", "--format=%H %gs", "HEAD"]);
  if (!ok(log)) return [];
  const madeAt = new Map<string, number>();
  out(log).split("\n").forEach((line, i) => {
    const [hash, ...rest] = line.trim().split(" ");
    if (hash && !madeAt.has(hash) && MADE_ENTRY_RE.test(rest.join(" "))) madeAt.set(hash, i);
  });
  if (madeAt.size === 0) return [];
  const tip = ok(given) ? out(given) : null;
  const held = async (commit: string) => tip !== null && ok(await git(worktreePath, ["merge-base", "--is-ancestor", commit, tip]));
  const found: Array<{ name: string; commit: string; at: number }> = [];
  const refs = await git(worktreePath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]);
  for (const line of ok(refs) ? out(refs).split("\n") : []) {
    const [commit, name] = line.trim().split(" ");
    if (!commit || !name || name === ref) continue;
    const short = name.replace(/^refs\/heads\//, "");
    if (TEAM_BRANCH_RE.test(short) || /^clawbox\/run-/.test(short)) continue;
    const at = madeAt.get(commit);
    if (at === undefined || found.some((f) => f.commit === commit) || (await held(commit))) continue;
    found.push({ name: short, commit, at });
  }
  // A HEAD detached at a commit it made, which no branch names.
  const symbolic = await git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  const head = await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!ok(symbolic) && ok(head)) {
    const commit = out(head);
    const at = madeAt.get(commit);
    if (at !== undefined && !found.some((f) => f.commit === commit) && !(await held(commit))) found.push({ name: commit.slice(0, 12), commit, at });
  }
  return found.sort((a, b) => b.at - a.at).map(({ name, commit }) => ({ name, commit }));
}

/** A HEAD reflog subject that wrote a commit (see ownBranchWork). */
const MADE_ENTRY_RE = /^(?:commit(?: \([a-z ]+\))?|cherry-pick|revert|rebase(?: -i)? \((?:pick|reword|edit|squash|fixup)\)):|^merge .*: Merge made/;

/**
 * What a run committed on a branch of its OWN (`ownBranchWork`), brought onto
 * `branch` — the one the box gave it and the one everything after the run
 * reads. A worker told to commit its work made `fix/…` with
 * `git checkout -b` and committed there; its given branch stayed where it was
 * forked, and finished work was rejected as NO CHANGE (team-sso0e0wq,
 * 2026-10-29).
 *
 * Each such branch, oldest first: `branch` is moved forward when it is behind
 * the work (with `merge --ff-only` when HEAD is on it, so the tree follows;
 * with `update-ref` when it is not, so the tree does not move), else the work
 * is merged into it. A merge git cannot do alone is aborted and HEAD put back
 * where the run left it, so its files are still on disk; the failure says what
 * was not brought. HEAD ends on `branch` when the run left it elsewhere at a
 * commit `branch` now holds. `from` names what was adopted, null when nothing
 * needed to be. The run's own branches are left where they are.
 */
export async function adoptOwnBranchWork(worktreePath: string, branch: string): Promise<{ ok: true; from: string | null } | { ok: false; detail: string }> {
  const ref = `refs/heads/${branch}`;
  const tipOf = async () => {
    const r = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return ok(r) && out(r) ? out(r) : null;
  };
  if (!(await tipOf())) {
    // Not a repository git can read here: nothing to say, and the caller's
    // own steps report it. A repository without the branch: said.
    if (!ok(await git(worktreePath, ["rev-parse", "--git-dir"]))) return { ok: true, from: null };
    return { ok: false, detail: `${branch}, the branch this work belongs on, is gone from the repository.` };
  }
  const symbolic = await git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = ok(symbolic) && out(symbolic) ? out(symbolic) : null;
  const headAt = await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const head = ok(headAt) ? out(headAt) : null;
  // Where the run left HEAD, to put it back if a merge fails.
  const leftAt = headRef ? headRef.replace(/^refs\/heads\//, "") : head;
  let onGiven = headRef === ref;
  const adopted: string[] = [];
  for (const source of await ownBranchWork(worktreePath, branch)) {
    const tip = await tipOf();
    if (!tip) return { ok: false, detail: `${branch} went from the repository while ${source.name} was being brought onto it.` };
    if (ok(await git(worktreePath, ["merge-base", "--is-ancestor", source.commit, tip]))) continue;
    if (ok(await git(worktreePath, ["merge-base", "--is-ancestor", tip, source.commit]))) {
      const moved = onGiven
        ? await git(worktreePath, ["merge", "--ff-only", "-q", source.commit])
        : await git(worktreePath, ["update-ref", ref, source.commit, tip]);
      if (!ok(moved)) return { ok: false, detail: failed(moved, `Bringing ${source.name} onto ${branch}`) };
      adopted.push(source.name);
      continue;
    }
    // Forked from somewhere else: merged into the given branch, in this worktree.
    const as = await asBox(worktreePath);
    if (!as.ok) return { ok: false, detail: as.detail };
    if (!onGiven) {
      const back = await git(worktreePath, ["checkout", "-q", branch]);
      if (!ok(back)) return { ok: false, detail: failed(back, `Checking ${branch} out to bring ${source.name} onto it`) };
      onGiven = true;
    }
    const merged = await git(worktreePath, [...as.args, "merge", "--no-ff", "--no-edit", "-m", `Bring ${source.name} onto ${branch}`, source.commit]);
    if (!ok(merged)) {
      await git(worktreePath, ["merge", "--abort"]);
      if (headRef !== ref && leftAt) await git(worktreePath, ["checkout", "-q", leftAt]);
      return { ok: false, detail: failed(merged, `Merging ${source.name} into ${branch}`) };
    }
    adopted.push(source.name);
  }
  if (!onGiven && head) {
    const tip = await tipOf();
    if (tip === head) await git(worktreePath, ["symbolic-ref", "HEAD", ref]);
    else if (tip && ok(await git(worktreePath, ["merge-base", "--is-ancestor", head, tip]))) await git(worktreePath, ["checkout", "-q", branch]);
  }
  return { ok: true, from: adopted.length ? adopted.join(", ") : null };
}

/** What failed, then git's own words on one line: a board note quotes the first line only. */
function failed(r: ChildResult, what: string): string {
  return `${what} failed: ${failureDetail(r, what).replace(/\s+/g, " ").trim()}`;
}

/**
 * Of `files` (relative to the worktree), the ones git could have committed:
 * still there, and not ignored. A scratch file the worker wrote and deleted,
 * or a log the project's .gitignore covers, never reaches a branch whatever
 * the runner does — it is not work that went missing, and a check-only task
 * that wrote one must not be rejected for an empty branch. A check git could
 * not make keeps every file that is there.
 */
export async function committableFiles(worktreePath: string, files: string[]): Promise<string[]> {
  const present = files.filter((f) => fs.existsSync(path.join(worktreePath, f)));
  if (present.length === 0) return [];
  // 0: some are ignored, one per line; 1: none is; anything else is no
  // answer. (`-z` needs `--stdin`.) A name git still quotes matches nothing
  // here and stays counted — the rejection the brief asks for, never a loss.
  const r = await git(worktreePath, ["-c", "core.quotePath=false", "check-ignore", "--", ...present]);
  if (r.code !== 0) return present;
  const ignored = new Set(r.stdout.split("\n").filter(Boolean));
  return present.filter((f) => !ignored.has(f));
}

/**
 * The paths `git status --porcelain=v2 -z` names: the ones to commit, and the
 * ones `left` out — generated artifacts and `.clawbox/`. Version 2 because
 * every entry starts with its type, never a space the child's trimmed output
 * could eat. Fields are space-separated up to the path, which is the rest of
 * the entry: 8 fields before it for a change (`1`), 9 for a rename or copy
 * (`2`, its source in the entry after — the old name is part of the change),
 * 10 for an unmerged path (`u`), 1 for an untracked one (`?`).
 */
const PATH_AFTER: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };

function leftovers(porcelain: string): { files: string[]; left: string[] } {
  const entries = porcelain.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const skip = PATH_AFTER[entry[0]];
    if (skip === undefined) continue;
    const file = entry.split(" ").slice(skip).join(" ");
    if (file) paths.add(file);
    if (entry[0] === "2") {
      const source = entries[++i];
      if (source) paths.add(source);
    }
  }
  const never = (p: string) => isGeneratedArtifact(p) || /^\.clawbox(\/|$)/.test(p);
  return { files: [...paths].filter((p) => !never(p)), left: [...paths].filter(never) };
}

/**
 * The worktree's files go; its branch stays as history — unless it is named in
 * `dropBranch`: a worktree made for an attempt that never started (its task
 * stopped being ready while it was made) leaves no history, and its branch
 * name is the one the task's next attempt will ask for.
 */
export function removeWorktree(dir: string, worktreePath: string, opts: { dropBranch?: string } = {}): Promise<void> {
  return withDirLock(dir, async () => {
    await git(dir, ["worktree", "remove", "--force", worktreePath]);
    await git(dir, ["worktree", "prune"]);
    if (opts.dropBranch) await git(dir, ["branch", "-D", opts.dropBranch]);
  });
}

/** The files a worker's branch changed against the team branch, for the reviewer's brief. */
export function changedFiles(dir: string, branch: string): Promise<string[]> {
  return withDirLock(dir, async () => {
    const r = await git(dir, ["diff", "--name-only", `HEAD...${branch}`]);
    return ok(r) ? out(r).split("\n").map((x) => x.trim()).filter(Boolean) : [];
  });
}
