/**
 * A page's history, a commit's diff, and the owner's undo.
 *
 * History is `git log --follow` over one page. A diff is one commit's change
 * (against its first parent), optionally narrowed to one page, or the change
 * between two commits. Revert undoes one commit's change — the whole commit
 * or one page of it — as ONE new commit (`revert: <sha> <subject>`), by
 * applying the commit's own patch in reverse: when a later commit changed the
 * same lines the patch no longer applies and the revert is refused
 * (`conflict`) rather than guessed at. The result is linted like every other
 * change: a revert that would bring a retired claim id back (undoing a
 * verification) is refused by `claim-id-retired-reuse`. Undo is the owner's;
 * the assistant may undo only a commit it authored itself (`onlyAuthoredBy`).
 *
 * Commit ids reach git only rebuilt from the hex alphabet; page paths only
 * through `safePagePath`.
 *
 * SERVER ONLY.
 */

import { commitAuthorEmail, commitPaths, git, logForPath, withVaultLock, type CommitInfo, type VaultAuthor } from "./git";
import { restorePluginOnlyEdits } from "./plugin-repair";
import { lintSecretsInText, lintVault, type LintFinding } from "./lint";
import { isKnowledgePage, safePagePath, vaultDir } from "./paths";
import { notifyVaultChanged } from "./reindex-hook";
import { readRetiredLedger, recordRetired } from "./state-db";
import { INDEX_FILE, readPage, readVaultSnapshot, vaultInitialised } from "./vault";

/** The most a diff answer carries; the rest is cut and said to be. */
export const MAX_DIFF_CHARS = 256 * 1024;
export const MAX_HISTORY = 200;

const HEX = "0123456789abcdef";

/** A caller's commit id rebuilt from the hex alphabet (7 to 40 characters), or null. */
export function safeCommitId(input: unknown): string | null {
  if (typeof input !== "string" || input.length < 7 || input.length > 40) return null;
  let out = "";
  for (const ch of input.toLowerCase()) {
    const at = HEX.indexOf(ch);
    if (at < 0) return null;
    out += HEX[at];
  }
  return out;
}

