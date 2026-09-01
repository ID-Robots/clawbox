/**
 * The auto-PR flow's pure half: its types, its counters and its merge decision.
 *
 * Split from ./coding-pr because that module spawns `git` and `gh`, and the run
 * list in the desktop and the chat card both need `isPrPending` to know whether
 * to keep polling. Importing the subprocess module from a client component
 * pulls `child_process` into the browser bundle, which does not resolve — the
 * build fails outright. Same reason ./coding-agent-status.ts exists.
 */

/** How often the checks are re-read. */
export const POLL_INTERVAL_MS = 15_000;

/**
 * How long a PR may sit with NO checks registered before we stop waiting.
 *
 * GitHub takes seconds to attach check runs to a fresh PR, so the first poll
 * after `gh pr create` routinely sees an empty rollup. Reading that as "this
 * repo has no CI, so everything passed" is the single most dangerous mistake
 * available here — it merges unreviewed code the instant the PR opens. The
 * grace period is what separates "not yet" from "never".
 */
export const NO_CHECKS_GRACE_MS = 120_000;

/** The ceiling on one PR's whole wait, after which it is the owner's problem. */
export const MAX_WAIT_MS = 30 * 60_000;

/** Check conclusions that count as passing. NEUTRAL and SKIPPED are a check
 *  that ran and declined to fail — not a check that is still running. */
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** Conclusions that are a definite no. */
const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export type PrPhase =
  /** Branch pushed, PR being opened. */
  | "opening"
  /** PR open, waiting on checks. */
  | "waiting"
  /** Merged by us. */
  | "merged"
  /** Open, and we will not merge it — the owner decides. `detail` says why. */
  | "blocked"
  /** The flow itself broke (no remote, gh missing, push refused). */
  | "failed";

/** Every phase a stored record may carry — the allow-list the reader of
 *  coding-agent-runs.json validates against, kept beside the type so the two
 *  cannot drift apart (the same reason RUN_STATUSES lives with its type). */
export const PR_PHASES: readonly PrPhase[] = ["opening", "waiting", "merged", "blocked", "failed"];

export function isPrPhase(value: unknown): value is PrPhase {
  return typeof value === "string" && (PR_PHASES as readonly string[]).includes(value);
}

export interface PrChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface PrState {
  phase: PrPhase;
  number: number | null;
  url: string | null;
  branch: string | null;
  base: string | null;
  checks: PrChecks;
  /** Why it is blocked or failed, in words meant for the owner. */
  detail: string | null;
  /** When the wait began, so the app can show a clock and the grace period can
   *  be measured against something the record itself carries. */
  startedAt: number;
  /** When it reached a settled phase. */
  endedAt: number | null;
  /**
   * The automatic review pass's verdict, recorded when the pull request is
   * opened: false when a review was due and did not complete. True when no
   * review was due, so the checks alone decide.
   *
   * ON THE RECORD, not in the watcher's closure: the watcher is rebuilt from
   * this file after a restart, and a verdict that lived only in memory came
   * back as "passed" — a suite going green after a reboot merged work the
   * review had rejected.
   */
  reviewOk: boolean;
}

export function emptyChecks(): PrChecks {
  return { total: 0, passed: 0, failed: 0, pending: 0 };
}

/** True while this PR is still something the box is watching. */
export function isPrPending(pr: PrState | null | undefined): boolean {
  return pr != null && (pr.phase === "opening" || pr.phase === "waiting");
}

interface RollupNode { state?: string | null; conclusion?: string | null; status?: string | null }

/**
 * Fold gh's statusCheckRollup into counts.
 *
 * Two shapes in one field, which is why this is a function and not an inline
 * `.filter()`: a CheckRun carries `status` (QUEUED/IN_PROGRESS/COMPLETED) plus
 * `conclusion`, while a StatusContext carries only `state`. And the whole field
 * is `null` — not an empty array — when a PR has no checks at all.
 * Exported for its test.
 */
