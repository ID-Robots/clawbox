import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The expiry timer of a power request, against a clock that moves under it.
// No RTC on the box: NTP can step the wall clock by any amount, in either
// direction, while a request waits for the owner.
const exec = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn<(action: Record<string, unknown>, id?: string) => Promise<unknown>>(async () => ({})));
vi.mock("node:child_process", () => ({ execFile: exec }));
vi.mock("@/lib/pending-actions", () => ({ pushPendingAction: push }));
// Desktop-only: no approvals bot, so nothing here waits on Telegram.
vi.mock("@/lib/email-approval", () => ({
  approvalBotToken: async () => null, chatApprovalEnabled: async () => false,
  ownerChatIds: async () => [], startApprovalPoller: () => {},
}));
vi.mock("@/lib/email-approval-telegram", () => ({
  sendApprovalMessage: async () => 1, answerCallback: async () => {}, clearApprovalKeyboard: async () => {}, replyInChat: async () => {},
}));
import { requestPowerApproval, resolvePowerApproval, type PowerApproval } from "@/lib/power-approval";

type State = { pending: PowerApproval | null; deniedAt?: number };
const state = () => (globalThis as typeof globalThis & { [key: symbol]: State })[Symbol.for("clawbox.power-approval")];
/** Read off the state itself: `pendingPowerApproval()` would expire it lazily and prove nothing about the timer. */
const live = () => state().pending;
const DAY_MS = 86_400_000;
/** The largest delay a timer can hold; past it Node fires after 1 ms. */
const TIMER_MAX_MS = 2 ** 31 - 1;
const settledFor = (id: string) => push.mock.calls.filter(([, notice]) => notice === `power-approval:${id}:settled`);

describe("the expiry timer of a power request", () => {
  beforeEach(() => {
    exec.mockImplementation((...args: unknown[]) => (args.at(-1) as (...a: unknown[]) => void)(null, "", ""));
    push.mockImplementation(async () => ({}));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Settled while the fake clock is still in charge, so the timer it armed
    // is cleared by the clock that made it.
    const left = live();
    if (left) await resolvePowerApproval(left.id, left.action, false);
    delete state().deniedAt;
    vi.useRealTimers();
  });

  it("never asks for a delay a timer cannot hold when the clock is stepped back by weeks", async () => {
    const prompt = await requestPowerApproval("restart", "test");
    const armed = vi.spyOn(globalThis, "setTimeout");
    // Further back than a timer can hold: ~24.8 days.
    vi.setSystemTime(Date.now() - 30 * DAY_MS);
    // Past the request's original deadline on the timer's own clock.
    await vi.advanceTimersByTimeAsync(121_000);
    // Still live by the wall-clock test every reader applies…
    expect(live()).toBe(prompt);
    expect(settledFor(prompt.id)).toHaveLength(0);
    // …and looked at again on a calm schedule, not every millisecond: an
    // overflowed delay fires after 1 ms and is re-armed at once, hundreds of
    // times in this window.
    const delays = armed.mock.calls.map(([, ms]) => Number(ms ?? 0));
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.length).toBeLessThanOrEqual(3);
    for (const ms of delays) {
      expect(ms).toBeLessThan(TIMER_MAX_MS);
      expect(ms).toBeGreaterThanOrEqual(60_000);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("expires it once the stepped-back clock reaches the deadline, still with nobody asking", async () => {
    const prompt = await requestPowerApproval("shutdown", "test");
    vi.setSystemTime(Date.now() - 30 * DAY_MS);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(live()).toBe(prompt);
    // NTP brings the clock back past the deadline.
    vi.setSystemTime(prompt.expiresAt + 1);
    await vi.advanceTimersByTimeAsync(60_500);
    expect(live()).toBeNull();
    expect(settledFor(prompt.id)).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it("notices a clock stepped forward past the deadline within a minute", async () => {
    const prompt = await requestPowerApproval("restart", "test");
    // The wall clock says the two minutes are already up.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(live()).toBeNull();
    expect(settledFor(prompt.id)).toHaveLength(1);
  });

  it("still expires an untouched request at its deadline, and not before", async () => {
    const prompt = await requestPowerApproval("restart", "test");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(live()).toBe(prompt);
    expect(settledFor(prompt.id)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(live()).toBeNull();
    expect(settledFor(prompt.id)).toHaveLength(1);
  });
});
