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
 * change: a revert that would bring a retired claim id back is refused by
 * `claim-id-retired-reuse`. Undo is the owner's; the assistant may undo only a
 * commit it authored itself (`onlyAuthoredBy`).
 *
 * A VERIFICATION is never undone — not whole, not one page of it, not by the
 * owner and not by the assistant (`lint_blocked`, finding
 * {@link VERIFICATION_UNDO_RULE}). A verification (a `verify:` commit: a
 * settled review question, a fact verified in the app or through the
 * assistant) retires the losing answers for good, often on other pages; undoing
 * only the verified page would put the losing answer back and leave the right
 * one retired, with the question never raised again. So a commit is judged by
 * everything it did, also when only one page of it is to be undone: its
 * `verify:` subject says it verified ({@link isVerificationCommit}), or its
 * pages say so — an id a page lists as retired that none did before, an
 * id a page that is still there no longer lists, a verification stamp it set.
 * History marks such a commit (`CommitInfo.noUndo`) and offers no Undo on it.
 *
 * Commit ids reach git only rebuilt from the hex alphabet; page paths only
 * through `safePagePath`.
 *
 * SERVER ONLY.
 */

import { parsePage } from "./frontmatter";
import { commitAuthorEmail, commitInfo, commitPaths, git, logForPath, showFileAt, withVaultLock, type CommitInfo, type VaultAuthor } from "./git";
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

/** The rule a refused undo of a verification names in its findings (the route's `findings`, History's own wording). */
export const VERIFICATION_UNDO_RULE = "verification-undo";

/** A finding a refused revert carries: the lint's, or {@link VERIFICATION_UNDO_RULE}. */
export type RevertFinding = Omit<LintFinding, "rule"> & { rule: LintFinding["rule"] | typeof VERIFICATION_UNDO_RULE };

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
    readonly findings: RevertFinding[] = [],
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

/**
 * Whether a commit's record says it verified: a `verify:` commit (verify.ts —
 * a settled review question, a fact verified in the app or through the
 * assistant). Such a commit is never undone. The one-off migration that
 * re-stamps who verified (`migrate:`, verify.ts) carries a `Verified-by`
 * trailer too, but keeps each verification's moment, verifies nothing anew and
 * retires nothing: it stays undoable.
 */
export function isVerificationCommit(info: Pick<CommitInfo, "subject">): boolean {
  return info.subject.trimStart().startsWith("verify:");
}

/** Each listed commit, with `noUndo` on the ones Undo refuses whatever the vault is like. */
function markNoUndo(commits: CommitInfo[]): CommitInfo[] {
  return commits.map((c) => (isVerificationCommit(c) ? { ...c, noUndo: "verification" as const } : c));
}

export async function pageHistory(rel: string, limit = 50, vault: string = vaultDir()): Promise<{ path: string; commits: CommitInfo[] } | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe) || !(await vaultInitialised(vault))) return null;
  const commits = await logForPath(vault, safe, Math.max(1, Math.min(limit, MAX_HISTORY)));
  return { path: safe, commits: markNoUndo(commits) };
}

/**
 * What one commit did to the vault's verifications and retirements, over EVERY
 * page it touched; only a page there before and after counts as changed.
 */
export interface VerificationEffect {
  /** Ids a page lists as retired after the commit that no page it touched listed before. */
  retired: string[];
  /** Ids a page stopped listing as retired that no page it touched lists after. */
  unretired: string[];
  /** Claims carrying a verification stamp the commit set: one no page it touched carried before (by id and moment). */
  verified: string[];
  /** The pages any of that is on. */
  pages: string[];
}

const EFFECT_READS_IN_FLIGHT = 8;

/**
 * {@link VerificationEffect} of commit `sha` against `parent`, from the pages
 * as the two commits hold them. Renames are read as a removal and an addition,
 * so a page that moved (or pages merged into one) carry their retirements and
 * stamps across and count as no change; so does a page restored by an undo.
 */
