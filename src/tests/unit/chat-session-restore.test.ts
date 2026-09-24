import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_RESTORE_DEADLINE_MS,
  SessionRestoreError,
  classifyRestoreFailure,
  isRestoreAborted,
  isRetryableRestoreRefusal,
  restoreWithRetry,
} from "@/lib/chat-session-restore";
import { gatewayFrameError } from "@/lib/chat-gateway-starting";
import { HarnessError } from "@/lib/harness/transport";
import { describeChatFailure, isUnacknowledgedTurn, UNACKNOWLEDGED_TURN_TEXT } from "@/lib/chat-error-text";

/**
 * TASK-1158: restoring a conversation must end.
 *
 * The frames below are the ones the gateway on a real box sent (its journal,
 * 2026-09-17 → 09-24): `chat.history` refused 45 times with
 * `UNAVAILABLE: session history is rebuilding; retry shortly`, and during a
 * restart with `chat.history unavailable during gateway restart`. The chat used
 * to log those and show an empty conversation; a restore now retries them for a
 * bounded time and then says so.
 */

const rebuilding = () => gatewayFrameError({ code: "UNAVAILABLE", message: "session history is rebuilding; retry shortly" });
const restarting = () => gatewayFrameError({ code: "UNAVAILABLE", message: "chat.history unavailable during gateway restart" });
/** What the gateway adapter hands the chat: its own error, the frame as `cause`. */
const wrapped = (inner: Error) => new HarnessError("upstream", inner.message, inner);

describe("isRetryableRestoreRefusal", () => {
  it("retries the gateway's own 'not yet' refusals, bare or wrapped by the adapter", () => {
    expect(isRetryableRestoreRefusal(rebuilding())).toBe(true);
    expect(isRetryableRestoreRefusal(restarting())).toBe(true);
    expect(isRetryableRestoreRefusal(wrapped(rebuilding()))).toBe(true);
    expect(isRetryableRestoreRefusal(gatewayFrameError({ code: "UNAVAILABLE", retryable: true, message: "x" }))).toBe(true);
    // The boot refusal the connect ladder already knows.
    expect(isRetryableRestoreRefusal(gatewayFrameError({
      code: "UNAVAILABLE", retryable: true, message: "gateway starting", details: { reason: "startup-sidecars" },
    }))).toBe(true);
  });

  it("does not retry what waiting will not change", () => {
    // UNAVAILABLE with retryable:false is the gateway's word for "never" (a
    // build mismatch answers that way) — retrying it is a loop.
    expect(isRetryableRestoreRefusal(gatewayFrameError({ code: "UNAVAILABLE", retryable: false, message: "control ui build mismatch" }))).toBe(false);
    expect(isRetryableRestoreRefusal(gatewayFrameError({ code: "INVALID_REQUEST", message: "unknown session" }))).toBe(false);
    expect(isRetryableRestoreRefusal(new Error("unavailable"))).toBe(false);
    expect(isRetryableRestoreRefusal(new HarnessError("timeout", "Request timeout"))).toBe(false);
  });
});

describe("classifyRestoreFailure", () => {
  it("names the three endings", () => {
    expect(classifyRestoreFailure(wrapped(rebuilding()))).toBe("busy");
    expect(classifyRestoreFailure(new HarnessError("timeout", "Request timeout"))).toBe("timeout");
    expect(classifyRestoreFailure(new Error("Request timeout"))).toBe("timeout");
    expect(classifyRestoreFailure(gatewayFrameError({ code: "INVALID_REQUEST", message: "unknown session" }))).toBe("failed");
    expect(classifyRestoreFailure(new SessionRestoreError("busy", 3))).toBe("busy");
  });
});

