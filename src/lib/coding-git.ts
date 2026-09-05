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

import fsp from "fs/promises";
import path from "path";
import {
  type ChildResult,
  failureDetail,
  inconclusive,
  killedDetail,
  runChild,
  startedMissing,
  startFailureDetail,
} from "@/lib/child-run";

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
  /** git is not installed — the spawn failed with ENOENT and nothing else.
   *  A git that ran, or one present with the wrong mode bits, is NOT this:
   *  answering either with "install git" offers the one remedy that cannot
   *  work. */
  | "no_git"
  /** git refused, was cut short, or would not start. `detail` always says
   *  which, and is never blank — the run panel renders `detail ?? reason`. */
  | "git_failed";

/**
 * Run one git command in a folder.
 *
 * `git -C` with an argv array, never a shell: the folder name and the commit
 * message both come from outside and neither is quoted by us.
 *
 * The wrapper and the rules for reading a null exit code are shared with
 * coding-github.ts (`@/lib/child-run`). They did not used to be: this file kept
 * its own pre-#518 copy, with no `spawn` listener and no errno, so every fault
 * here — a killed call, a git that would not execute — arrived as the same
 * bare `code: null` and was read as "git is not installed".
 */
function git(dir: string, args: string[]): Promise<ChildResult> {
  return runChild("git", ["-C", dir, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    // GIT_TERMINAL_PROMPT=0 matters: git must fail rather than block forever
    // waiting for a password that nobody is there to type.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      LANG: "C",
    },
    notStarted: "git could not be started",
  });
}

/**
 * The answer to a yes/no question about the folder — or the admission that the
 * probe never produced one.
 *
 * A non-zero exit code is a FINDING: git looked and said no. A null code is
 * not; the call was killed or never started. Collapsing the second into the
 * first is what turned "this folder belongs to another repository, refuse" into
 * `git init` inside somebody else's tracked tree.
 */
type Probe =
  | { known: true; value: boolean }
  | { known: false; result: ChildResult };

/** The refusal for a probe that found nothing. Never blank, and it never
 *  mentions installing anything: git demonstrably ran, or said why it could
 *  not start. */
function unknownShape(probe: { known: false; result: ChildResult }, what: string): GitOutcome {
  return { committed: false, reason: "git_failed", detail: failureDetail(probe.result, what) };
}

/**
 * Whether this folder is the ROOT of its own repository.
 *
 * Deliberately compares resolved paths: being *inside* a repository is not
 * enough, and is exactly the case that would commit into ClawBox's own tree.
 */
async function isOwnRepoRoot(dir: string): Promise<Probe> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (inconclusive(r)) return { known: false, result: r };
  if (r.code !== 0 || !r.stdout) return { known: true, value: false };
  return { known: true, value: path.resolve(r.stdout) === path.resolve(dir) };
}

/** Whether an enclosing repository ignores this folder — i.e. a private repo
 *  inside it is invisible to that outer tree. */
async function ignoredByOuterRepo(dir: string): Promise<Probe> {
  const parent = path.dirname(path.resolve(dir));
  const r = await git(parent, ["check-ignore", "-q", path.resolve(dir)]);
  if (inconclusive(r)) return { known: false, result: r };
  return { known: true, value: r.code === 0 };
}

/** Whether the folder sits inside ANY repository. */
async function insideSomeRepo(dir: string): Promise<Probe> {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inconclusive(r)) return { known: false, result: r };
  return { known: true, value: r.code === 0 && r.stdout === "true" };
}

/**
 * Give the folder a repository of its own, with an identity so commits work on
 * a box that has no global git config — this one had none.
 */