export function foldChecks(rollup: unknown): PrChecks {
  const nodes: RollupNode[] = Array.isArray(rollup) ? (rollup as RollupNode[]) : [];
  const checks = emptyChecks();
  for (const node of nodes) {
    checks.total += 1;
    // A CheckRun that has not COMPLETED is pending whatever `conclusion` says.
    if (node.status && node.status !== "COMPLETED") { checks.pending += 1; continue; }
    const verdict = (node.conclusion || node.state || "").toUpperCase();
    if (PASSING.has(verdict)) checks.passed += 1;
    else if (FAILING.has(verdict)) checks.failed += 1;
    else checks.pending += 1;
  }
  return checks;
}

export interface PrSnapshot {
  state: string;
  mergeable: string;
  checks: PrChecks;
  /** True when the rollup field was absent — no checks are attached AT ALL,
   *  which is different from a check that is pending. */
  noChecks: boolean;
}

/**
 * The merge decision, as a pure function of what was observed.
 *
 * The guardrails the owner asked for, each here for a measured reason:
 *  - `total >= 1`: an empty rollup is NOT a pass. A repo with no workflows, or
 *    with Actions disabled, satisfies "every check is green" vacuously, and
 *    that would merge everything on sight.
 *  - grace period: an empty rollup in the first two minutes is "not yet",
 *    because GitHub attaches check runs a few seconds after the PR opens.
 *  - `reviewOk`: when the automatic review pass is on, its verdict gates the
 *    merge as well — the check suite and the reviewer are different questions.
 *
 * Exported for its test, which is where the vacuous-green case is pinned.
 */
export function decideMerge(input: {
  snapshot: PrSnapshot;
  waitedMs: number;
  reviewOk: boolean;
}): { action: "merge" } | { action: "wait" } | { action: "block"; detail: string } {
  const { snapshot, waitedMs, reviewOk } = input;

  if (snapshot.state === "MERGED") return { action: "block", detail: "Already merged." };
  if (snapshot.state === "CLOSED") return { action: "block", detail: "The pull request was closed." };

  if (snapshot.checks.failed > 0) {
    return { action: "block", detail: `${snapshot.checks.failed} of ${snapshot.checks.total} checks failed. The branch is pushed and the pull request is open for you to look at.` };
  }
  // A review that did not pass is a definite no, so it is answered before any
  // waiting: polling a suite for half an hour to then refuse on the review
  // would have been thirty minutes of `gh` calls for an answer already known.
  if (!reviewOk) {
    return { action: "block", detail: "The automatic review pass did not finish cleanly, so this was not merged." };
  }
  if (snapshot.noChecks || snapshot.checks.total === 0) {
    if (waitedMs < NO_CHECKS_GRACE_MS) return { action: "wait" };
    return {
      action: "block",
      detail: "No checks ran on this pull request, so there is nothing to go green. It is open and waiting for you — add a workflow under .github/workflows to have runs merge themselves.",
    };
  }
  // The ceiling comes BEFORE the pending branch: a check that never completes
  // (a stuck runner, a conclusion gh spells in a way foldChecks does not know)
  // answers "pending" on every poll, and tested the other way round it was
  // waited on forever.
  if (waitedMs >= MAX_WAIT_MS) {
    return { action: "block", detail: "Gave up waiting for GitHub Actions. The pull request is open." };
  }
  if (snapshot.checks.pending > 0) return { action: "wait" };
  if (snapshot.mergeable === "CONFLICTING") {
    return { action: "block", detail: "The pull request conflicts with its base branch." };
  }
  if (snapshot.mergeable !== "MERGEABLE") return { action: "wait" };
  return { action: "merge" };
}


/** The branch a run's work goes on. One per run, so two runs never collide. */
export function runBranchName(runId: string): string {
  return `clawbox/${runId}`;
}
