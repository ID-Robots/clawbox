/**
 * The vault's git: one repository, one committer, one operation at a time.
 *
 * Every mutating operation on the vault is exactly ONE commit committed by
 * `Prime Radiant <prime-radiant@localhost>`, so `git log -- <page>` is that
 * page's history and `git revert` is its undo. The AUTHOR is Prime Radiant
 * too, except for a change the assistant made through the MCP bearer: that
 * commit is authored by {@link ASSISTANT_AUTHOR}, so History names who did it
 * and the owner can undo it. Operations are serialised by a
 * per-vault async mutex kept in {@link processStore} — this module is compiled
 * more than once into the one web server (see process-store.ts), and a lock
 * per module copy would be no lock at all.
 *
 * git runs through {@link runChild}: no shell, argv only, a hard timeout, and
 * an environment built here from nothing. The user's global and system git
 * config are switched off (`GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_NOSYSTEM=1`), hooks are pointed at /dev/null and signing is off,
 * so a box whose owner signs commits or runs hooks still gets plain, local
 * vault commits that never prompt.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { runChild, type ChildResult } from "@/lib/child-run";
import { processStore } from "@/lib/process-store";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import path from "@/lib/runtime-path";

/** Who a vault commit is authored by. The committer is always {@link VAULT_AUTHOR}. */
export interface VaultAuthor {
  readonly name: string;
  readonly email: string;
}

export const VAULT_AUTHOR: VaultAuthor = Object.freeze({ name: "Prime Radiant", email: "prime-radiant@localhost" });
/** The author of every change the assistant makes through the box's MCP server. */
export const ASSISTANT_AUTHOR: VaultAuthor = Object.freeze({ name: "ClawBox assistant", email: "assistant@localhost" });
export const VAULT_MAIN_BRANCH = "main";

const GIT_TIMEOUT_MS = 30_000;

export class VaultGitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly result: ChildResult,
  ) {
    super(message);
    this.name = "VaultGitError";
  }
}

export function gitEnv(author: VaultAuthor = VAULT_AUTHOR): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: VAULT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: VAULT_AUTHOR.email,
  };
}

const FIXED_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "core.quotepath=false",
  "-c", "core.autocrlf=false",
  "-c", `user.name=${VAULT_AUTHOR.name}`,
  "-c", `user.email=${VAULT_AUTHOR.email}`,
];

export interface GitOptions {
  input?: string;
  timeoutMs?: number;
  /** Return a failed result instead of throwing. */
  allowFail?: boolean;
  /** The author a commit made by this call records. Default {@link VAULT_AUTHOR}. */
  author?: VaultAuthor;
}

/** Run git in the vault. Throws {@link VaultGitError} on a non-zero exit unless `allowFail`. */
export async function git(vault: string, args: readonly string[], opts: GitOptions = {}): Promise<ChildResult> {
  const result = await runChild("git", [...FIXED_CONFIG, "-C", vault, ...args], {
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    env: gitEnv(opts.author),
    input: opts.input,
    notStarted: "git is not installed",
  });
  if (result.code !== 0 && !opts.allowFail) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    throw new VaultGitError(`git ${args[0]} failed: ${detail || `exit ${result.code}`}`, args, result);
  }
  return result;
}

/** Run `fn` with the vault's lock held. One operation per vault at a time, in arrival order. */
export function withVaultLock<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const locks = processStore("prime-radiant:vault-locks", () => new Map<string, SerialLock>());
  const key = path.resolve(vault);
  let lock = locks.get(key);
  if (!lock) {
    lock = createSerialLock();
    locks.set(key, lock);
  }
  return lock(fn);
}

export async function isGitRepo(vault: string): Promise<boolean> {
  const r = await git(vault, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (r.code !== 0 || r.stdout.trim() !== "true") return false;
  // The vault must be the repository's ROOT, not a folder inside someone else's.
  // git answers the canonical path, so both sides are compared after realpath
  // (a vault reached through a symlinked folder is still its own root).
  const top = await git(vault, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) return false;
  try {
    return (await fs.realpath(top.stdout.trim())) === (await fs.realpath(vault));
  } catch {
    return false;
  }
}

export async function hasCommits(vault: string): Promise<boolean> {
  const r = await git(vault, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true });
  return r.code === 0;
}

/** `git init` with `main` as the first branch (works on git older than 2.28 too). */
export async function initRepo(vault: string): Promise<void> {
  await git(vault, ["init", "--quiet"]);
  await git(vault, ["symbolic-ref", "HEAD", `refs/heads/${VAULT_MAIN_BRANCH}`]);
}

export interface CommitInfo {
  sha: string;
  subject: string;
  /** ISO 8601 committer date. */
  at: string;
  author: string;
  /**
   * Who the verification this commit made names (its `Verified-by` /
   * `Verified-via` trailers, verify.ts): `{ by: "owner", via: "assistant" }`
   * when the assistant verified on the owner's word. Absent on every other commit.
   */
  verified?: { by: string; via?: string };
}

/** The trailers a verification commit carries, read back by {@link CommitInfo}'s `verified`. */
export const VERIFIED_BY_TRAILER = "Verified-by";
export const VERIFIED_VIA_TRAILER = "Verified-via";

/** `Verified-by: <by>` (and `Verified-via: <via>`) lines for a commit's trailer block. */
export function verifiedTrailers(stamp: { by: string; via?: string }): string[] {
  const clean = (v: string) => v.replace(/[\r\n:]+/g, " ").trim().slice(0, 80);
  const out = [`${VERIFIED_BY_TRAILER}: ${clean(stamp.by)}`];
  if (stamp.via) out.push(`${VERIFIED_VIA_TRAILER}: ${clean(stamp.via)}`);
  return out;
}

