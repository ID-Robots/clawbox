import fs from "fs";
import path from "@/lib/runtime-path";
import { type ChildResult, failureDetail, inconclusive, runChild, startedMissing } from "@/lib/child-run";
import { GIT_CREDENTIAL_HELPER, githubStatus } from "@/lib/coding-github";
import { filesBrowseRoot } from "@/lib/file-guard";
import { logSafe } from "@/lib/log-safe";
import { listProjectFolders, ProjectFolderError, resolveProjectFolder } from "@/lib/project-folders";
import {
  AUTO_BACKUP_INTERVAL_MS,
  type BackupErrorCode,
  type BackupOverview,
  type BackupStage,
  type FolderBackupStatus,
  type FolderBackupSummary,
  type GitHubConnection,
  type LeftOutFile,
  type PendingChanges,
} from "@/lib/project-backup-shared";
import {
  describeRemote,
  firstFreeRepoName,
  looksLikeSecretName,
  mergeGitignore,
  preflight,
  sanitizeRepoName,
  scrubSecrets,
} from "@/lib/project-backup-safety";
import {
  type BackupRecord,
  getBackupRecord,
  getSuggestionDismissedAt,
  listBackupRecords,
  updateBackupRecord,
  withBackup,
} from "@/lib/project-backup-store";

// ── Projects → GitHub: one-click backup of a pinned project folder ──────────
//
// TASK-1358. For an owner who has never typed a git command: "Back up" on a
// project makes a PRIVATE repository on their GitHub account, named after the
// folder, and every later "Back up now" (or the daily auto-backup) commits
// what changed and pushes it. The GitHub connection is the Coding Agent's —
// the same `gh` login (coding-github.ts), so the owner connects once for both.
//
// The rules this file keeps, each of them pinned by a test:
//
//   - A copy ClawBox creates is PRIVATE, and its name never lands on an
//     existing repository: a clash is answered with the next free "-2", "-3"
//     for the owner to accept, never with a push into what is already there.
//   - A folder that brought its own remote keeps it. ClawBox never adds,
//     changes or removes that remote, never switches branches, never rewrites
//     history and never force-pushes; a push the remote rejects is explained
//     and the backup stops.
//   - Before EVERY commit the safe `.gitignore` is merged in (for a folder
//     with its own remote, into `.git/info/exclude`, which never leaves the
//     box) and every file the commit would carry is checked; what looks like a
//     password, a key, a nested repository or a file over 50 MB stays out and
//     is listed to the owner.
//   - The token never passes through this process. gh holds it; git asks gh
//     through the credential helper the sign-in set up, named again on the
//     push's own command line so an older login without it still works. No
//     token in argv, in a log, in the remote's address or in `.git/config`.
//   - Only pinned project folders, judged by the pins' own guard — so the box's
//     state folders are refused exactly as they are for a pin (TASK-1354).
//
// Owner-only: the gh login lives in the owner's home, and Files is not a
// non-owner surface yet (TASK-1256). The route enforces it.

const GIT_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;
/** A first upload of a big project over a slow uplink takes a while. */
const PUSH_TIMEOUT_MS = 300_000;
/** Paths per `git add` / `git reset` call: well inside any argv limit. */
const PATH_CHUNK = 200;

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9-]+$/;
const DESCRIPTION = "Backup of a project folder, made by ClawBox";

/** The helper gh's sign-in configured for github.com, named on the push itself. Never a token. */
const GITHUB_HELPER_ARGS = [
  "-c", "credential.https://github.com.helper=",
  "-c", `credential.https://github.com.helper=${GIT_CREDENTIAL_HELPER}`,
];

const STATUS_OF: Record<BackupErrorCode, number> = {
  invalid: 400,
  not_pinned: 404,
  missing: 404,
  protected: 403,
  inside_repo: 409,
  no_gh: 503,
  gh_broken: 500,
  gh_unreachable: 503,
  not_connected: 409,
  name_taken: 409,
  name_exhausted: 409,
  missing_scope: 409,
  not_private: 502,
  has_remote: 409,
  not_set_up: 409,
  detached: 409,
  unfinished_merge: 409,
  no_upstream: 409,
  remote_ahead: 409,
  push_refused: 409,
  push_auth: 409,
  busy: 409,
  failed: 500,
};

export interface BackupErrorExtra {
  /** What git or gh said, scrubbed — for the panel's Advanced view only. */
  detail?: string;
  /** The same request may well work if made again. */
  transient?: boolean;
  /** name_taken: the next free name to offer. */
  suggestedName?: string;
  takenName?: string;
  /** inside_repo: the folder of the bigger project. */
  parent?: string;
}

/** A backup the box turned down or could not finish, with a code the Files app words for the owner. */
export class ProjectBackupError extends Error {
  readonly status: number;
  constructor(readonly code: BackupErrorCode, message: string, readonly extra: BackupErrorExtra = {}) {
    super(message);
    this.name = "ProjectBackupError";
    this.status = STATUS_OF[code];
  }
}

// ── Running git and gh ───────────────────────────────────────────────────────