async function initRepo(dir: string): Promise<string | null> {
  const init = await git(dir, ["init", "--quiet"]);
  // Never `init.stderr` alone: a killed `git init` writes none, and the caller
  // renders `detail ?? reason`, so an empty string reached the owner as a
  // failure with nothing in it.
  if (init.code !== 0) return failureDetail(init, "Creating a git repository for the folder");
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
  // `code === null` was read here as "git is not installed". It is not: a
  // failed spawn and a killed child close identically, and even a failed spawn
  // only means absent when the errno is ENOENT. EACCES is a git that is right
  // there with the wrong mode bits, and "install git" is the one remedy that
  // cannot help it.
  if (probe.startFailed) {
    // ENOENT, and only ENOENT, is "no_git". EACCES is a git sitting right there
    // with the wrong mode bits; an errno-less spawn error is not evidence of
    // anything at all, and naming one remedy for it would be the same guess in
    // a smaller hat. startFailureDetail says exactly what each case supports.
    const detail = startFailureDetail(probe, "git");
    return startedMissing(probe)
      ? { committed: false, reason: "no_git", detail }
      : { committed: false, reason: "git_failed", detail };
  }
  if (probe.code === null) {
    // It RAN. Being killed says nothing about whether git is on the box.
    return { committed: false, reason: "git_failed", detail: killedDetail(probe, "Reading the git version", "Try again.") };
  }

  let initialized = false;
  const ownRoot = await isOwnRepoRoot(dir);
  if (!ownRoot.known) return unknownShape(ownRoot, "Reading the folder's git repository");
  if (!ownRoot.value) {
    // Inside something else's tree, and that tree tracks us: refuse. This is
    // the case that would commit into the ClawBox checkout.
    //
    // Both halves of that test must be FINDINGS. A killed probe read as
    // "no repo here" turns the refusal into `git init` inside a tree somebody
    // else's repository tracks — shadowing that subtree's history and
    // committing into it, from a transient fault. An unknown repository shape
    // is not an absent one, and `git init` is not a step to take on a guess.
    const inside = await insideSomeRepo(dir);
    if (!inside.known) return unknownShape(inside, "Checking whether the folder is inside a git repository");
    if (inside.value) {
      const ignored = await ignoredByOuterRepo(dir);
      // The mirror lie: a killed check-ignore read as "not ignored" tells the
      // owner their folder belongs to another repository when it may not.
      if (!ignored.known) return unknownShape(ignored, "Checking whether the outer repository ignores the folder");
      if (!ignored.value) {
        return { committed: false, reason: "foreign_repo", detail: "The folder belongs to another git repository." };
      }
    }
    const err = await initRepo(dir);
    if (err) return { committed: false, reason: "git_failed", detail: err };
    initialized = true;
  }

  // Stage everything in THIS repository. Safe now: its root is this folder.
  const add = await git(dir, ["add", "-A"]);
  // Not `add.stderr`: a SIGKILLed child writes none, and coding-agent.ts renders
  // `detail ?? reason` — "" is not nullish, so the run panel showed the owner
  // literally "Not committed: " and stopped there.
  if (add.code !== 0) return { committed: false, reason: "git_failed", detail: failureDetail(add, "Staging the run's changes") };

  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (staged.code === 0 && !staged.stdout) return { committed: false, reason: "no_changes" };

  const message = buildCommitMessage(input);
  const commit = await git(dir, [
    "-c", `user.name=${COMMIT_NAME}`,
    "-c", `user.email=${COMMIT_EMAIL}`,
    "commit", "--no-verify", "-m", message,
  ]);
  if (commit.code !== 0) return { committed: false, reason: "git_failed", detail: failureDetail(commit, "Committing the run's changes") };

  const sha = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, sha: sha.stdout || "unknown", initialized };
}

/** The newest commit of a folder's own history, for a list row. */
export interface LastCommit {
  subject: string;
  /** When it was made, in Unix milliseconds. */
  date: number;
}

/**
 * The most recent commit in the repository at `dir`, or null when there is
 * none to show — a freshly `git init`ed folder, or a HEAD git cannot read.
 *
 * Read-only, and through the same argv runner as everything above: the
 * folder name is the owner's and is never quoted by us. `%ct` rather than a
 * formatted date so the app can say "3h ago" itself, the way it already does
 * for a run's last activity.
 */
export interface GitInfo {
  branch: string | null;
  commits: number;
  /** origin's URL, or null when the project has never been pushed anywhere. */
  remote: string | null;
  lastCommit: LastCommit | null;
}

/**
 * The project page's git block: branch, commit count, origin, newest commit.
 * Absent pieces are answers, never errors — a fresh init has no HEAD yet and
 * most local projects have no origin until their first GitHub backup.
 *
 * Three git processes, not four: the branch rides on the same `git log -1`
 * that answers the newest commit (`%D` is HEAD's decoration — "HEAD -> main,
 * origin/main"), because the app asks this on every project page and each
 * spawn on a Jetson is felt. A detached HEAD decorates as plain "HEAD", which
 * is also what `rev-parse --abbrev-ref` used to answer for it.
 */
