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

import path from "path";
import fs from "fs";
import { runChild, failureDetail, type ChildResult } from "./child-run";

const CALL_TIMEOUT_MS = 60_000;
export const WORKTREES_DIR = path.join(".clawbox", "worktrees");

function git(dir: string, args: string[]): Promise<ChildResult> {
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

const ok = (r: ChildResult) => r.code === 0;
const out = (r: ChildResult) => r.stdout.trim();

/**
 * One lock per repository: workers settle in any order, and two merges (or a
 * merge and a worktree add) on the same checkout share ONE git index — the
 * second would trip over `.git/index.lock`, or its `merge --abort` would undo
 * the first's conflict. Every operation below that touches the main
 * checkout runs under the folder's lock, in the order it was asked.
 */
const dirLocks = new Map<string, Promise<void>>();
async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
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

/**
 * The team's own branch, forked from what the checkout is on and CHECKED
 * OUT in the main checkout, so every merge lands on it and the project
 * page's Create PR has the base to compare against. A repository with no
 * commits gets an empty first one, for the same reason startRunBranch does:
 * `checkout -b` on an unborn HEAD renames it rather than forking.
 */
export function ensureTeamBranch(dir: string, teamId: string): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string }> {
  return withDirLock(dir, () => ensureTeamBranchNow(dir, teamId));
}

async function ensureTeamBranchNow(dir: string, teamId: string): Promise<{ ok: true; branch: string; base: string } | { ok: false; detail: string }> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!ok(inside)) return { ok: false, detail: failureDetail(inside, "Reading the git repository", "Make the folder a git repository first.") };
  const head = await git(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!ok(head)) {
    const seeded = await git(dir, ["commit", "--allow-empty", "-m", "Initial commit"]);
    if (!ok(seeded)) return { ok: false, detail: failureDetail(seeded, "Making the first commit") };
  }
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = ok(current) && out(current) && out(current) !== "HEAD" ? out(current) : "main";
  const branch = teamBranchName(teamId);
  const made = await git(dir, ["checkout", "-b", branch]);
  if (!ok(made)) return { ok: false, detail: failureDetail(made, `Creating the team branch ${branch}`) };
  await excludeWorktrees(dir);
  return { ok: true, branch, base };
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
async function excludeWorktrees(dir: string): Promise<void> {
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
 * Bring a worker's branch into the team branch (the main checkout is on
 * it). `merged: false` when the branch added nothing. A conflict is
 * aborted, never resolved by guess, and reported with git's own words.
 */
export function mergeWorkerBranch(dir: string, branch: string, message: string): Promise<{ ok: true; merged: boolean } | { ok: false; conflict: boolean; detail: string }> {
  return withDirLock(dir, async () => {
    const ahead = await git(dir, ["rev-list", "--count", `HEAD..${branch}`]);
    if (ok(ahead) && out(ahead) === "0") return { ok: true, merged: false };
    // Whatever landed in the team's checkout uncommitted while the workers
    // were out — the favicons the box draws at a run's start above all —
    // goes on the team branch first: a merge refuses to overwrite an
    // untracked file a worker's branch also brought, and "MERGE FAILED …
    // untracked working tree files would be overwritten" rejected finished
    // work for that (team-8l9oudxd, t1, 2026-09-05). An identical file then
    // merges as one; a different one conflicts honestly, below.
    const stray = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
    if (!ok(stray)) return { ok: false, conflict: false, detail: failureDetail(stray, "Reading the team checkout before the merge") };
    if (out(stray)) {
      const added = await git(dir, ["add", "-A"]);
      if (!ok(added)) return { ok: false, conflict: false, detail: failureDetail(added, "Staging the team checkout's files before the merge") };
      const kept = await git(dir, ["-c", "user.name=ClawBox Coding Agent", "-c", "user.email=coding-agent@clawbox.local", "commit", "-q", "--no-verify", "-m", "Coding team: files present in the checkout before a merge"]);
      if (!ok(kept)) return { ok: false, conflict: false, detail: failureDetail(kept, "Committing the team checkout's files before the merge") };
    }
    const merged = await git(dir, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
    if (ok(merged)) return { ok: true, merged: true };
    const conflict = /CONFLICT|Automatic merge failed/i.test(merged.stdout + merged.stderr);
    await git(dir, ["merge", "--abort"]);
    return { ok: false, conflict, detail: failureDetail(merged, `Merging ${branch} into the team branch`) };
  });
}

/** The worktree's files go; its branch stays as history. */
export function removeWorktree(dir: string, worktreePath: string): Promise<void> {
  return withDirLock(dir, async () => {
    await git(dir, ["worktree", "remove", "--force", worktreePath]);
    await git(dir, ["worktree", "prune"]);
  });
}

/** The files a worker's branch changed against the team branch, for the reviewer's brief. */
export function changedFiles(dir: string, branch: string): Promise<string[]> {
  return withDirLock(dir, async () => {
    const r = await git(dir, ["diff", "--name-only", `HEAD...${branch}`]);
    return ok(r) ? out(r).split("\n").map((x) => x.trim()).filter(Boolean) : [];
  });
}
