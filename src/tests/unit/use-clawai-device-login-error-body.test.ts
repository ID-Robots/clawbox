// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";

/**
 * The last hop before the wizard's status line, and the one the task names.
 *
 * `/clawai/poll` answers `{status:"error", error:"…"}`, and this hook hands
 * `error` straight to the host's `onError`, which sets the message the step
 * renders. When the field carried a body rather than a sentence, this is where
 * the braces passed through untouched:
 *
 *     {"error":"Credential migration failed. The subscription sign-in was
 *     rolled back — try again, or run 'openclaw doctor --fix' from the
 *     Terminal."}
 *
 * The route is fixed too; this is the belt to that pair of braces. A body can
 * reach this field from four hops upstream, and only the hop that renders can
 * guarantee what gets rendered.
 */

const realFetch = globalThis.fetch;

const ROLLED_BACK =
  "Credential migration failed. The subscription sign-in was rolled back — try again,"
  + " or run 'openclaw doctor --fix' from the Terminal.";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/**
 * Run one poll tick against a `/clawai/poll` that answers `pollBody`.
 *
 * `start()` is what arms the poll, so `/clawai/start` is answered first with a
 * device code and a one-second interval; the tick that follows is the one under
 * test. Resolves with whatever reached `onError`.
 */
async function errorFromPoll(pollBody: unknown): Promise<string | undefined> {
  const onError = vi.fn();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/clawai/start")) {
      return jsonResponse({ user_code: "ABCD-1234", verification_url: "https://example.test", interval: 1 });
    }
    return jsonResponse(pollBody);
  }) as unknown as typeof fetch;

  const { result } = renderHook(() => useClawaiDeviceLogin({
    getTier: () => "flash",
    onComplete: vi.fn(),
    onError,
  }));

  await result.current.start();
  await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5000 });
  return onError.mock.calls.at(-1)?.[0] as string | undefined;
}

describe("the ClawBox AI device-login poll renders a sentence, never a body", () => {
  it("unwraps a body that arrived in the error field", async () => {
    expect(await errorFromPoll({ status: "error", error: JSON.stringify({ error: ROLLED_BACK }) }))
      .toBe(ROLLED_BACK);
  });

  it("shows no braces and no field names to the owner", async () => {
    const shown = await errorFromPoll({ status: "error", error: JSON.stringify({ error: ROLLED_BACK }) });
    expect(shown).not.toContain("{");
    expect(shown).not.toContain('"error"');
  });

  it("passes an ordinary sentence through unchanged", async () => {
    expect(await errorFromPoll({ status: "error", error: ROLLED_BACK })).toBe(ROLLED_BACK);
  });

  it("relays the service-ownership rollback whole", async () => {
    const ownership =
      "Credential migration could not start: this device's OpenClaw could not confirm that ClawBox"
      + " manages the gateway service, so the subscription sign-in was rolled back.";
    expect(await errorFromPoll({ status: "error", error: ownership })).toBe(ownership);
  });

  it("falls back when the field is not a string at all", async () => {
    // The field was typed `string` and never guaranteed to be one. An object
    // here used to reach React as a message and throw while rendering it.
    expect(await errorFromPoll({ status: "error", error: { code: 502 } }))
      .toBe("ClawBox AI authorisation failed");
  });

  it("falls back on an error status with no message", async () => {
    expect(await errorFromPoll({ status: "error" })).toBe("ClawBox AI authorisation failed");
  });

  it("unwraps a nested error object", async () => {
    expect(await errorFromPoll({ status: "error", error: { message: ROLLED_BACK } })).toBe(ROLLED_BACK);
  });
});