export async function gitInfo(dir: string): Promise<GitInfo> {
  const d = path.resolve(dir);
  const [head, count, remote] = await Promise.all([
    git(d, ["log", "-1", `--format=${LAST_COMMIT_FORMAT}%n%D`]),
    git(d, ["rev-list", "--count", "HEAD"]),
    git(d, ["remote", "get-url", "origin"]),
  ]);
  const [subject = "", seconds = "", decoration = ""] = head.code === 0 ? head.stdout.split("\n") : [];
  return {
    branch: branchFromDecoration(decoration),
    commits: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0,
    remote: remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : null,
    lastCommit: parseLastCommit(subject, seconds),
  };
}

/** Subject, then the commit time in Unix seconds — what parseLastCommit reads. */
const LAST_COMMIT_FORMAT = "%s%n%ct";

function parseLastCommit(subject: string, seconds: string): LastCommit | null {
  const ts = Number(seconds.trim());
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { subject: subject.trim(), date: ts * 1000 };
}

/** The branch HEAD is on, from `%D`; "HEAD" when detached; null when there is no HEAD. */
function branchFromDecoration(decoration: string): string | null {
  const refs = decoration.split(",").map((r) => r.trim()).filter(Boolean);
  const onBranch = refs.find((r) => r.startsWith("HEAD -> "));
  if (onBranch) return onBranch.slice("HEAD -> ".length) || null;
  return refs.includes("HEAD") ? "HEAD" : null;
}

export async function lastCommit(dir: string): Promise<LastCommit | null> {
  const r = await git(path.resolve(dir), ["log", "-1", `--format=${LAST_COMMIT_FORMAT}`]);
  if (r.code !== 0 || !r.stdout) return null;
  const [subject = "", seconds = ""] = r.stdout.split("\n");
  return parseLastCommit(subject, seconds);
}

// ─── The project page's workspace: what changed, and the diff of one file ────
//
// Read-only, every one of them, and through the same argv runner as the
// commits above: a path from the page and a ref from the URL are both outside
// input. A ref is admitted only in the two spellings the page ever sends — a
// hex sha or HEAD — because a "ref" is also where an argv option would go
// (`--output=` writes a file), and a file name always travels after `--`.

export type ChangeStatus = "modified" | "added" | "deleted" | "untracked" | "conflict";

export interface ChangedFile {
  /** Relative to the project folder, forward slashes, the way git prints it. */
  path: string;
  status: ChangeStatus;
  /** Lines added / removed; null for a binary file or a count git did not give. */
  additions: number | null;
  deletions: number | null;
}

export interface GitChanges {
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** True when the listing was cut at MAX_CHANGED_FILES. */
  truncated: boolean;
  /** False for a folder with no repository, a ref that is not one, or a git
   *  that could not answer — the page says "no changes to show" rather than
   *  drawing an empty list as a clean tree. */
  available: boolean;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  /** Unix milliseconds. */
  date: number;
}

export interface FileDiff {
  path: string;
  /** A unified diff, as `git diff` prints it, without colour. */
  diff: string;
  truncated: boolean;
  binary: boolean;
}

/** The page lists this many files at most; a run does not touch more. */
const MAX_CHANGED_FILES = 500;
/** An untracked file larger than this is listed without a line count. */
const MAX_UNTRACKED_COUNT_BYTES = 1_000_000;
/** One file's diff is cut here — the page renders it, the Terminal has the rest. */
const MAX_DIFF_CHARS = 200_000;

const UNAVAILABLE: GitChanges = { files: [], additions: 0, deletions: 0, truncated: false, available: false };

/** The two spellings of a ref the page sends: a hex sha, or HEAD. */
export function isSafeGitRef(ref: string): boolean {
  return /^(HEAD|[0-9a-f]{7,64})$/.test(ref);
}

/**
 * A file path the way the page names one: relative, forward slashes, no `..`
 * segment, nothing absolute. Null for anything else. `path.posix.normalize`
 * folds `./a//b` to `a/b` so a path git printed and a path the page built
 * from it compare equal.
 */