/** A deliberate environment, like coding-github.ts's: HOME for gh's login, no prompts, English messages to match on. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/home/clawbox",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    LANG: "C",
    LC_ALL: "C",
    ...extra,
  };
}

function git(dir: string, args: string[], opts: { timeoutMs?: number; literal?: boolean } = {}): Promise<ChildResult> {
  return runChild("git", ["-C", dir, ...args], {
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    // File names are paths, never patterns: `*.txt` added means the file called that.
    env: childEnv(opts.literal ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
    notStarted: "git could not be started",
  });
}

function gh(args: string[]): Promise<ChildResult> {
  return runChild("gh", args, { timeoutMs: GH_TIMEOUT_MS, env: childEnv(), notStarted: "gh could not be started" });
}

/** A git call that told us nothing (killed, never started) is a fault, never a fact about the folder. */
function noFinding(r: ChildResult, what: string): ProjectBackupError {
  if (startedMissing(r)) return new ProjectBackupError("failed", "git is not installed on this ClawBox.", { detail: failureDetail(r, what) });
  return new ProjectBackupError("failed", `${what} did not finish.`, { detail: failureDetail(r, what), transient: true });
}

function failed(r: ChildResult, what: string): ProjectBackupError {
  return new ProjectBackupError("failed", `${what} did not work.`, { detail: scrubSecrets(failureDetail(r, what)) });
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function chunks<T>(items: readonly T[], size = PATH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── The GitHub connection ────────────────────────────────────────────────────

async function connection(): Promise<GitHubConnection> {
  const s = await githubStatus();
  return {
    installed: s.installed,
    connected: s.connected,
    login: s.login && LOGIN_RE.test(s.login) ? s.login : null,
    ...(s.reason ? { reason: s.reason } : {}),
  };
}

function requireConnected(c: GitHubConnection): string {
  if (c.reason === "not_runnable") throw new ProjectBackupError("gh_broken", "The GitHub helper on this ClawBox would not start.");
  if (c.reason === "unreachable") throw new ProjectBackupError("gh_unreachable", "Could not reach GitHub.", { transient: true });
  if (!c.installed) throw new ProjectBackupError("no_gh", "The GitHub helper is not installed on this ClawBox.");
  if (!c.connected || !c.login) throw new ProjectBackupError("not_connected", "GitHub is not connected yet.");
  return c.login;
}

/** true / false, or null when GitHub could not be asked — and a null is never read as "free". */
async function repoExists(login: string, name: string): Promise<boolean | null> {
  const r = await gh(["api", `repos/${login}/${name}`]);
  if (inconclusive(r)) return null;
  if (r.code === 0) return true;
  if (/HTTP 404|Not Found/i.test(`${r.stderr}\n${r.stdout}`)) return false;
  return null;
}

/** Make the private repository. Answers its `owner/name`; never pushes. */
async function createPrivateRepo(login: string, name: string): Promise<string> {
  const r = await gh(["api", "-X", "POST", "user/repos", "-f", `name=${name}`, "-F", "private=true", "-f", `description=${DESCRIPTION}`]);
  if (inconclusive(r)) {
    throw new ProjectBackupError("gh_unreachable", "Could not reach GitHub.", { detail: failureDetail(r, "Creating the copy on GitHub"), transient: true });
  }
  const said = `${r.stderr}\n${r.stdout}`;
  if (r.code !== 0) {
    if (/name already exists/i.test(said)) {
      const next = await firstFreeRepoName(name, (n) => repoExists(login, n));
      throw new ProjectBackupError("name_taken", "That name is already used on GitHub.", {
        takenName: name,
        ...(next.ok ? { suggestedName: next.name } : {}),
      });
    }
    if (/HTTP 40[134]|scope|Resource not accessible/i.test(said)) {
      throw new ProjectBackupError("missing_scope", "The GitHub connection may not create repositories.", { detail: scrubSecrets(failureDetail(r, "Creating the copy on GitHub")) });
    }
    throw failed(r, "Creating the copy on GitHub");
  }
  let fullName = "";
  let isPrivate = false;
  try {
    const parsed = JSON.parse(r.stdout) as { full_name?: unknown; private?: unknown };
    fullName = typeof parsed.full_name === "string" ? parsed.full_name : "";
    isPrivate = parsed.private === true;
  } catch { /* checked below */ }
  if (!REPO_RE.test(fullName)) throw new ProjectBackupError("failed", "GitHub's answer did not name the new copy.");
  if (!isPrivate) throw new ProjectBackupError("not_private", "GitHub did not make the copy private, so nothing was uploaded.", { detail: fullName });
  return fullName;
}

const createdRemoteUrl = (fullName: string) => `https://github.com/${fullName}.git`;

// ── Reading a folder's git state ─────────────────────────────────────────────

type Shape =
  /** No repository: the first backup starts one. */
  | { kind: "plain" }
  /** Inside a bigger repository that does not ignore it — backing it up alone would split that project. */
  | { kind: "inside"; top: string }
  /** Its own repository. `branch` null is a detached HEAD. */
  | { kind: "repo"; remotes: string[]; branch: string | null; hasHead: boolean };

function real(p: string): string {
  try { return fs.realpathSync(/* turbopackIgnore: true */ p); } catch { return path.resolve(p); }
}

async function inspect(abs: string): Promise<Shape> {
  const top = await git(abs, ["rev-parse", "--show-toplevel"]);
  if (inconclusive(top)) throw noFinding(top, "Reading the folder");
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) return { kind: "plain" };
    throw failed(top, "Reading the folder");
  }
  const topReal = real(top.stdout);
  const absReal = real(abs);
  if (topReal !== absReal) {
    // A project inside a folder the bigger repository IGNORES (the ClawBox
    // checkout's data/ is one) can be a repository of its own harmlessly.
    const rel = path.relative(topReal, absReal).split(path.sep).join("/");
    const ignored = await git(topReal, ["check-ignore", "-q", "--", `${rel}/`]);
    if (inconclusive(ignored)) throw noFinding(ignored, "Reading the folder");
    if (ignored.code === 0) return { kind: "plain" };
    return { kind: "inside", top: topReal };
  }
  const [remotes, branch, head] = await Promise.all([
    git(abs, ["remote"]),
    git(abs, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(abs, ["rev-parse", "--verify", "-q", "HEAD"]),
  ]);
  for (const r of [remotes, branch, head]) if (inconclusive(r)) throw noFinding(r, "Reading the folder");
  if (remotes.code !== 0) throw failed(remotes, "Reading the folder's online copies");
  return {
    kind: "repo",
    remotes: lines(remotes.stdout),
    branch: branch.code === 0 && branch.stdout ? branch.stdout : null,
    hasHead: head.code === 0,
  };
}

/**
 * The address as configured — read from the config, not `git remote get-url`,
 * which applies `url.*.insteadOf` rewrites: on a box whose git config rewrites
 * github.com, get-url answers the rewritten address and the box would stop
 * recognising the copy it made.
 */
async function remoteUrl(abs: string, remote: string): Promise<string | null> {
  const r = await git(abs, ["config", "--get", `remote.${remote}.url`]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** Whether this repository's `origin` is the private copy ClawBox made for it. */
async function isOurCopy(abs: string, record: BackupRecord | null, shape: Shape): Promise<boolean> {
  if (!record || record.kind !== "created" || !record.repo || shape.kind !== "repo") return false;
  if (!shape.remotes.includes("origin")) return false;
  return (await remoteUrl(abs, "origin")) === createdRemoteUrl(record.repo);
}

async function gitDir(abs: string): Promise<string> {
  const r = await git(abs, ["rev-parse", "--absolute-git-dir"]);
  if (r.code !== 0 || !r.stdout) throw failed(r, "Reading the folder's history");
  return r.stdout;
}

/** Where a folder with its own remote sends a backup: its upstream, or the one remote it plainly uses. */
async function pushTarget(abs: string, shape: Extract<Shape, { kind: "repo" }>): Promise<{ remote: string; branch: string }> {
  const branch = shape.branch!;
  const cfg = async (key: string) => {
    const r = await git(abs, ["config", "--get", key]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  };
  const upRemote = await cfg(`branch.${branch}.remote`);
  const upMerge = await cfg(`branch.${branch}.merge`);
  if (upRemote && shape.remotes.includes(upRemote) && upMerge?.startsWith("refs/heads/")) {
    return { remote: upRemote, branch: upMerge.slice("refs/heads/".length) };
  }
  const chosen = [await cfg(`branch.${branch}.pushRemote`), await cfg("remote.pushDefault")]
    .find((r): r is string => !!r && shape.remotes.includes(r))
    ?? (shape.remotes.includes("origin") ? "origin" : shape.remotes.length === 1 ? shape.remotes[0] : null);
  if (!chosen) throw new ProjectBackupError("no_upstream", "This folder has several online copies and none is marked as the main one.");
  return { remote: chosen, branch };
}

// ── What would change ────────────────────────────────────────────────────────

interface Change {
  path: string;
  deleted: boolean;
  /** Already in the index — an owner's own staging, in a folder with its own history. */
  staged: boolean;
  unmerged: boolean;
  /** Kept out by an ignore rule (the safe list or the owner's own); never committed. */
  ignored?: boolean;
}

/** `git status --porcelain=v2 -z`, which starts every entry with a letter (v1's leading space would not survive the trim). */
export function parseStatus(out: string): Change[] {
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const kind = entry[0];
    if (kind === "?" || kind === "!") {
      changes.push({ path: entry.slice(2), deleted: false, staged: false, unmerged: false, ...(kind === "!" ? { ignored: true } : {}) });
      continue;
    }
    const before = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : -1;
    if (before < 0) continue;
    const fields = entry.split(" ");
    const xy = fields[1] ?? "..";
    const p = fields.slice(before).join(" ");
    if (kind === "2") i++; // the path it was renamed from follows
    if (!p) continue;
    changes.push({
      path: p,
      deleted: xy[1] === "D" || (xy[0] === "D" && xy[1] === "."),
      staged: xy[0] !== ".",
      unmerged: kind === "u",
    });
  }
  return changes;
}

/**
 * What changed, plus what the ignore rules keep out (`--ignored=matching`
 * lists an ignored folder as one entry, so `node_modules/` costs one line).
 */
async function readChanges(abs: string): Promise<Change[]> {
  const r = await git(abs, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"]);
  if (inconclusive(r)) throw noFinding(r, "Reading what changed");
  if (r.code !== 0) throw failed(r, "Reading what changed");
  return parseStatus(r.stdout);
}

/**
 * The check before a commit, over what git listed: the changes go through
 * `preflight`; of what an ignore rule already keeps out, the ones that look
 * like passwords or keys are named too — the owner is told a `.env` stayed
 * home whether the `.gitignore` or the check is what stopped it.
 */
function checkChanges(abs: string, changes: Change[]): { safe: string[]; leftOut: LeftOutFile[] } {
  const { safe, leftOut } = preflight(abs, changes.filter((c) => !c.ignored).map((c) => ({ path: c.path, deleted: c.deleted })));
  for (const c of changes) {
    const p = c.path.replace(/\/+$/, "");
    if (c.ignored && p && looksLikeSecretName(p)) leftOut.push({ path: p, reason: "secret_name" });
  }
  return { safe, leftOut };
}

async function pendingFor(abs: string): Promise<PendingChanges> {
  const { safe, leftOut } = checkChanges(abs, await readChanges(abs));
  return { files: safe.length, leftOut };
}

/** Merge the safe patterns into a file — `.gitignore`, or `.git/info/exclude` for a folder with its own remote. */
function mergeIgnoreFile(file: string): void {
  let existing: string | null = null;
  try {
    const st = fs.lstatSync(/* turbopackIgnore: true */ file);
    // A link could point anywhere; a folder is not a list. Neither is ours to write.
    if (!st.isFile()) return;
    existing = fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8");
  } catch { /* none yet */ }
  const { text, added } = mergeGitignore(existing);
  if (added.length === 0) return;
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ file, text);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Backup from ClawBox, 1 Oct 2026 20:40" — the box's local time, as the owner reads the clock. */
export function backupMessage(d: Date = new Date()): string {
  return `Backup from ClawBox, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** user.name / user.email for the commit when the folder (or the box) has none — the GitHub account's private noreply address. */
async function identityArgs(abs: string, login: string | null): Promise<string[]> {
  const [email, name] = await Promise.all([git(abs, ["config", "user.email"]), git(abs, ["config", "user.name"])]);
  const args: string[] = [];
  if (!(email.code === 0 && email.stdout)) args.push("-c", `user.email=${login ? `${login}@users.noreply.github.com` : "backup@clawbox.local"}`);
  if (!(name.code === 0 && name.stdout)) args.push("-c", `user.name=${login ?? "ClawBox backup"}`);
  return args;
}

/**
 * Check, stage and commit what changed. Everything the check flags stays out
 * of the commit — taken back out of the index too, when an owner had staged it.
 */
async function commitChanges(abs: string, opts: { hasHead: boolean; login: string | null; at: Date }): Promise<{ committed: boolean; leftOut: LeftOutFile[] }> {
  const changes = await readChanges(abs);
  const dir = await gitDir(abs);
  if (changes.some((c) => c.unmerged) || ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) => fs.existsSync(/* turbopackIgnore: true */ path.join(dir, f)))) {
    throw new ProjectBackupError("unfinished_merge", "This folder is in the middle of combining changes in Git.");
  }
  const { safe, leftOut } = checkChanges(abs, changes);
  const out = new Set(leftOut.map((f) => f.path));
  const stagedButOut = changes.filter((c) => c.staged && out.has(c.path)).map((c) => c.path);
  for (const group of chunks(stagedButOut)) {
    const r = opts.hasHead
      ? await git(abs, ["reset", "-q", "--", ...group], { literal: true })
      : await git(abs, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...group], { literal: true });
    if (r.code !== 0) throw inconclusive(r) ? noFinding(r, "Leaving out files") : failed(r, "Leaving out files");
  }
  for (const group of chunks(safe)) {
    const r = await git(abs, ["add", "-A", "--", ...group], { literal: true });
    if (r.code !== 0) throw inconclusive(r) ? noFinding(r, "Preparing files") : failed(r, "Preparing files");
  }
  const staged = await git(abs, ["diff", "--cached", "--name-only", "-z"]);
  if (inconclusive(staged)) throw noFinding(staged, "Preparing files");
  if (staged.code !== 0) throw failed(staged, "Preparing files");
  if (!staged.stdout.split("\0").some(Boolean)) return { committed: false, leftOut };
  const commit = await git(abs, [
    "-c", "commit.gpgsign=false",
    ...(await identityArgs(abs, opts.login)),
    "commit", "--no-verify", "-q", "-m", backupMessage(opts.at),
  ]);
  if (commit.code !== 0) throw inconclusive(commit) ? noFinding(commit, "Saving a version") : failed(commit, "Saving a version");
  return { committed: true, leftOut };
}

/** The remote-tracking tip a push starts from, or null when this box has never seen one. */
async function trackingTip(abs: string, remote: string, branch: string): Promise<string | null> {
  const r = await git(abs, ["rev-parse", "-q", "--verify", `refs/remotes/${remote}/${branch}^{commit}`]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/**
 * How many files a backup changed on the online copy: against the tip this
 * box last saw there; for a first upload, every file; and for a remote this
 * box has never fetched from, the files of the version it just saved.
 */
async function countPushedFiles(abs: string, opts: { oldTip: string | null; everything?: boolean; committed?: boolean }): Promise<number> {
  let r: ChildResult;
  if (opts.oldTip) r = await git(abs, ["diff", "--name-only", "-z", opts.oldTip, "HEAD"]);
  else if (opts.everything) r = await git(abs, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
  else if (opts.committed) r = await git(abs, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", "HEAD"]);
  else return 0;
  return r.code === 0 ? r.stdout.split("\0").filter(Boolean).length : 0;
}

/**
 * Push, never forced. A rejection is read for what it was: the remote moved
 * on (someone pushed from another computer), the remote refused, or the
 * sign-in did not cover it. Each stops the backup with its own sentence.
 */
async function push(abs: string, remote: string, branch: string, opts: { githubHelper: boolean; setUpstream: boolean }): Promise<void> {
  const args = [
    ...(opts.githubHelper ? GITHUB_HELPER_ARGS : []),
    "push",
    ...(opts.setUpstream ? ["--set-upstream"] : []),
    "--",
    remote,
    `HEAD:refs/heads/${branch}`,
  ];
  const r = await git(abs, args, { timeoutMs: PUSH_TIMEOUT_MS });
  if (r.code === 0) return;
  if (inconclusive(r)) {
    throw new ProjectBackupError("gh_unreachable", "The upload did not finish.", { detail: failureDetail(r, "Uploading"), transient: true });
  }
  const said = `${r.stderr}\n${r.stdout}`;
  const detail = scrubSecrets(failureDetail(r, "Uploading"));
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(said) && !/\[remote rejected\]/i.test(said)) {
    throw new ProjectBackupError("remote_ahead", "The online copy has changes this folder does not have.", { detail });
  }
  if (/Authentication failed|could not read Username|Permission denied|Permission to .* denied|returned error: 403|Repository not found/i.test(said)) {
    throw new ProjectBackupError("push_auth", "The online copy did not accept this box's sign-in.", { detail });
  }
  if (/\[remote rejected\]|protected branch|hook declined/i.test(said)) {
    throw new ProjectBackupError("push_refused", "The online copy refused the backup.", { detail });
  }
  if (/Could not resolve host|unable to access|timed out|Network is unreachable|Connection refused/i.test(said)) {
    throw new ProjectBackupError("gh_unreachable", "Could not reach the online copy.", { detail, transient: true });
  }
  throw new ProjectBackupError("failed", "The upload did not work.", { detail });
}

// ── Which folders ────────────────────────────────────────────────────────────

interface Folder { abs: string; rel: string; name: string }

/** A PINNED project folder that exists and that the pins' guard still allows. */
async function pinnedFolder(input: unknown): Promise<Folder> {
  if (typeof input !== "string" || !input.trim() || input.length > 4096) {
    throw new ProjectBackupError("invalid", "path required");
  }
  let resolved: { abs: string; rel: string };
  try {
    resolved = resolveProjectFolder(input);
  } catch (err) {
    if (err instanceof ProjectFolderError) {
      if (err.code === "protected") throw new ProjectBackupError("protected", "That folder holds the box's private data and cannot be backed up.");
      if (err.code === "not_found" || err.code === "not_directory") throw new ProjectBackupError("missing", "That folder is not there.");
      throw new ProjectBackupError(err.code === "invalid" ? "invalid" : "not_pinned", err.message);
    }
    throw err;
  }
  const pin = (await listProjectFolders()).find((f) => f.path === resolved.rel && !f.missing);
  if (!pin) throw new ProjectBackupError("not_pinned", "Only folders in Projects can be backed up.");
  return { ...resolved, name: pin.name };
}

// One backup at a time on the box (they share one uplink and one gh login),
// and never two of the same folder: the second is told it is already running.
const running = new Map<string, BackupStage>();
let chain: Promise<unknown> = Promise.resolve();

async function exclusive<T>(rel: string, fn: (stage: (s: BackupStage) => void) => Promise<T>): Promise<T> {
  if (running.has(rel)) throw new ProjectBackupError("busy", "A backup of this folder is already running.");
  running.set(rel, "preparing");
  const run = chain.then(() => fn((s) => running.set(rel, s)));
  chain = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    running.delete(rel);
  }
}

/**
 * What a running backup of this folder is doing, for the panel's progress
 * line — lexical and local, so polling it costs no call to GitHub. Null when
 * nothing is running (or the path names no folder).
 */
export function runningStage(input: unknown): BackupStage | null {
  try {
    return running.get(resolveProjectFolder(input).rel) ?? null;
  } catch {
    return null;
  }
}

/** Test-only: forget a stuck lock between cases. */
export function _resetProjectBackupForTest(): void {
  running.clear();
  chain = Promise.resolve();
}

export interface BackupDone {
  ok: true;
  /** Nothing had changed, so nothing was sent (and no History entry made). */
  nothingChanged: boolean;
  files: number;
  commit: string | null;
  leftOut: LeftOutFile[];
  /** created: the private copy, `owner/name`. */
  repo?: string;
}

function logOutcome(folder: Folder, outcome: string): void {
  console.log(`[project-backup] ${logSafe(folder.name, 80)}: ${outcome}`);
}

// ── First backup ─────────────────────────────────────────────────────────────

/**
 * The first backup of a folder that has no online copy: a private repository
 * named `name` (the folder's own name when none is given, sanitised), the
 * safe `.gitignore`, a first commit, the upload. A name GitHub already has is
 * answered `name_taken` with the next free one — nothing is created and
 * nothing is pushed until the owner says which.
 */
export async function firstBackup(input: unknown, opts: { name?: unknown } = {}): Promise<BackupDone> {
  const folder = await pinnedFolder(input);
  if (opts.name !== undefined && (typeof opts.name !== "string" || opts.name.length > 200)) {
    throw new ProjectBackupError("invalid", "name must be a short text");
  }
  return exclusive(folder.rel, async (stage) => {
    const login = requireConnected(await connection());
    const shape = await inspect(folder.abs);
    if (shape.kind === "inside") throw new ProjectBackupError("inside_repo", "This folder is part of a bigger Git project.", { parent: path.basename(shape.top) });
    if (shape.kind === "repo" && shape.remotes.length > 0) throw new ProjectBackupError("has_remote", "This folder already has its own online copy.");
    if (shape.kind === "repo" && !shape.branch) throw new ProjectBackupError("detached", "This folder is not on a branch.");

    const typed = typeof opts.name === "string" && opts.name.trim() ? opts.name : folder.name;
    const name = sanitizeRepoName(typed);
    const taken = await repoExists(login, name);
    if (taken === null) throw new ProjectBackupError("gh_unreachable", "Could not reach GitHub.", { transient: true });
    if (taken) {
      const next = await firstFreeRepoName(name, (n) => repoExists(login, n));
      if (!next.ok && next.reason === "unreachable") throw new ProjectBackupError("gh_unreachable", "Could not reach GitHub.", { transient: true });
      if (!next.ok) throw new ProjectBackupError("name_exhausted", "No free name was found on GitHub.", { takenName: name });
      throw new ProjectBackupError("name_taken", "That name is already used on GitHub.", { takenName: name, suggestedName: next.name });
    }

    stage("preparing");
    let branch = shape.kind === "repo" ? shape.branch! : "main";
    if (shape.kind === "plain") {
      const init = await git(folder.abs, ["init", "-q"]);
      if (init.code !== 0) throw inconclusive(init) ? noFinding(init, "Starting the history") : failed(init, "Starting the history");
      // `git init -b` arrived in 2.28; this works on every git.
      const head = await git(folder.abs, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      if (head.code !== 0) throw failed(head, "Starting the history");
      branch = "main";
    }
    mergeIgnoreFile(path.join(folder.abs, ".gitignore"));
    const at = new Date();
    const prepared = await commitChanges(folder.abs, { hasHead: shape.kind === "repo" && shape.hasHead, login, at });
    const head = await git(folder.abs, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (head.code !== 0) throw new ProjectBackupError("failed", "There was nothing in the folder to back up.");

    const fullName = await createPrivateRepo(login, name);
    const added = await git(folder.abs, ["remote", "add", "origin", createdRemoteUrl(fullName)]);
    if (added.code !== 0) throw failed(added, "Connecting the folder to its copy");
    // Remembered before the upload: a push that fails leaves a folder that is
    // set up and not yet uploaded, which "Back up now" finishes — rather than
    // a repository on GitHub the box has forgotten making.
    const record = await updateBackupRecord(folder.rel, () => ({
      path: folder.rel,
      kind: "created",
      repo: fullName,
      branch,
      createdAt: at.getTime(),
      lastBackupAt: null,
      auto: false,
      lastAutoRunAt: null,
      lastAutoError: null,
      history: [],
      leftOut: prepared.leftOut,
    }));

    stage("uploading");
    await push(folder.abs, "origin", branch, { githubHelper: true, setUpstream: true });
    const files = await countPushedFiles(folder.abs, { oldTip: null, everything: true });
    const sha = await git(folder.abs, ["rev-parse", "--short", "HEAD"]);
    const entry = { at: Date.now(), files, commit: sha.code === 0 ? sha.stdout : "" };
    await updateBackupRecord(folder.rel, (cur) => withBackup(cur ?? record!, entry, prepared.leftOut, branch));
    logOutcome(folder, `first backup, ${files} file(s), ${prepared.leftOut.length} left out`);
    return { ok: true, nothingChanged: false, files, commit: entry.commit || null, leftOut: prepared.leftOut, repo: fullName };
  });
}

// ── Back up now ──────────────────────────────────────────────────────────────

/**
 * Commit what changed and push it — to the private copy ClawBox made, or, for
 * a folder that brought its own remote, to that remote and the current
 * branch's upstream, exactly as they are. Nothing changed and nothing waiting
 * to go up answers `nothingChanged` without touching the network.
 */
export async function backUpNow(input: unknown, opts: { auto?: boolean } = {}): Promise<BackupDone> {
  const folder = await pinnedFolder(input);
  return exclusive(folder.rel, async (stage) => {
    const record = await getBackupRecord(folder.rel);
    const shape = await inspect(folder.abs);
    if (shape.kind === "inside") throw new ProjectBackupError("inside_repo", "This folder is part of a bigger Git project.", { parent: path.basename(shape.top) });
    if (shape.kind === "plain" || shape.remotes.length === 0) throw new ProjectBackupError("not_set_up", "This folder is not backed up yet.");
    if (!shape.branch) throw new ProjectBackupError("detached", "This folder is not on a branch.");
    const ours = await isOurCopy(folder.abs, record, shape);

    let login: string | null;
    if (ours) {
      login = requireConnected(await connection());
    } else {
      // The folder's own remote may not be GitHub at all; the login only names the commit's author.
      login = await connection().then((c) => c.login, () => null);
    }

    stage("preparing");
    const target = ours ? { remote: "origin", branch: shape.branch } : await pushTarget(folder.abs, shape);
    if (ours) mergeIgnoreFile(path.join(folder.abs, ".gitignore"));
    else {
      const ex = await git(folder.abs, ["rev-parse", "--git-path", "info/exclude"]);
      if (ex.code === 0 && ex.stdout) mergeIgnoreFile(path.resolve(folder.abs, ex.stdout));
    }
    const oldTip = await trackingTip(folder.abs, target.remote, target.branch);
    const prepared = await commitChanges(folder.abs, { hasHead: shape.hasHead, login, at: new Date() });

    if (!prepared.committed) {
      let waiting = true;
      if (oldTip) {
        const ahead = await git(folder.abs, ["rev-list", "--count", `${oldTip}..HEAD`]);
        waiting = !(ahead.code === 0 && ahead.stdout === "0");
      } else if (!shape.hasHead) {
        waiting = false;
      }
      if (!waiting) {
        if (record) await updateBackupRecord(folder.rel, (cur) => (cur ? { ...cur, leftOut: prepared.leftOut } : cur));
        logOutcome(folder, `nothing changed${opts.auto ? " (daily)" : ""}`);
        return { ok: true, nothingChanged: true, files: 0, commit: null, leftOut: prepared.leftOut, ...(ours ? { repo: record!.repo! } : {}) };
      }
    }

    stage("uploading");
    await push(folder.abs, target.remote, target.branch, { githubHelper: ours, setUpstream: ours });
    const files = await countPushedFiles(folder.abs, { oldTip, committed: prepared.committed });
    const sha = await git(folder.abs, ["rev-parse", "--short", "HEAD"]);
    const entry = { at: Date.now(), files, commit: sha.code === 0 ? sha.stdout : "" };
    await updateBackupRecord(folder.rel, (cur) => {
      const base: BackupRecord = cur && (ours ? cur.kind === "created" : cur.kind === "existing")
        ? cur
        : {
          path: folder.rel,
          kind: "existing",
          repo: null,
          branch: target.branch,
          createdAt: Date.now(),
          lastBackupAt: null,
          auto: false,
          lastAutoRunAt: null,
          lastAutoError: null,
          history: [],
          leftOut: [],
        };
      return withBackup(base, entry, prepared.leftOut, target.branch);
    });
    logOutcome(folder, `${files} file(s) backed up${opts.auto ? " (daily)" : ""}, ${prepared.leftOut.length} left out`);
    return { ok: true, nothingChanged: false, files, commit: entry.commit || null, leftOut: prepared.leftOut, ...(ours ? { repo: record!.repo! } : {}) };
  });
}

// ── Settings: daily backup, disconnect ───────────────────────────────────────

/** Daily auto-backup for a folder ClawBox backs up. Off by default. */
export async function setAutoBackup(input: unknown, enabled: unknown): Promise<{ auto: boolean }> {
  if (typeof enabled !== "boolean") throw new ProjectBackupError("invalid", "enabled must be true or false");
  const folder = await pinnedFolder(input);
  const record = await getBackupRecord(folder.rel);
  if (!record || record.kind !== "created") throw new ProjectBackupError("not_set_up", "This folder is not backed up by ClawBox yet.");
  const saved = await updateBackupRecord(folder.rel, (cur) => (cur ? { ...cur, auto: enabled, lastAutoError: null } : cur));
  return { auto: saved?.auto ?? false };
}

/**
 * Stop backing a folder up. The copy on GitHub stays — this box could not
 * delete it if it wanted to (the sign-in has no delete scope) and must not.
 * For a copy ClawBox made, the `origin` it added is taken off again so the
 * folder reads as not backed up; a remote the folder brought is never touched.
 */
export async function disconnectFolder(input: unknown): Promise<{ removedRemote: boolean }> {
  const folder = await pinnedFolder(input);
  return exclusive(folder.rel, async () => {
    const record = await getBackupRecord(folder.rel);
    if (!record) return { removedRemote: false };
    let removedRemote = false;
    if (record.kind === "created" && record.repo && (await remoteUrl(folder.abs, "origin")) === createdRemoteUrl(record.repo)) {
      const r = await git(folder.abs, ["remote", "remove", "origin"]);
      if (r.code !== 0) throw inconclusive(r) ? noFinding(r, "Disconnecting") : failed(r, "Disconnecting");
      removedRemote = true;
    }
    await updateBackupRecord(folder.rel, () => null);
    logOutcome(folder, "disconnected (the copy on GitHub stays)");
    return { removedRemote };
  });
}

// ── What the Files app reads ─────────────────────────────────────────────────

/** Every pinned folder's backup state, from the box's own records and a local `git remote` — the Projects list. */
export async function backupOverview(): Promise<BackupOverview> {
  const [folders, records, suggestionDismissedAt, github] = await Promise.all([
    listProjectFolders(),
    listBackupRecords(),
    getSuggestionDismissedAt(),
    connection(),
  ]);
  const root = path.resolve(filesBrowseRoot());
  const summaries: FolderBackupSummary[] = [];
  for (const f of folders) {
    if (f.missing) continue;
    const rec = records.find((r) => r.path === f.path);
    if (rec) {
      summaries.push({ path: f.path, state: rec.kind === "created" ? "backed_up" : "existing_git", lastBackupAt: rec.lastBackupAt, auto: rec.auto });
      continue;
    }
    const abs = path.resolve(root, f.path);
    let hasRemote = false;
    if (fs.existsSync(/* turbopackIgnore: true */ path.join(abs, ".git"))) {
      const r = await git(abs, ["remote"]);
      hasRemote = r.code === 0 && lines(r.stdout).length > 0;
    }
    summaries.push({ path: f.path, state: hasRemote ? "existing_git" : "none", lastBackupAt: null, auto: false });
  }
  return { github, folders: summaries, suggestionDismissedAt };
}

/** One folder, for the backup panel. Reads only — it never starts a repository or writes a file. */
export async function folderBackupStatus(input: unknown): Promise<FolderBackupStatus> {
  const folder = await pinnedFolder(input);
  const [github, record, shape] = await Promise.all([connection(), getBackupRecord(folder.rel), inspect(folder.abs)]);
  const base: FolderBackupStatus = {
    folder: { path: folder.rel, name: folder.name },
    github,
    state: "not_set_up",
    lastBackupAt: null,
    auto: false,
    lastAutoError: null,
    history: [],
    lastLeftOut: [],
    pending: null,
    running: running.get(folder.rel) ?? null,
  };
  const withRecord = (rec: BackupRecord | null): Partial<FolderBackupStatus> => rec
    ? { lastBackupAt: rec.lastBackupAt, auto: rec.auto, lastAutoError: rec.lastAutoError, history: rec.history, lastLeftOut: rec.leftOut }
    : {};

  if (shape.kind === "inside") return { ...base, state: "refused", refusal: { code: "inside_repo", parent: path.basename(shape.top) } };

  if (shape.kind === "repo" && shape.remotes.length > 0) {
    if (await isOurCopy(folder.abs, record, shape)) {
      return {
        ...base,
        ...withRecord(record),
        state: "backed_up",
        repo: { fullName: record!.repo!, webUrl: `https://github.com/${record!.repo}`, branch: shape.branch ?? record!.branch ?? "main" },
        pending: await pendingFor(folder.abs),
      };
    }
    let remote: FolderBackupStatus["remote"] = { label: "", webUrl: null, branch: shape.branch };
    try {
      const target = shape.branch ? await pushTarget(folder.abs, shape) : { remote: shape.remotes.includes("origin") ? "origin" : shape.remotes[0], branch: null };
      const url = await remoteUrl(folder.abs, target.remote);
      const described = describeRemote(url ?? target.remote);
      remote = { label: described.label, webUrl: described.webUrl, branch: target.branch };
    } catch {
      const url = await remoteUrl(folder.abs, shape.remotes[0]);
      const described = describeRemote(url ?? shape.remotes[0]);
      remote = { label: described.label, webUrl: described.webUrl, branch: shape.branch };
    }
    return {
      ...base,
      ...withRecord(record?.kind === "existing" ? record : null),
      state: "existing_git",
      remote,
      pending: await pendingFor(folder.abs),
    };
  }

  const out: FolderBackupStatus = { ...base, state: "not_set_up", isRepo: shape.kind === "repo" };
  if (shape.kind === "repo") out.pending = await pendingFor(folder.abs);
  if (github.connected && github.login) {
    const free = await firstFreeRepoName(sanitizeRepoName(folder.name), (n) => repoExists(github.login!, n));
    if (free.ok) {
      out.suggestedName = free.name;
      if (free.taken) out.takenName = free.taken;
    }
  }
  return out;
}

// ── The daily auto-backup ────────────────────────────────────────────────────

/**
 * Back up every folder whose daily backup is on and due — a day since it last
 * ran or was backed up by hand — and that is still pinned and present. A folder
 * where nothing changed is looked at and left alone. Answers how many it ran.
 * Called by project-backup-scheduler.ts.
 */
export async function runDueAutoBackups(now: number = Date.now()): Promise<number> {
  const due = (await listBackupRecords()).filter((r) => r.auto && r.kind === "created"
    && now - Math.max(r.lastAutoRunAt ?? 0, r.lastBackupAt ?? 0) >= AUTO_BACKUP_INTERVAL_MS);
  if (due.length === 0) return 0;
  const present = new Set((await listProjectFolders()).filter((f) => !f.missing).map((f) => f.path));
  let ran = 0;
  for (const rec of due) {
    if (!present.has(rec.path)) continue;
    let code: BackupErrorCode | null = null;
    try {
      await backUpNow(rec.path, { auto: true });
    } catch (err) {
      code = err instanceof ProjectBackupError ? err.code : "failed";
      console.warn(`[project-backup] daily backup of ${logSafe(rec.path, 120)} did not run: ${code}`);
    }
    if (code === "busy") continue;
    const at = Date.now();
    await updateBackupRecord(rec.path, (cur) => (cur ? { ...cur, lastAutoRunAt: at, lastAutoError: code ? { at, code } : null } : cur));
    ran++;
  }
  return ran;
}
