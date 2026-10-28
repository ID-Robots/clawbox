// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  CLAWAI_CONFIGURING_CEILING_MS,
  CLAWAI_CONFIGURING_TIMEOUT_CODE,
  useClawaiDeviceLogin,
} from "@/hooks/useClawaiDeviceLogin";

/**
 * The device-login hook ends every attempt it starts: a refusal reaches the
 * host with its code (so the panel can say it in the owner's language and
 * offer the removal), and a sign-in that stays `configuring` past every
 * server-side ceiling is given up on, never polled forever.
 */

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `/clawai/start` with a one-second interval, then `/clawai/poll` answering `poll(n)`. */
function stubPoll(poll: (n: number) => unknown) {
  let polls = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/clawai/start")) {
      return jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 1 });
    }
    polls += 1;
    return jsonResponse(poll(polls));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe("useClawaiDeviceLogin ends every attempt", () => {
  it("hands the host a refusal's code and profile beside its sentence", async () => {
    stubPoll(() => ({ status: "error", error: "Refused.", code: "clawai_slot_owner_key", profileId: "deepseek:default" }));
    const onError = vi.fn();
    const { result } = renderHook(() => useClawaiDeviceLogin({ getTier: () => "flash", onComplete: vi.fn(), onError }));

    await result.current.start();
    await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5000 });

    expect(onError).toHaveBeenCalledWith("Refused.", { code: "clawai_slot_owner_key", profileId: "deepseek:default" });
  });

  it("gives up on a sign-in that stays configuring past the ceiling, and says so with its own code", async () => {
    stubPoll(() => ({ status: "configuring" }));
    const onError = vi.fn();
    const onConfiguring = vi.fn();
    const { result } = renderHook(() => useClawaiDeviceLogin({
      getTier: () => "flash",
      onComplete: vi.fn(),
      onConfiguring,
      onError,
    }));

    await result.current.start();
    await waitFor(() => expect(onConfiguring).toHaveBeenCalledTimes(1), { timeout: 5000 });
    // The clock moves past the ceiling while the box keeps answering `configuring`.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CLAWAI_CONFIGURING_CEILING_MS + 1_000);

    await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5000 });
    expect(onError.mock.calls[0]?.[1]).toEqual({ code: CLAWAI_CONFIGURING_TIMEOUT_CODE });
    expect(result.current.polling).toBe(false);
    // And it stopped: no tick after the give-up.
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  }, 15_000);

  it("keeps following a sign-in that is configuring inside the ceiling", async () => {
    let finished = false;
    stubPoll((n) => (n >= 3 ? ((finished = true), { status: "complete" }) : { status: "configuring" }));
    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useClawaiDeviceLogin({ getTier: () => "flash", onComplete, onError }));

    await result.current.start();
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 6000 });
    expect(finished).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  }, 15_000);
});
