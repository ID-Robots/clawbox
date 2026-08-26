/**
 * Per-run git history for the coding agent.
 *
 * A delegated run edits files unattended, so the owner needs a way back that
 * does not depend on remembering what a folder looked like an hour ago. After
 * a run that changed something, its work is committed in the folder it worked
 * in — one commit per run, with the run id in the message.
 *
 * THE RULE THAT MATTERS
 *
 * A commit is only ever made in a repository whose ROOT is the run's own
 * folder. This is not fussiness. Code projects live under
 * `data/code-projects/` inside the ClawBox OS checkout, so
 * `git rev-parse --show-toplevel` from one of them answers
 * `/home/clawbox/clawbox` — the product's own repository. A `git add -A` there
 * would stage against ClawBox itself, and a `git commit` would land whatever
 * else happened to be staged. Measured on a real box before writing any of
 * this.
 *
 * So the folder gets its OWN repository, or it gets nothing:
 *
 *   - already its own repo root      → commit there
 *   - inside a repo that IGNORES it  → `git init`, giving it a private history
 *     the outer repo cannot see (data/ is gitignored, so every code project
 *     lands here)
 *   - inside a repo that TRACKS it   → refuse. That is someone else's working
 *     tree and a run has no business committing to it.
 *   - no repo anywhere               → `git init`
 *
 * Nothing here pushes. A commit is local, reversible and private; sending code
 * somewhere is a separate decision the owner makes.
 */

import { spawn } from "child_process";
import path from "path";

/** A commit message never grows past this, however long the summary is. */
const MAX_MESSAGE_CHARS = 900;
/** Git should never take this long on a project folder. */
const GIT_TIMEOUT_MS = 30_000;

/** Identity for commits the device makes on the owner's behalf. Set per-repo,
 *  never globally — the box may have its own identity for other work. */
const COMMIT_NAME = "ClawBox Coding Agent";
const COMMIT_EMAIL = "coding-agent@clawbox.local";

export type GitOutcome =
  | { committed: true; sha: string; initialized: boolean }
  | { committed: false; reason: GitSkipReason; detail?: string };

export type GitSkipReason =
  /** The run changed nothing, so there is nothing to record. */
  | "no_changes"
  /** The folder belongs to a repository that tracks it — not ours to commit to. */
  | "foreign_repo"
  /** git is not installed. */
  | "no_git"
  /** git refused; detail carries what it said. */
  | "git_failed";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one git command in a folder.
 *
 * `git -C` with an argv array, never a shell: the folder name and the commit
 * message both come from outside and neither is quoted by us.
 */
function git(dir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", dir, ...args], {
      // Cast only because this repo's ProcessEnv augmentation insists on
      // NODE_ENV, which git has no use for. GIT_TERMINAL_PROMPT=0 matters:
      // git must fail rather than block forever waiting for a password that
      // nobody is there to type.
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        LANG: "C",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr: "git could not be started" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

/**
 * Whether this folder is the ROOT of its own repository.
 *
 * Deliberately compares resolved paths: being *inside* a repository is not
 * enough, and is exactly the case that would commit into ClawBox's own tree.
 */
async function isOwnRepoRoot(dir: string): Promise<boolean> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0 || !r.stdout) return false;
  return path.resolve(r.stdout) === path.resolve(dir);
}

/** Whether an enclosing repository ignores this folder — i.e. a private repo
 *  inside it is invisible to that outer tree. */
async function ignoredByOuterRepo(dir: string): Promise<boolean> {
  const parent = path.dirname(path.resolve(dir));
  const r = await git(parent, ["check-ignore", "-q", path.resolve(dir)]);
  return r.code === 0;
}

/** Whether the folder sits inside ANY repository. */
async function insideSomeRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout === "true";
}

/**
 * Give the folder a repository of its own, with an identity so commits work on
 * a box that has no global git config — this one had none.
 */
async function initRepo(dir: string): Promise<string | null> {
  const init = await git(dir, ["init", "--quiet"]);
  if (init.code !== 0) return init.stderr || "git init failed";
  await git(dir, ["config", "user.name", COMMIT_NAME]);
  await git(dir, ["config", "user.email", COMMIT_EMAIL]);
  return null;
}

/** The commit message: what the run was, and what it said it did. */
export function buildCommitMessage(input: { runId: string; task: string; summary: string | null }): string {
  const subject = `Coding agent: ${firstLine(input.task, 68)}`;
  const body = [
    "",
    input.summary ? input.summary.trim() : "",
    "",
    `Run: ${input.runId}`,
  ].join("\n");
  return `${subject}\n${body}`.slice(0, MAX_MESSAGE_CHARS);
}

function firstLine(text: string, max: number): string {
  const line = (text || "work").split("\n")[0].trim() || "work";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Commit whatever the run changed, in its own folder.
 *
 * Never throws: a failure to record history must not turn a finished run into
 * a failed one. Every outcome is reported so the owner can be told why.
 */
export async function commitRunWork(input: {
  directory: string;
  runId: string;
  task: string;
  summary: string | null;
}): Promise<GitOutcome> {
  const dir = path.resolve(input.directory);

  const probe = await git(dir, ["--version"]);
  if (probe.code === null) return { committed: false, reason: "no_git" };

  let initialized = false;
  if (!(await isOwnRepoRoot(dir))) {
    // Inside something else's tree, and that tree tracks us: refuse. This is
    // the case that would commit into the ClawBox checkout.
    if ((await insideSomeRepo(dir)) && !(await ignoredByOuterRepo(dir))) {
      return { committed: false, reason: "foreign_repo", detail: "The folder belongs to another git repository." };
    }
    const err = await initRepo(dir);
    if (err) return { committed: false, reason: "git_failed", detail: err };
    initialized = true;
  }

  // Stage everything in THIS repository. Safe now: its root is this folder.
  const add = await git(dir, ["add", "-A"]);
  if (add.code !== 0) return { committed: false, reason: "git_failed", detail: add.stderr };

  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (staged.code === 0 && !staged.stdout) return { committed: false, reason: "no_changes" };

  const message = buildCommitMessage(input);
  const commit = await git(dir, [
    "-c", `user.name=${COMMIT_NAME}`,
    "-c", `user.email=${COMMIT_EMAIL}`,
    "commit", "--no-verify", "-m", message,
  ]);
  if (commit.code !== 0) return { committed: false, reason: "git_failed", detail: commit.stderr };

  const sha = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, sha: sha.stdout || "unknown", initialized };
}
