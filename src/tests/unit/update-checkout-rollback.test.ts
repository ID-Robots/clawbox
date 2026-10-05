import { describe, expect, it } from "vitest";
import {
  UPDATE_ROLLBACK_KEY,
  parseRollbackTarget,
  recordRollbackTarget,
  rollBackCheckoutAfterFailedUpdate,
  rollbackWarningMessage,
  type CheckoutState,
  type RollbackDeps,
} from "@/lib/update-checkout-rollback";

const OLD = "a6fd92f".padEnd(40, "0");
const NEW = "b776518".padEnd(40, "1");

function harness(state: CheckoutState, opts: { gitFails?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const gitCalls: string[][] = [];
  const deps: RollbackDeps = {
    readState: async () => ({ ...state }),
    git: async (args) => {
      gitCalls.push(args);
      if (opts.gitFails && args[0] === "checkout") throw new Error("checkout refused");
    },
    get: async (k) => store.get(k),
    set: async (k, v) => {
      if (v === undefined) store.delete(k);
      else store.set(k, v);
    },
    now: () => new Date("2026-10-04T20:00:00Z"),
  };
  return { deps, store, gitCalls, state };
}

describe("recordRollbackTarget", () => {
  it("records the served build's commit and branch when the checkout matches it", async () => {
    const h = harness({ buildCommit: OLD, head: OLD, branch: "main" });
    const target = await recordRollbackTarget(h.deps);
    expect(target).toEqual({ commit: OLD, branch: "main", recordedAt: "2026-10-04T20:00:00.000Z" });
    expect(parseRollbackTarget(h.store.get(UPDATE_ROLLBACK_KEY))).toEqual(target);
  });

  it("records a detached HEAD with no branch", async () => {
    const h = harness({ buildCommit: OLD, head: OLD, branch: "HEAD" });
    expect((await recordRollbackTarget(h.deps))?.branch).toBeNull();
  });

  it("records nothing (and clears a stale target) on a box that is already drifted", async () => {
    const h = harness({ buildCommit: OLD, head: NEW, branch: "main" });
    h.store.set(UPDATE_ROLLBACK_KEY, JSON.stringify({ commit: OLD, branch: "main" }));
    expect(await recordRollbackTarget(h.deps)).toBeNull();
    expect(h.store.has(UPDATE_ROLLBACK_KEY)).toBe(false);
  });

  it("records nothing for an unstamped build", async () => {
    const h = harness({ buildCommit: null, head: OLD, branch: "main" });
    expect(await recordRollbackTarget(h.deps)).toBeNull();
  });
});

describe("rollBackCheckoutAfterFailedUpdate", () => {
  async function failedRun(state: CheckoutState, opts?: { gitFails?: boolean }) {
    const h = harness({ buildCommit: OLD, head: OLD, branch: "main" }, opts);
    await recordRollbackTarget(h.deps);
    Object.assign(h.state, state);
    h.deps.readState = async () => ({ ...h.state });
    const outcome = await rollBackCheckoutAfterFailedUpdate(h.deps);
    return { ...h, outcome };
  }

  it("moves the checkout back when the rebuild failed and the old build was restored (TASK-1423)", async () => {
    const { outcome, gitCalls, store } = await failedRun({ buildCommit: OLD, head: NEW, branch: "beta" });
    expect(outcome.rolledBack).toBe(true);
    expect(gitCalls).toEqual([
      ["cat-file", "-e", `${OLD}^{commit}`],
      ["checkout", "-q", "-f", "-B", "main", OLD],
    ]);
    expect(store.has(UPDATE_ROLLBACK_KEY)).toBe(false);
    expect(rollbackWarningMessage(outcome)).toContain("moved back from b776518 to a6fd92f");
  });

  it("detaches when the run started on a detached HEAD", async () => {
    const h = harness({ buildCommit: OLD, head: OLD, branch: "HEAD" });
    await recordRollbackTarget(h.deps);
    h.deps.readState = async () => ({ buildCommit: OLD, head: NEW, branch: "main" });
    await rollBackCheckoutAfterFailedUpdate(h.deps);
    expect(h.gitCalls[1]).toEqual(["checkout", "-q", "-f", "--detach", OLD]);
  });

  it("leaves the checkout alone when a NEW build is in place (failure after the rebuild)", async () => {
    const { outcome, gitCalls, store } = await failedRun({ buildCommit: NEW, head: NEW, branch: "main" });
    expect(outcome).toMatchObject({ rolledBack: false, reason: "build-changed" });
    expect(gitCalls).toEqual([]);
    expect(store.has(UPDATE_ROLLBACK_KEY)).toBe(false);
    expect(rollbackWarningMessage(outcome)).toBeNull();
  });

  it("leaves the checkout alone when the build cannot identify itself", async () => {
    const { outcome, gitCalls } = await failedRun({ buildCommit: null, head: NEW, branch: "main" });
    expect(outcome).toMatchObject({ rolledBack: false, reason: "build-changed" });
    expect(gitCalls).toEqual([]);
  });

  it("does nothing when the run failed before the tree moved", async () => {
    const { outcome, gitCalls } = await failedRun({ buildCommit: OLD, head: OLD, branch: "main" });
    expect(outcome).toMatchObject({ rolledBack: false, reason: "already-aligned" });
    expect(gitCalls).toEqual([]);
  });

  it("does nothing without a recorded target", async () => {
    const h = harness({ buildCommit: OLD, head: NEW, branch: "main" });
    expect(await rollBackCheckoutAfterFailedUpdate(h.deps)).toEqual({ rolledBack: false, reason: "no-target" });
    expect(h.gitCalls).toEqual([]);
  });

  it("reports a git failure and still consumes the target", async () => {
    const { outcome, store } = await failedRun({ buildCommit: OLD, head: NEW, branch: "main" }, { gitFails: true });
    expect(outcome).toMatchObject({ rolledBack: false, reason: "git-failed", error: "checkout refused" });
    expect(store.has(UPDATE_ROLLBACK_KEY)).toBe(false);
    expect(rollbackWarningMessage(outcome)).toContain("could not be moved back");
  });
});

describe("parseRollbackTarget", () => {
  it("rejects malformed values and unsafe branch names", () => {
    expect(parseRollbackTarget(undefined)).toBeNull();
    expect(parseRollbackTarget("not json")).toBeNull();
    expect(parseRollbackTarget({ commit: "abc" })).toBeNull();
    expect(parseRollbackTarget({ commit: "g".repeat(40) })).toBeNull();
    expect(parseRollbackTarget({ commit: OLD, branch: "--upload-pack=x" })?.branch).toBeNull();
    expect(parseRollbackTarget({ commit: OLD, branch: "a..b" })?.branch).toBeNull();
    expect(parseRollbackTarget({ commit: OLD, branch: "release/v4.2.0" })?.branch).toBe("release/v4.2.0");
  });
});