export function safeProjectRelativePath(file: string): string | null {
  if (!file || file.includes("\0")) return null;
  const rel = path.posix.normalize(file.replace(/\\/g, "/"));
  if (rel === "." || rel === "" || path.posix.isAbsolute(rel)) return null;
  if (rel.split("/").some((seg) => seg === "..")) return null;
  return rel.replace(/^\.\//, "");
}

/**
 * The most recent commits, newest first, for the workspace's "which change"
 * picker. Empty for a folder with no history — that is an answer.
 */
export async function gitLog(dir: string, limit = 30): Promise<CommitSummary[]> {
  const r = await git(path.resolve(dir), ["log", `--max-count=${Math.max(1, Math.min(200, limit))}`, "--format=%H%x1f%s%x1f%ct"]);
  if (r.code !== 0 || !r.stdout) return [];
  const out: CommitSummary[] = [];
  for (const line of r.stdout.split("\n")) {
    const [sha = "", subject = "", ct = ""] = line.split("\x1f");
    const ts = Number(ct.trim());
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !Number.isFinite(ts) || ts <= 0) continue;
    out.push({ sha, subject: subject.trim(), date: ts * 1000 });
  }
  return out;
}

/**
 * What changed: the working tree against HEAD when `ref` is absent (a run in
 * flight, or work nobody committed), or one commit's own changes when `ref`
 * names it — which is how the page shows what a finished run did, since a run
 * commits its work the moment it settles and leaves the tree clean.
 */
export async function gitChanges(dir: string, ref?: string | null): Promise<GitChanges> {
  const d = path.resolve(dir);
  if (ref) return isSafeGitRef(ref) ? commitChanges(d, ref) : UNAVAILABLE;
  return workingTreeChanges(d);
}

/** HEAD when there is one; the empty tree otherwise, so a fresh `git init`
 *  diffs as "everything added" instead of failing on a HEAD that is not there. */
async function baseTree(d: string): Promise<string | null> {
  const head = await git(d, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code === 0) return "HEAD";
  const empty = await git(d, ["hash-object", "-t", "tree", "/dev/null"]);
  return empty.code === 0 && /^[0-9a-f]{40,64}$/.test(empty.stdout) ? empty.stdout : null;
}

