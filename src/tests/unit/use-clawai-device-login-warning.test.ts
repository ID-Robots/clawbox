// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";

/**
 * The last hop before the panel's own warning line.
 *
 * A ClawBox AI sign-in is a `subscription` save: it takes the auth-profile
 * migration, the gateway stop and therefore the DEFERRED session sweep — so it
 * is the path most likely to answer "saved, but a chat that was already open
 * keeps its previous model", and it was the one path that dropped the sentence.
 * The poll route now carries it; this hook is what hands it to the host, whose
 * `showSuccessAndContinue(warning)` renders it in place of "Configured".
 */

const realFetch = globalThis.fetch;

const SWEEP_WARNING =
  "Saved, but a chat that was already open keeps its previous model — pick the model again in its header.";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/** Run one poll tick against a `/clawai/poll` that answers `pollBody`. */
async function completionFromPoll(pollBody: unknown): Promise<unknown[]> {
  const onComplete = vi.fn();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/clawai/start")) {
      return jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 1 });
    }
    return jsonResponse(pollBody);
  }) as unknown as typeof fetch;

  const { result } = renderHook(() => useClawaiDeviceLogin({
    getTier: () => "flash",
    onComplete,
    onError: vi.fn(),
  }));

  await result.current.start();
  await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 5000 });
  return onComplete.mock.calls.at(-1) ?? [];
}

describe("the ClawBox AI device login relays what the save could not do", () => {
  it("hands the poll's warning to the host that renders it", async () => {
    expect(await completionFromPoll({ status: "complete", warning: SWEEP_WARNING })).toEqual([SWEEP_WARNING]);
  });

  it("completes with nothing to say when there was no warning", async () => {
    expect(await completionFromPoll({ status: "complete" })).toEqual([undefined]);
  });

  it("treats a blank warning as none, so the panel does not replace 'Configured' with whitespace", async () => {
    expect(await completionFromPoll({ status: "complete", warning: "   " })).toEqual([undefined]);
  });
});
