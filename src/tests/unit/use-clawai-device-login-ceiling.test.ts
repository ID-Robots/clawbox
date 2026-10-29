// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CLAWAI_POLL_CEILING_MS,
  CLAWAI_POLL_REQUEST_TIMEOUT_MS,
  CLAWAI_START_TIMEOUT_MS,
  useClawaiDeviceLogin,
} from "@/hooks/useClawaiDeviceLogin";

/**
 * The ClawBox AI sign-in must end, whatever the box does or does not answer.
 *
 * The kick-off button reads "Connecting…" for as long as `/clawai/start` is in
 * flight, and the poll chain only schedules its next tick once the current one
 * has answered — so a request that never settles (a dropped tunnel, a server
 * busy past the browser's patience) held the button, or the whole flow, for
 * good. Every request now has a deadline and the poll has a ceiling, and each
 * ends in a "Failed: …" sentence the host renders.
 */

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A request nothing answers — and one that ignores its signal, so only the hook's own deadline can end it. */
const never = () => new Promise<Response>(() => {});

function mount() {
  const onError = vi.fn();
  const onBusyChange = vi.fn();
  const onComplete = vi.fn();
  const hook = renderHook(() => useClawaiDeviceLogin({ getTier: () => "flash", onError, onBusyChange, onComplete }));
  return { hook, onError, onBusyChange, onComplete };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe("the ClawBox AI device login never spins forever", () => {
  it("ends a kick-off nothing answers in a Failed sentence and frees the button", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return never();
    }) as unknown as typeof fetch;
    const { hook, onError, onBusyChange } = mount();

    let started!: Promise<void>;
    act(() => { started = hook.result.current.start(); });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await advance(CLAWAI_START_TIMEOUT_MS - 1);
    expect(onError).not.toHaveBeenCalled();

    await advance(1);
    await act(async () => { await started; });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/^Failed: /);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    // The request itself is cancelled, not just forgotten.
    expect(signals[0]?.aborted).toBe(true);
  });

  it("reports nothing for a kick-off the host stopped", async () => {
    globalThis.fetch = vi.fn(never) as unknown as typeof fetch;
    const { hook, onError } = mount();

    act(() => { void hook.result.current.start(); });
    act(() => { hook.result.current.stop(); });
    await advance(CLAWAI_START_TIMEOUT_MS * 2);

    expect(onError).not.toHaveBeenCalled();
  });

  it("retries a poll tick nothing answers, then gives up at the ceiling", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/clawai/start")) {
        return jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 1 });
      }
      polls += 1;
      return never();
    }) as unknown as typeof fetch;
    const { hook, onError, onBusyChange } = mount();

    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.deviceCode).toBe("ABCD-1234");

    // A hung tick is a blip, not a verdict: the next one goes out.
    await advance(1000 + CLAWAI_POLL_REQUEST_TIMEOUT_MS + 1000);
    expect(polls).toBe(2);
    expect(onError).not.toHaveBeenCalled();

    await advance(CLAWAI_POLL_CEILING_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/^Failed: /);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(hook.result.current.deviceCode).toBeNull();
    expect(hook.result.current.polling).toBe(false);

    // And it stays stopped.
    const after = polls;
    await advance(CLAWAI_POLL_REQUEST_TIMEOUT_MS * 4);
    expect(polls).toBe(after);
  });

  it("gives up on a finaliser that answers configuring for ever", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/clawai/start")
      ? jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 5 })
      : jsonResponse({ status: "configuring" }))) as unknown as typeof fetch;
    const { hook, onError } = mount();

    await act(async () => { await hook.result.current.start(); });
    await advance(CLAWAI_POLL_CEILING_MS + 10_000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/^Failed: /);
  });

  it("still relays the finaliser's own error at once", async () => {
    const sentence = "ClawBox AI could not replace an older sign-in stored in its credential slot (deepseek:default).";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).includes("/clawai/start")
      ? jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 1 })
      : jsonResponse({ status: "error", error: sentence }))) as unknown as typeof fetch;
    const { hook, onError } = mount();

    await act(async () => { await hook.result.current.start(); });
    await advance(1000);

    expect(onError).toHaveBeenCalledWith(sentence);
  });
});