export async function verificationEffect(vault: string, parent: string, sha: string): Promise<VerificationEffect> {
  const touched = (await git(vault, ["diff", "--name-only", "-z", "--no-renames", parent, sha])).stdout
    .split("\0")
    .filter((p) => p !== "" && isKnowledgePage(p));
  type Side = { exists: boolean; retired: string[]; stamps: Array<{ id: string; at: string }> };
  const read = async (ref: string, p: string): Promise<Side> => {
    const text = await showFileAt(vault, ref, p);
    if (text === null) return { exists: false, retired: [], stamps: [] };
    const parsed = parsePage(text);
    if (!parsed.ok) return { exists: true, retired: [], stamps: [] };
    const fm = parsed.frontmatter;
    return { exists: true, retired: fm.retiredClaimIds, stamps: fm.claims.flatMap((c) => (c.verified ? [{ id: c.id, at: c.verified.at }] : [])) };
  };
  const sides: Array<{ path: string; before: Side; after: Side }> = [];
  for (let i = 0; i < touched.length; i += EFFECT_READS_IN_FLIGHT) {
    const batch = touched.slice(i, i + EFFECT_READS_IN_FLIGHT);
    sides.push(...(await Promise.all(batch.map(async (p) => ({ path: p, before: await read(parent, p), after: await read(sha, p) })))));
  }
  const retiredBefore = new Set(sides.flatMap((s) => s.before.retired));
  const retiredAfter = new Set(sides.flatMap((s) => s.after.retired));
  const stampsBefore = new Set(sides.flatMap((s) => s.before.stamps.map((st) => `${st.id}\n${st.at}`)));
  const retired = new Set<string>();
  const unretired = new Set<string>();
  const verified = new Set<string>();
  const pages = new Set<string>();
  for (const s of sides) {
    // A verification changes pages that are there (verify.ts writes no new page); a page that
    // came or went is a page restored, moved or removed — its retirements stay in the ledger.
    if (!s.before.exists || !s.after.exists) continue;
    for (const id of s.after.retired) {
      if (!retiredBefore.has(id)) {
        retired.add(id);
        pages.add(s.path);
      }
    }
    for (const id of s.before.retired) {
      if (!retiredAfter.has(id)) {
        unretired.add(id);
        pages.add(s.path);
      }
    }
    for (const st of s.after.stamps) {
      if (!stampsBefore.has(`${st.id}\n${st.at}`)) {
        verified.add(st.id);
        pages.add(s.path);
      }
    }
  }
  return { retired: [...retired].sort(), unretired: [...unretired].sort(), verified: [...verified].sort(), pages: [...pages].sort() };
}

const VERIFICATION_UNDO_MESSAGE =
  "That change verified a fact, and a verification is never undone: the answers it replaced stay retired for good, " +
  "so undoing it would leave the wiki without the right answer. To change the fact, verify the right answer instead.";

/**
 * The refusal for undoing commit `sha` (whole or one page of it — it is judged
 * whole either way) when it verified or retired anything, else null.
 */
async function verificationRefusal(vault: string, sha: string, parent: string): Promise<HistoryError | null> {
  const info = await commitInfo(vault, sha);
  const effect = await verificationEffect(vault, parent, sha);
  const said = !!info && isVerificationCommit(info);
  if (!said && effect.retired.length === 0 && effect.unretired.length === 0 && effect.verified.length === 0) return null;
  let pages = effect.pages;
  if (pages.length === 0) {
    const names = await git(vault, ["diff", "--name-only", "-z", "--no-renames", parent, sha]);
    pages = names.stdout.split("\0").filter((p) => p !== "" && isKnowledgePage(p));
  }
  const findings: RevertFinding[] = (pages.length > 0 ? pages : [""]).slice(0, 20).map((p) => ({
    rule: VERIFICATION_UNDO_RULE,
    severity: "error",
    path: p,
    message: "This commit verified a fact or retired an answer; that is never undone.",
    blocksCommit: true,
    details: { retired: effect.retired.length, unretired: effect.unretired.length, verified: effect.verified.length },
  }));
  return new HistoryError("lint_blocked", VERIFICATION_UNDO_MESSAGE, 409, findings);
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
    // Before who may undo it: nobody may, and the assistant should hear that rather than "ask the owner".
    // Judged by the WHOLE commit also when one page is asked for: undoing only the verified page would
    // leave the answers it replaced retired on the other pages, and the right value gone for good.
    const verification = await verificationRefusal(vault, sha, parent);
    if (verification) throw verification;
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
      const reset = await git(vault, ["reset", "--quiet", "--hard", "HEAD"], { allowFail: true });
      // Answer what git said, not a generic "could not be read" — and say so when putting the vault back failed too.
      const detail = (err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, "");
      const recovery =
        reset.code === 0
          ? " The vault is as it was."
          : ` Putting the vault back failed too (${(reset.stderr || reset.stdout).trim().split("\n").slice(-1)[0] || `exit ${reset.code}`}); it may still hold the undo's uncommitted changes.`;
      throw new HistoryError("commit_failed", `The undo could not be committed: ${detail}.${recovery}`, 500);
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