async function workingTreeChanges(d: string): Promise<GitChanges> {
  // Porcelain v2, deliberately: every v2 record starts with a letter or digit,
  // where v1's " M path" starts with the space runChild's trim() would eat.
  const status = await git(d, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"]);
  if (status.code !== 0) return UNAVAILABLE;
  const base = await baseTree(d);
  if (!base) return UNAVAILABLE;
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const numstat = await git(d, ["diff", "--numstat", "--no-renames", base, "--"]);
  if (numstat.code === 0) parseNumstat(numstat.stdout, counts);

  const files: ChangedFile[] = [];
  let truncated = false;
  for (const record of status.stdout.split("\0")) {
    if (!record) continue;
    const parsed = parsePorcelainV2(record);
    if (!parsed) continue;
    if (files.length >= MAX_CHANGED_FILES) { truncated = true; break; }
    const c = counts.get(parsed.path);
    files.push({
      path: parsed.path,
      status: parsed.status,
      additions: c ? c.additions : parsed.status === "untracked" ? await countLines(path.join(d, parsed.path)) : null,
      deletions: c ? c.deletions : parsed.status === "untracked" ? 0 : null,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, ...totals(files), truncated, available: true };
}

async function commitChanges(d: string, ref: string): Promise<GitChanges> {
  const [numstat, names] = await Promise.all([
    git(d, ["diff-tree", "--no-commit-id", "--numstat", "--no-renames", "-r", "--root", ref]),
    git(d, ["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", "--root", ref]),
  ]);
  if (numstat.code !== 0 || names.code !== 0) return UNAVAILABLE;
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  parseNumstat(numstat.stdout, counts);
  const files: ChangedFile[] = [];
  let truncated = false;
  for (const line of names.stdout.split("\n")) {
    const [letter = "", file = ""] = line.split("\t");
    if (!file) continue;
    if (files.length >= MAX_CHANGED_FILES) { truncated = true; break; }
    const c = counts.get(file);
    files.push({
      path: file,
      status: letter.startsWith("A") ? "added" : letter.startsWith("D") ? "deleted" : "modified",
      additions: c ? c.additions : null,
      deletions: c ? c.deletions : null,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, ...totals(files), truncated, available: true };
}

/**
 * One file's diff — against HEAD (or the empty tree) when `ref` is absent,
 * with an untracked file shown as wholly added the way the page's list already
 * counts it; one commit's change to the file when `ref` names it. Null when
 * the path is not one the page may ask about, or git had nothing to say.
 */
export async function gitFileDiff(dir: string, file: string, ref?: string | null): Promise<FileDiff | null> {
  const d = path.resolve(dir);
  const rel = safeProjectRelativePath(file);
  if (!rel) return null;
  let r: ChildResult;
  if (ref) {
    if (!isSafeGitRef(ref)) return null;
    r = await git(d, ["show", "--format=", "--no-color", "--no-renames", ref, "--", rel]);
  } else {
    const base = await baseTree(d);
    if (!base) return null;
    r = await git(d, ["diff", "--no-color", "--no-renames", base, "--", rel]);
    if (r.code === 0 && !r.stdout) {
      // Nothing changed under that name against the base. For a TRACKED file
      // that is the answer (an empty diff); for an untracked one the file is
      // shown against nothing — `--no-index` exits 1 when the two differ,
      // which is the answer, not a failure.
      const tracked = await git(d, ["ls-files", "--error-unmatch", "--", rel]);
      if (tracked.code !== 0) {
        // Not tracked and not on disk either: there is no such file.
        const exists = await fsp.stat(path.join(d, rel)).then((s) => s.isFile(), () => false);
        if (!exists) return null;
        const fresh = await git(d, ["diff", "--no-color", "--no-index", "--", "/dev/null", rel]);
        if (fresh.code === 0 || fresh.code === 1) r = { ...fresh, code: 0 };
      }
    }
  }
  if (r.code !== 0) return null;
  const binary = /^Binary files .* differ$/m.test(r.stdout);
  const truncated = r.stdout.length > MAX_DIFF_CHARS;
  return { path: rel, diff: truncated ? r.stdout.slice(0, MAX_DIFF_CHARS) : r.stdout, truncated, binary };
}

/** `1 XY sub mH mI mW hH hI path`, `u XY sub m1 m2 m3 mW h1 h2 h3 path`, `? path`. */
function parsePorcelainV2(record: string): { path: string; status: ChangeStatus } | null {
  if (record.startsWith("? ")) return { path: record.slice(2), status: "untracked" };
  if (record.startsWith("u ")) {
    const fields = record.split(" ");
    return fields.length > 10 ? { path: fields.slice(10).join(" "), status: "conflict" } : null;
  }
  if (record.startsWith("1 ")) {
    const fields = record.split(" ");
    if (fields.length < 9) return null;
    const xy = fields[1];
    const file = fields.slice(8).join(" ");
    if (xy.includes("D")) return { path: file, status: "deleted" };
    if (xy.includes("A")) return { path: file, status: "added" };
    return { path: file, status: "modified" };
  }
  return null;
}

/** `added<TAB>deleted<TAB>path`, with `-` for a binary file. */
function parseNumstat(out: string, into: Map<string, { additions: number | null; deletions: number | null }>): void {
  for (const line of out.split("\n")) {
    const [a = "", b = "", file = ""] = line.split("\t");
    if (!file) continue;
    const additions = a === "-" ? null : Number(a);
    const deletions = b === "-" ? null : Number(b);
    into.set(file, {
      additions: additions === null || Number.isFinite(additions) ? additions : null,
      deletions: deletions === null || Number.isFinite(deletions) ? deletions : null,
    });
  }
}

function totals(files: ChangedFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
}

/** Lines in an untracked text file, so the list can say "+12" for it the way
 *  it does for a tracked one; null for a binary or a file too big to count. */
async function countLines(abs: string): Promise<number | null> {
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_COUNT_BYTES) return null;
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return null;
    if (buf.length === 0) return 0;
    let n = 0;
    for (const byte of buf) if (byte === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}
