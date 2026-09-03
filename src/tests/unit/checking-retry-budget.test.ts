import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { MAX_CHECKING_WINDOW_MS, UNIT_START_BUDGET_MS } from "@/lib/hermes-model-options";
import { DEGRADED_RETRY_MAX_MS, degradedRetryDelayMs } from "@/lib/degraded-retry";

/**
 * TASK-663 — the contract between the server's `checking` window and the
 * panel that waits on it, which no single module can keep on its own.
 *
 * `/setup-api/providers/status` reports a row as `checking` while an answer
 * from the harness is still owed, and the panel re-asks on its own because
 * nothing emits a signal when a harness finishes booting. Two things have to be
 * true for that to end in an honest answer rather than a spinner:
 *
 *   1. the server's window is BOUNDED — in every branch, including the one
 *      systemd answers, since `activating` is a fact about the unit and not a
 *      promise that anything will arrive;
 *   2. the client keeps polling until it closes, which means bounded in RATE
 *      and not in COUNT. A fixed number of polls was the first attempt and it
 *      was the bug: the budget ran out mid-window, the last poll was answered
 *      "still checking", and the panel held spinner rows with no banner for the
 *      life of the mount.
 *
 * (1) is driven through `probeStillOwed` itself in
 * `hermes-model-options-probe-owed.test.ts`, one case per branch plus the
 * `starting -> running` hand-over; what is pinned HERE is the one number in it
 * that must not be invented — the start budget, which belongs to the shipped
 * unit file. (2)'s behaviour is pinned in `ai-provider-list.test.tsx`, which can
 * watch a real panel poll; what is pinned here is that the rate it settles at is
 * finite and shorter than the window it has to cover.
 */
describe("the checking window is bounded, and the panel outlives it", () => {
  it("takes the systemd branch's budget from the unit's own start timeout", () => {
    // The one number that must not be invented here: past `TimeoutStartSec`
    // systemd kills the start itself and the unit goes `failed`, which this
    // code already reads as "nothing is coming". The clock is a backstop for a
    // transition we might not see, so it may only agree with systemd late —
    // never contradict it early, which a shorter budget would.
    const unit = readFileSync(
      path.join(process.cwd(), "config", "clawbox-hermes-dashboard.service"),
      "utf-8",
    );
    const timeout = /^TimeoutStartSec=(\d+)$/m.exec(unit);
    expect(timeout, "the shipped unit must declare TimeoutStartSec").not.toBeNull();
    expect(UNIT_START_BUDGET_MS).toBe(Number(timeout![1]) * 1_000);
  });

  it("leaves the panel a finite wait between polls, however long it waits", () => {
    // The panel's stopping condition is the answer, not a count — so the only
    // thing its schedule owes is a rate that settles. An unbounded delay would
    // reintroduce the same freeze by the back door.
    expect(degradedRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(DEGRADED_RETRY_MAX_MS);
    expect(DEGRADED_RETRY_MAX_MS).toBeLessThan(MAX_CHECKING_WINDOW_MS);
  });
});
