/**
 * Keep the checkout and the served build together when an update fails
 * (TASK-1423).
 *
 * The full update moves the tree in step 1 (`bootstrap_updater` hard-resets it
 * to the target) and only rebuilds near the end. When the rebuild is killed
 * (an OOM kill, a power cut, a SIGKILL) `do_rebuild` restores the previous
 * build — but the checkout stays on the NEW commit. The box then serves a
 * build made from one commit over code from another: verify-build-identity
 * reports drift, and the next root step runs scripts that do not match the
 * dashboard calling them. `scripts/force-update.sh` already rolls the checkout
 * back on a failed build; this is the same rule for the in-app updater.
 *
 * Before step 1 the updater records the commit the served build was made from
 * (only when the checkout IS that commit — a box that arrived drifted has no
 * clean state to return to). When the run fails, and the served build is
 * still that recorded commit while HEAD has moved, the checkout is put back.
 * When a new build is in place (the failure came after the rebuild) nothing
 * moves: build and checkout already agree.
 *
 * Dependencies are injected so the decision logic is testable without git.
 */

export const UPDATE_ROLLBACK_KEY = "update_rollback_target";

export interface RollbackTarget {
  /** The commit the served build was made from, and the checkout's HEAD, when the run started. */
  commit: string;
  /** The branch checked out then, or null for a detached HEAD. */
  branch: string | null;
  recordedAt: string;
}

export interface CheckoutState {
  /** `commit` from the served build's build-info.json, or null if unstamped/unreadable. */
  buildCommit: string | null;
  /** `git rev-parse HEAD`, or null. */
  head: string | null;
  /** `git rev-parse --abbrev-ref HEAD` ("HEAD" when detached), or null. */
  branch: string | null;
}

export interface RollbackDeps {
  readState(): Promise<CheckoutState>;
  /** Run git in the project; rejects on a non-zero exit. */
  git(args: string[]): Promise<void>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  now?(): Date;
}

export type RollbackOutcome =
  | { rolledBack: true; target: RollbackTarget; from: string | null }
  | { rolledBack: false; reason: string; target?: RollbackTarget; error?: string };

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

function safeBranch(value: unknown): string | null {
  if (typeof value !== "string" || value === "HEAD" || !BRANCH_RE.test(value)) return null;
  return value;
}

export function parseRollbackTarget(raw: unknown): RollbackTarget | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isSha(v.commit)) return null;
  return {
    commit: v.commit,
    branch: safeBranch(v.branch),
    recordedAt: typeof v.recordedAt === "string" ? v.recordedAt : "",
  };
}

/**
 * Record where a failed run should put the checkout back to. Called before the
 * tree moves. A box whose build and checkout already disagree gets no target
 * (and any stale one is cleared): there is no consistent state to return to.
 */
export async function recordRollbackTarget(deps: RollbackDeps): Promise<RollbackTarget | null> {
  const state = await deps.readState();
  if (!isSha(state.buildCommit) || state.head !== state.buildCommit) {
    await deps.set(UPDATE_ROLLBACK_KEY, undefined);
    return null;
  }
  const target: RollbackTarget = {
    commit: state.buildCommit,
    branch: safeBranch(state.branch),
    recordedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.set(UPDATE_ROLLBACK_KEY, JSON.stringify(target));
  return target;
}

export async function clearRollbackTarget(deps: Pick<RollbackDeps, "set">): Promise<void> {
  await deps.set(UPDATE_ROLLBACK_KEY, undefined);
}

/**
 * After a FAILED run: move the checkout back to the recorded commit when the
 * served build is still that commit and HEAD is not. The target is consumed in
 * every case, so a later run never acts on an old one.
 */
export async function rollBackCheckoutAfterFailedUpdate(deps: RollbackDeps): Promise<RollbackOutcome> {
  const target = parseRollbackTarget(await deps.get(UPDATE_ROLLBACK_KEY));
  if (!target) return { rolledBack: false, reason: "no-target" };
  try {
    const state = await deps.readState();
    if (state.buildCommit !== target.commit) {
      // A new build is in place (or the build cannot identify itself): moving
      // the checkout would CREATE drift, not repair it.
      return { rolledBack: false, reason: "build-changed", target };
    }
    if (state.head === target.commit) {
      return { rolledBack: false, reason: "already-aligned", target };
    }
    try {
      await deps.git(["cat-file", "-e", `${target.commit}^{commit}`]);
      if (target.branch) {
        await deps.git(["checkout", "-q", "-f", "-B", target.branch, target.commit]);
      } else {
        await deps.git(["checkout", "-q", "-f", "--detach", target.commit]);
      }
    } catch (err) {
      return {
        rolledBack: false,
        reason: "git-failed",
        target,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { rolledBack: true, target, from: state.head };
  } finally {
    await deps.set(UPDATE_ROLLBACK_KEY, undefined);
  }
}

export function rollbackWarningMessage(outcome: RollbackOutcome): string | null {
  if (outcome.rolledBack) {
    const to = outcome.target.commit.slice(0, 7);
    const from = outcome.from ? outcome.from.slice(0, 7) : "the new commit";
    return `The update did not finish, so the code on disk was moved back from ${from} to ${to} — the version this ClawBox is still running. Start the update again to retry.`;
  }
  if (outcome.reason === "git-failed" && outcome.target) {
    return `The update did not finish and the code on disk could not be moved back to ${outcome.target.commit.slice(0, 7)}, the version this ClawBox is still running. Start the update again to repair it.`;
  }
  return null;
}