// Trailers only (git >= 2.15), unfolded, as the last field: a commit body
// never reaches the record, only its `Key: value` lines.
const LOG_FORMAT = "%H%x1f%s%x1f%cI%x1f%an%x1f%(trailers:only,unfold)%x1e";

function trailerValue(trailers: string, key: string): string | null {
  for (const line of trailers.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === key.toLowerCase()) {
      const value = line.slice(colon + 1).trim();
      if (value !== "") return value;
    }
  }
  return null;
}

function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter((rec) => rec !== "")
    .map((rec) => {
      const [sha, subject, at, author, trailers = ""] = rec.split("\x1f");
      const info: CommitInfo = { sha, subject, at, author };
      const by = trailerValue(trailers, VERIFIED_BY_TRAILER);
      if (by) {
        const via = trailerValue(trailers, VERIFIED_VIA_TRAILER);
        info.verified = via ? { by, via } : { by };
      }
      return info;
    });
}

export async function headCommit(vault: string): Promise<CommitInfo | null> {
  const r = await git(vault, ["log", "-1", `--format=${LOG_FORMAT}`], { allowFail: true });
  if (r.code !== 0) return null;
  return parseLog(r.stdout)[0] ?? null;
}

export async function currentBranch(vault: string): Promise<string | null> {
  const r = await git(vault, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function commitCount(vault: string, ref = "HEAD"): Promise<number> {
  const r = await git(vault, ["rev-list", "--count", ref], { allowFail: true });
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.code === 0 && Number.isFinite(n) ? n : 0;
}

/** The history of one vault-relative path, newest first (follows renames). */
export async function logForPath(vault: string, rel: string, limit = 50): Promise<CommitInfo[]> {
  const r = await git(vault, ["log", `-${Math.max(1, Math.min(limit, 1000))}`, "--follow", `--format=${LOG_FORMAT}`, "--", rel], {
    allowFail: true,
  });
  return r.code === 0 ? parseLog(r.stdout) : [];
}

/** A file's contents at `ref`, or null when it does not exist there. */
export async function showFileAt(vault: string, ref: string, rel: string): Promise<string | null> {
  const r = await git(vault, ["show", `${ref}:${rel}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/** Paths that differ between `base` and `head` (three-dot: since they diverged). */
export async function changedPaths(vault: string, base: string, head: string): Promise<string[]> {
  const r = await git(vault, ["diff", "--name-only", "-z", `${base}...${head}`]);
  return r.stdout.split("\0").filter((p) => p !== "");
}

/** Does `rel` exist in HEAD? */
export async function trackedAtHead(vault: string, rel: string): Promise<boolean> {
  const r = await git(vault, ["cat-file", "-e", `HEAD:${rel}`], { allowFail: true });
  return r.code === 0;
}

/**
 * Stage exactly `paths` (additions, edits and deletions) and commit them as
 * one commit. Returns the new sha, or null when nothing in `paths` changed —
 * an operation that changed nothing records nothing. Callers hold the lock.
 * `author` names who made the change (default {@link VAULT_AUTHOR});
 * `trailers` (`Key: value` lines, e.g. {@link verifiedTrailers}) close the
 * message as its trailer block.
 */
export async function commitPaths(
  vault: string,
  message: string,
  paths: readonly string[],
  author: VaultAuthor = VAULT_AUTHOR,
  trailers: readonly string[] = [],
): Promise<string | null> {
  const subject = message.replace(/[\r\n]+/g, " ").trim();
  // A trailer is one `Key: value` line; anything else would end the block.
  const block = trailers.map((t) => t.replace(/[\r\n]+/g, " ").trim()).filter((t) => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(t));
  if (subject === "") throw new Error("a vault commit needs a message");
  // A path neither on disk nor in HEAD (a remove of a page that never
  // existed, or a page written and removed again) is no change, and git
  // would refuse it as a pathspec that matches nothing.
  const live: string[] = [];
  for (const p of paths) {
    const onDisk = await fs.lstat(path.join(vault, ...p.split("/"))).then(
      () => true,
      () => false,
    );
    if (onDisk || (await trackedAtHead(vault, p))) live.push(p);
  }
  if (live.length === 0) return null;
  await git(vault, ["add", "-A", "--", ...live]);
  const staged = await git(vault, ["diff", "--cached", "--quiet", "--", ...live], { allowFail: true });
  if (staged.code === 0) return null;
  await git(vault, ["commit", "--quiet", "--no-verify", "-m", subject, ...(block.length > 0 ? ["-m", block.join("\n")] : []), "--", ...live], { author });
  const head = await headCommit(vault);
  return head?.sha ?? null;
}

/** The author email a commit records, or null when `sha` names no commit. */
export async function commitAuthorEmail(vault: string, sha: string): Promise<string | null> {
  const r = await git(vault, ["log", "-1", "--format=%ae", "--end-of-options", sha], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Put `paths` back the way HEAD has them (a new file is removed). Callers hold the lock. */
export async function restorePaths(vault: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of paths) ((await trackedAtHead(vault, p)) ? tracked : untracked).push(p);
  await git(vault, ["reset", "--quiet", "--", ...paths], { allowFail: true });
  if (tracked.length > 0) await git(vault, ["checkout", "HEAD", "--", ...tracked]);
  // A path HEAD does not have was created by the operation: it goes. Paths are
  // vault-relative and were accepted by safePagePath before anything wrote them.
  for (const p of untracked) await fs.rm(path.join(vault, ...p.split("/")), { force: true });
}
