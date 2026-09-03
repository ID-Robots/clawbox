import { describe, expect, it } from "vitest";
import { PROBE_GRACE_MS } from "@/lib/hermes-model-options";
import { checkingRetryBudgetMs, CHECKING_RETRY_ATTEMPTS } from "@/hooks/useProviderStatus";
import { degradedRetryDelayMs } from "@/hooks/useHermesModelOptions";

/**
 * TASK-663 — the one relationship between the client and the server that two
 * comments agreeing is not enough to keep true.
 *
 * `/setup-api/providers/status` reports a row as `checking` while an answer
 * from the harness is still owed. Nothing emits a signal when a harness
 * finishes booting, so the panel re-asks on its own — and that polling is
 * bounded, because a panel that polls a dead box for ever is its own bug.
 *
 * If the client's budget runs out BEFORE the server's window closes, the last
 * poll is answered "still checking" by a window that is about to close and the
 * panel settles for good on a spinner: strictly worse than the "Unknown" it
 * replaced, because that at least came with a banner. The margin has to be
 * real, and it has to survive someone tuning either constant.
 */
describe("the self-polling budget outlasts the server's checking window", () => {
  it("keeps asking past the point the server stops saying checking", () => {
    expect(checkingRetryBudgetMs()).toBeGreaterThan(PROBE_GRACE_MS);
  });

  it("leaves room for a poll to land after the window rather than exactly on it", () => {
    // One full retry step of slack: a poll scheduled at the boundary must not
    // be the one the answer depends on.
    expect(checkingRetryBudgetMs() - PROBE_GRACE_MS)
      .toBeGreaterThanOrEqual(degradedRetryDelayMs(CHECKING_RETRY_ATTEMPTS - 1));
  });
});