describe("restoreWithRetry", () => {
  // A fake clock the retry loop reads and a sleep that advances it — the loop's
  // arithmetic is what is under test, not the event loop's.
  let clock = 0;
  const now = () => clock;
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new HarnessError("aborted", "off");
    clock += ms;
  });
  const opts = (extra: Partial<Parameters<typeof restoreWithRetry>[1]> = {}) => ({
    now, sleep, attemptTimeoutMs: 1_000, deadlineMs: 20_000, delaysMs: [2_000, 4_000, 8_000], ...extra,
  });

  beforeEach(() => {
    clock = 0;
    sleep.mockClear();
  });

  it("normal restore: one read, no wait", async () => {
    const read = vi.fn(async () => ({ messages: ["hello"] }));
    await expect(restoreWithRetry(read, opts())).resolves.toEqual({ messages: ["hello"] });
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stale history: waits out 'rebuilding' and returns the conversation", async () => {
    const onRetry = vi.fn();
    const read = vi.fn()
      .mockRejectedValueOnce(wrapped(rebuilding()))
      .mockRejectedValueOnce(wrapped(restarting()))
      .mockResolvedValueOnce({ messages: ["back"] });
    await expect(restoreWithRetry(read, opts({ onRetry }))).resolves.toEqual({ messages: ["back"] });
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000]);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 2_000, kind: "busy" });
  });

  it("busy session: gives up as 'busy' at the deadline instead of retrying forever", async () => {
    const read = vi.fn(async () => { throw wrapped(rebuilding()); });
    const err = await restoreWithRetry(read, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionRestoreError);
    expect((err as SessionRestoreError).kind).toBe("busy");
    // 2 s + 4 s + 8 s waited; the next 8 s would cross the 20 s deadline.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000, 8_000]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(clock).toBeLessThan(20_000);
  });

  it("failed: a refusal waiting cannot fix ends the restore at once", async () => {
    const read = vi.fn(async () => { throw wrapped(gatewayFrameError({ code: "INVALID_REQUEST", message: "unknown session" })); });
    const err = await restoreWithRetry(read, opts()).catch((e: unknown) => e);
    expect((err as SessionRestoreError).kind).toBe("failed");
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborted: a newer restore calling this one off is not reported as a failure", async () => {
    const ctl = new AbortController();
    const read = vi.fn(async () => { ctl.abort(); throw wrapped(rebuilding()); });
    const err = await restoreWithRetry(read, opts({ signal: ctl.signal })).catch((e: unknown) => e);
    expect(isRestoreAborted(err)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not start at all once called off", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const read = vi.fn(async () => ({ messages: [] }));
    const err = await restoreWithRetry(read, opts({ signal: ctl.signal })).catch((e: unknown) => e);
    expect(isRestoreAborted(err)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("restoreWithRetry against a gateway that never answers (real timers, fake clock)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("timeout: every attempt is cut off, and the whole restore ends by its deadline", async () => {
    // The unbounded request at the heart of the hang: a read that never settles.
    const read = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();
    let endedAt = 0;
    const settled = restoreWithRetry(read, { attemptTimeoutMs: 5_000, deadlineMs: 30_000, delaysMs: [2_000] })
      .then(() => "resolved", (e: unknown) => { endedAt = Date.now(); return e; });
    await vi.advanceTimersByTimeAsync(40_000);
    const err = await settled;
    expect(err).toBeInstanceOf(SessionRestoreError);
    expect((err as SessionRestoreError).kind).toBe("timeout");
    // 5 s read + 2 s wait, four times over, is 28 s; the fifth read gets only
    // the 2 s left, and the restore ends exactly at its 30 s deadline.
    expect(read).toHaveBeenCalledTimes(5);
    expect(endedAt - started).toBe(30_000);
  });

  it("the default budget is the one the chat ships with", async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    let done = false;
    const settled = restoreWithRetry(read).catch((e: unknown) => { done = true; return e; });
    await vi.advanceTimersByTimeAsync(HISTORY_RESTORE_DEADLINE_MS - 1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(true);
    expect(((await settled) as SessionRestoreError).kind).toBe("timeout");
  });
});

describe("a turn the gateway never acknowledged", () => {
  it("is recognised by the chat's own request timer, bare or wrapped by the adapter", () => {
    expect(isUnacknowledgedTurn("Request timeout")).toBe(true);
    expect(isUnacknowledgedTurn(new HarnessError("timeout", "Request timeout"))).toBe(true);
    // The adapter puts the `timeout` code on any refusal that mentions one;
    // those are other failures and keep their own wording.
    expect(isUnacknowledgedTurn(new HarnessError("timeout", "UNAVAILABLE: tool timeout exceeded"))).toBe(false);
    expect(isUnacknowledgedTurn("Request timed out.")).toBe(false);
    expect(isUnacknowledgedTurn(undefined)).toBe(false);
  });

  it("is not told to 'send it again' — the gateway may still be holding it", () => {
    expect(UNACKNOWLEDGED_TURN_TEXT).toMatch(/still busy/i);
    expect(UNACKNOWLEDGED_TURN_TEXT).toMatch(/new chat/i);
    expect(UNACKNOWLEDGED_TURN_TEXT).not.toMatch(/send it again/i);
  });

  it("leaves describeChatFailure's wording alone — a surface with no new chat must not promise one", () => {
    expect(describeChatFailure("Request timeout")).not.toBe(UNACKNOWLEDGED_TURN_TEXT);
    expect(describeChatFailure("Request exceeds the size limit")).toBe("Error: Request exceeds the size limit");
  });
});
