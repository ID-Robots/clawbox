/**
 * The auto-PR guardrails.
 *
 * These are the decisions that end with an agent merging its own code, so the
 * cases pinned here are the ones where a plausible implementation merges
 * something it should not have.
 */
import { describe, expect, it } from "vitest";
import {
  decideMerge,
  emptyChecks,
  foldChecks,
  isPrPending,
  runBranchName,
  MAX_WAIT_MS,
  NO_CHECKS_GRACE_MS,
  type PrSnapshot,
} from "@/lib/coding-pr-state";

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  noChecks: false,
  ...over,
});

describe("foldChecks", () => {
  it("reads a null rollup as no checks, not as an empty pass", () => {
    // gh answers `null` — not [] — when a PR has no checks at all.
    expect(foldChecks(null)).toEqual(emptyChecks());
    expect(foldChecks(undefined)).toEqual(emptyChecks());
  });

  it("counts a CheckRun that has not COMPLETED as pending, whatever its conclusion says", () => {
    expect(foldChecks([{ status: "IN_PROGRESS", conclusion: "SUCCESS" }])).toEqual(
      { total: 1, passed: 0, failed: 0, pending: 1 },
    );
    expect(foldChecks([{ status: "QUEUED", conclusion: null }])).toEqual(
      { total: 1, passed: 0, failed: 0, pending: 1 },
    );
  });

  it("folds both node shapes — CheckRun conclusion and StatusContext state", () => {
    expect(foldChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { state: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { state: "PENDING" },
    ])).toEqual({ total: 5, passed: 3, failed: 1, pending: 1 });
  });
});

describe("decideMerge", () => {
  it("NEVER merges a pull request with no checks — vacuous green is the trap", () => {
    // A repo with no workflows, or with Actions disabled, satisfies "every
    // check passed" trivially. Merging on that would merge everything on sight.
    const verdict = decideMerge({
      snapshot: snap({ checks: emptyChecks(), noChecks: true }),
      waitedMs: NO_CHECKS_GRACE_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("No checks ran");
  });

  it("waits through the grace period before calling an empty rollup 'no checks'", () => {
    // GitHub attaches check runs seconds after the PR opens, so the first poll
    // routinely sees nothing. Reading that as 'no CI' would merge instantly.
    expect(decideMerge({
      snapshot: snap({ checks: emptyChecks(), noChecks: true }),
      waitedMs: 5_000,
      reviewOk: true,
    })).toEqual({ action: "wait" });
  });

  it("waits while any check is pending", () => {
    expect(decideMerge({
      snapshot: snap({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      waitedMs: 30_000,
      reviewOk: true,
    })).toEqual({ action: "wait" });
  });

  it("blocks on a single failed check and says how many", () => {
    const verdict = decideMerge({
      snapshot: snap({ checks: { total: 3, passed: 2, failed: 1, pending: 0 } }),
      waitedMs: 30_000,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("1 of 3 checks failed");
  });

  it("merges only when a real check passed and nothing is outstanding", () => {
    expect(decideMerge({ snapshot: snap(), waitedMs: 30_000, reviewOk: true })).toEqual({ action: "merge" });
  });

  it("does not merge when the review pass was not clean", () => {
    const verdict = decideMerge({ snapshot: snap(), waitedMs: 30_000, reviewOk: false });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("review pass");
  });

  it("treats mergeable as the string enum it is, not a boolean", () => {
    // CONFLICTING is a definite no; UNKNOWN is GitHub still computing it.
    expect(decideMerge({ snapshot: snap({ mergeable: "CONFLICTING" }), waitedMs: 30_000, reviewOk: true }).action).toBe("block");
    expect(decideMerge({ snapshot: snap({ mergeable: "UNKNOWN" }), waitedMs: 30_000, reviewOk: true })).toEqual({ action: "wait" });
  });

  it("gives up rather than waiting forever", () => {
    const verdict = decideMerge({
      snapshot: snap({ mergeable: "UNKNOWN", checks: { total: 1, passed: 1, failed: 0, pending: 0 } }),
      waitedMs: MAX_WAIT_MS + 1,
      reviewOk: true,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as { detail: string }).detail).toContain("Gave up waiting");
  });

  it("does not re-merge a merged or closed pull request", () => {
    expect(decideMerge({ snapshot: snap({ state: "MERGED" }), waitedMs: 1, reviewOk: true }).action).toBe("block");
    expect(decideMerge({ snapshot: snap({ state: "CLOSED" }), waitedMs: 1, reviewOk: true }).action).toBe("block");
  });
});

describe("run branches", () => {
  it("names one branch per run so two runs cannot collide", () => {
    expect(runBranchName("run-abc123")).toBe("clawbox/run-abc123");
    expect(runBranchName("run-abc123")).not.toBe(runBranchName("run-def456"));
  });

  it("knows which PRs are still being watched", () => {
    const base = { number: 1, url: "u", branch: "b", base: "main", checks: emptyChecks(), detail: null, startedAt: 0, endedAt: null };
    expect(isPrPending({ ...base, phase: "waiting" })).toBe(true);
    expect(isPrPending({ ...base, phase: "opening" })).toBe(true);
    expect(isPrPending({ ...base, phase: "merged" })).toBe(false);
    expect(isPrPending({ ...base, phase: "blocked" })).toBe(false);
    expect(isPrPending(null)).toBe(false);
  });
});