export class HistoryError extends Error {
  constructor(
    readonly code:
      | "not_initialised"
      | "not_found"
      | "invalid"
      | "conflict"
      | "lint_blocked"
      | "nothing_to_revert"
      | "dirty"
      | "owner_only"
      | "commit_failed",
    message: string,
    readonly status: number,
    readonly findings: LintFinding[] = [],
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

/** The full sha of `ref` when it names a commit in the vault, else null. */
async function resolveCommit(vault: string, ref: string): Promise<string | null> {
  const r = await git(vault, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function pageHistory(rel: string, limit = 50, vault: string = vaultDir()): Promise<{ path: string; commits: CommitInfo[] } | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe) || !(await vaultInitialised(vault))) return null;
  const commits = await logForPath(vault, safe, Math.max(1, Math.min(limit, MAX_HISTORY)));
  return { path: safe, commits };
}

export interface DiffResult {
  from: string | null;
  to: string;
  path: string | null;
  commit: CommitInfo | null;
  files: string[];
  diff: string;
  truncated: boolean;
}

function parseOneLog(stdout: string): CommitInfo | null {
  const [sha, subject, at, author] = stdout.trim().split("\x1f");
  return sha ? { sha, subject, at, author } : null;
}

/**
 * The diff of commit `to` against its first parent (`from` absent), or of
 * `from`..`to`, optionally for one page.
 */
export async function vaultDiff(
  input: { to: string; from?: string | null; path?: string | null },
  vault: string = vaultDir(),
): Promise<DiffResult> {
  if (!(await vaultInitialised(vault))) throw new HistoryError("not_initialised", "The vault has not been created yet.", 404);
  const toId = safeCommitId(input.to);
  const fromId = input.from == null ? null : safeCommitId(input.from);
  if (!toId || (input.from != null && !fromId)) throw new HistoryError("invalid", "A commit id is 7 to 40 hex characters.", 400);
  let page: string | null = null;
  if (input.path != null) {
    page = safePagePath(input.path);
    if (!page) throw new HistoryError("invalid", "That is not a page path.", 400);
  }
  const to = await resolveCommit(vault, toId);
  if (!to) throw new HistoryError("not_found", "No such commit in the vault.", 404);
  let from: string | null = null;
  if (fromId) {
    from = await resolveCommit(vault, fromId);
    if (!from) throw new HistoryError("not_found", "No such commit in the vault.", 404);
  } else {
    from = await resolveCommit(vault, `${to}^1`);
  }
  const range = from ? [from, to] : ["--root", to];
  const pathArgs = page ? ["--", page] : [];
  const cmd = from ? ["diff", "--no-color", "--no-ext-diff", ...range, ...pathArgs] : ["show", "--no-color", "--no-ext-diff", "--format=", to, ...pathArgs];
  const names = from
    ? await git(vault, ["diff", "--name-only", "-z", ...range, ...pathArgs])
    : await git(vault, ["show", "--name-only", "-z", "--format=", to, ...pathArgs]);
  const out = await git(vault, cmd, { timeoutMs: 60_000 });
  const info = await git(vault, ["log", "-1", "--format=%H%x1f%s%x1f%cI%x1f%an", to]);
  const truncated = out.stdout.length > MAX_DIFF_CHARS;
  return {
    from,
    to,
    path: page,
    commit: parseOneLog(info.stdout),
    files: names.stdout.split("\0").filter((p) => p !== ""),
    diff: truncated ? out.stdout.slice(0, MAX_DIFF_CHARS) : out.stdout,
    truncated,
  };
}

export interface RevertResult {
  reverted: string;
  commit: string | null;
  changed: string[];
  findings: LintFinding[];
}

export interface RevertOptions {
  /** Who the revert commit names as its author. Default Prime Radiant. */
  author?: VaultAuthor;
  /**
   * Undo only a commit this author made, else refuse `owner_only`: the
   * assistant may take back its own change, never the owner's or a pass's.
   */
  onlyAuthoredBy?: VaultAuthor;
}

/**
 * Undo commit `sha` (or only its change to `path`) as one new commit. Holds
 * the vault's lock for the whole of it.
 */
export async function revertCommit(
  input: { sha: string; path?: string | null },
  vault: string = vaultDir(),
  options: RevertOptions = {},
): Promise<RevertResult> {
  if (!(await vaultInitialised(vault))) throw new HistoryError("not_initialised", "The vault has not been created yet.", 404);
  const id = safeCommitId(input.sha);
  if (!id) throw new HistoryError("invalid", "A commit id is 7 to 40 hex characters.", 400);
  let page: string | null = null;
  if (input.path != null) {
    page = safePagePath(input.path);
    if (!page) throw new HistoryError("invalid", "That is not a page path.", 400);
  }
  const result = await withVaultLock(vault, async () => {
    const sha = await resolveCommit(vault, id);
    if (!sha) throw new HistoryError("not_found", "No such commit in the vault.", 404);
    const parent = await resolveCommit(vault, `${sha}^1`);
    if (!parent) throw new HistoryError("invalid", "The first commit of the vault cannot be reverted.", 400);
    if (options.onlyAuthoredBy && (await commitAuthorEmail(vault, sha)) !== options.onlyAuthoredBy.email) {
      throw new HistoryError("owner_only", "Only the owner can undo a change the assistant did not make.", 403);
    }
    // A block memory-wiki wrote into a page since is no change of the owner's to protect.
    await restorePluginOnlyEdits(vault);
    const status = await git(vault, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.stdout.trim() !== "") throw new HistoryError("dirty", "The vault has uncommitted changes; try again in a moment.", 409);
    const pathArgs = page ? ["--", page] : [];
    const patch = await git(vault, ["diff", "--binary", "--no-color", "--no-ext-diff", parent, sha, ...pathArgs], { timeoutMs: 60_000 });
    if (patch.stdout.trim() === "") throw new HistoryError("nothing_to_revert", "That commit changed nothing there.", 409);
    const applied = await git(vault, ["apply", "-R", "--index", "--whitespace=nowarn", "-"], { input: `${patch.stdout}\n`, allowFail: true }); // runChild trims the newline git apply needs
    if (applied.code !== 0) {
      await git(vault, ["reset", "--quiet", "--hard", "HEAD"], { allowFail: true });
      throw new HistoryError("conflict", "A later change touched the same lines; that commit can no longer be undone on its own.", 409);
    }
    const staged = (await git(vault, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter((p) => p !== "");
    // The same blocking rules as every vault operation.
    const snapshot = await readVaultSnapshot(vault);
    let ledger: string[] = [];
    try {
      ledger = readRetiredLedger(vault);
    } catch {
      ledger = [];
    }
    const scope = staged.filter(isKnowledgePage);
    const report = lintVault(snapshot, { scope, ledgerRetired: ledger });
    if (staged.includes(INDEX_FILE) && snapshot.indexBody !== null) report.findings.push(...lintSecretsInText(INDEX_FILE, snapshot.indexBody));
    const blocking = report.findings.filter((f) => f.blocksCommit);
    if (blocking.length > 0) {
      await git(vault, ["reset", "--quiet", "--hard", "HEAD"], { allowFail: true });
      throw new HistoryError("lint_blocked", "Undoing that commit would break the vault's rules.", 409, blocking);
    }
    const subject = (await git(vault, ["log", "-1", "--format=%s", sha])).stdout.trim().slice(0, 120);
    let commit: string | null;
    try {
      commit = await commitPaths(vault, `revert: ${sha.slice(0, 12)} ${subject}`, staged, options.author);
    } catch (err) {
      await git(vault, ["reset", "--quiet", "--hard", "HEAD"], { allowFail: true });
      // Answer what git said, not a generic "could not be read".
      const detail = err instanceof Error ? err.message : String(err);
      throw new HistoryError("commit_failed", `The undo could not be committed: ${detail}`, 500);
    }
    // Retirements the reverted pages list are the ledger's too.
    const retired: Array<{ id: string; page: string }> = [];
    for (const p of scope) {
      const read = await readPage(p, vault);
      if (read?.parsed.ok) for (const rid of read.parsed.frontmatter.retiredClaimIds) retired.push({ id: rid, page: p });
    }
    try {
      recordRetired(vault, retired);
    } catch {
      /* the pages carry them */
    }
    return { reverted: sha, commit, changed: staged, findings: report.findings };
  });
  await notifyVaultChanged(result.changed);
  return result;
}
