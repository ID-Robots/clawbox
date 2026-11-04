import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardWsTicket: vi.fn() }));

import { withoutErrorPrefix } from "@/lib/hermes-cli-message";
import {
  cliRefusedSession,
  DASHBOARD_READY_BUDGET_MS,
  SESSION_REFUSED_MESSAGE,
  SESSION_REFUSED_NO_DASHBOARD_MESSAGE,
  waitForDashboard,
} from "@/lib/hermes-session-refusal";

/**
 * The two halves of the TASK-2152 retry that the route test takes on trust:
 * which CLI failure earns it, and the bounded wait for the dashboard before it.
 */

describe("cliRefusedSession", () => {
  it("reads the refusal the CLI printed on the board", () => {
    // Captured shape: the resume banner first, then the refusal, exit 1.
    const stderr = [
      '↻ Resumed session 20261104_090334_5e1f0a "Remember the word" (2 user messages, 6 total messages)',
      "Error: permission_denied",
      "",
    ].join("\n");
    expect(cliRefusedSession(stderr)).toBe(true);
    expect(cliRefusedSession("Error: permission_denied")).toBe(true);
    expect(cliRefusedSession("Error: permission_denied \r\n")).toBe(true);
  });

  it("does not read every mention of a permission as the refusal", () => {
    // Another failure is reported as it is, never retried.
    expect(cliRefusedSession("Error: cannot write config.yaml: permission denied")).toBe(false);
    expect(cliRefusedSession("PermissionError: [Errno 13] Permission denied")).toBe(false);
    expect(cliRefusedSession("the tool said permission_denied while listing")).toBe(false);
    expect(cliRefusedSession("Error: permission_denied_for_profile")).toBe(false);
    expect(cliRefusedSession("Error: Gateway could not start: runtime_exited")).toBe(false);
    expect(cliRefusedSession("")).toBe(false);
  });

  it("tells the owner what to do, not the code", () => {
    for (const sentence of [SESSION_REFUSED_MESSAGE, SESSION_REFUSED_NO_DASHBOARD_MESSAGE]) {
      expect(sentence).not.toContain("permission_denied");
      expect(sentence).not.toMatch(/^Error:/);
    }
    expect(SESSION_REFUSED_MESSAGE).toMatch(/send your message again/i);
    // Where no retry exists, sending again is refused the same way.
    expect(SESSION_REFUSED_NO_DASHBOARD_MESSAGE).not.toMatch(/again/i);
    expect(SESSION_REFUSED_NO_DASHBOARD_MESSAGE).toMatch(/new chat/i);
  });
});

describe("withoutErrorPrefix", () => {
  it("drops the CLI's own opener, so the chat's prefix is the only one", () => {
    expect(withoutErrorPrefix("Error: permission_denied")).toBe("permission_denied");
    expect(withoutErrorPrefix("  error:  Gateway could not start: runtime_exited ")).toBe("Gateway could not start: runtime_exited");
    expect(withoutErrorPrefix("Error:")).toBe("");
  });

  it("keeps a failure whose NAME ends in Error", () => {
    expect(withoutErrorPrefix("RuntimeError: upstream refused the request")).toBe("RuntimeError: upstream refused the request");
    expect(withoutErrorPrefix("HTTP 404: Model not found")).toBe("HTTP 404: Model not found");
  });
});

/** A clock that only moves when the wait sleeps, so the budget is exact. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe("waitForDashboard", () => {
  it("is ready at once when the dashboard already mints a ticket", async () => {
    const c = clock();
    const probe = vi.fn(async () => "a-ticket");
    await expect(waitForDashboard({ probe, now: c.now, sleep: c.sleep })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(c.slept).toEqual([]);
  });

  it("asks again until the dashboard answers", async () => {
    const c = clock();
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce("a-ticket");
    await expect(waitForDashboard({ probe, now: c.now, sleep: c.sleep, pollMs: 1_000 })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(c.slept).toEqual([1_000, 1_000]);
  });

  it("gives up when the budget is spent, never sleeping past it", async () => {
    const c = clock();
    const probe = vi.fn(async () => null);
    await expect(waitForDashboard({ probe, now: c.now, sleep: c.sleep, budgetMs: 2_500, pollMs: 1_000 }))
      .resolves.toBe(false);
    expect(c.slept).toEqual([1_000, 1_000, 500]);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("is bounded by default", async () => {
    const c = clock();
    const probe = vi.fn(async () => null);
    await expect(waitForDashboard({ probe, now: c.now, sleep: c.sleep })).resolves.toBe(false);
    expect(c.slept.reduce((a, b) => a + b, 0)).toBe(DASHBOARD_READY_BUDGET_MS);
  });

  it("does not ask at all once the turn was stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const probe = vi.fn(async () => "a-ticket");
    await expect(waitForDashboard({ probe, signal: stop.signal })).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("ends the wait when the owner stops the turn", async () => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const probe = vi.fn(async () => null);
      const waiting = waitForDashboard({ probe, signal: stop.signal, budgetMs: 60_000, pollMs: 10_000 });
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      // The real sleep wakes on the abort, long before its 10 s are up.
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
