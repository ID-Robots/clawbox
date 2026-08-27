// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { GatewayLink } from "@/lib/harness/openclaw-gateway-adapter";
import type { HermesTurnContext } from "@/lib/harness/hermes-adapter";

/**
 * The SECOND cache over the same fact: the browser's.
 *
 * The server-side fix stopped remembering a failed Hermes probe as a negative
 * answer, and its stated customer outcome is that a box which was merely busy
 * "gets its attach button back inside a minute rather than at the next
 * restart". The browser never delivered that minute. `useHarnessAdapter`
 * fetches the facts exactly once, on mount, and the only re-probe trigger is
 * `onProvidersChanged`, which fires on an explicit provider-configure success
 * and on no timer at all. A capabilities response that SUCCEEDS while the
 * server-side probe is in backoff carries a legitimate-looking
 * `hermesSupportsImages: false`, indistinguishable from a real negative — so
 * one slow moment during chat open hid the composer's attach button for the
 * entire page session, until a reload or a Settings change.
 *
 * `factsPending` is how the unknown-ness reaches here, and this is the pinning
 * for what the hook does with it: exactly one re-ask per pending answer, no
 * earlier than the server's own backoff, capped so a permanently broken box
 * cannot be polled for the life of the tab.
 */

const fetchHarness = vi.fn();
vi.mock("@/lib/client-harness", () => ({ fetchHarness }));

const FACTS = {
  hasClawaiToken: false,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
  hasClawaiImageRoute: false,
  hermesAgentDrawsImages: false,
};

const RETRY_AFTER_MS = 60_000;
/** Comfortably past the retry the hook should schedule, margin included. */
const PAST_THE_RETRY_MS = RETRY_AFTER_MS + 30_000;

let capabilities: {
  facts: typeof FACTS;
  factsPending: boolean;
  factsRetryAfterMs: number;
};
let capabilityFetches: number;

const gateway: GatewayLink = {
  request: async () => null,
  sessionKey: () => "",
  open: async () => {},
  close: () => {},
  onStatus: () => () => {},
};
const hermesContext = (): HermesTurnContext => ({
  devicePairing: { provider: "", model: "" },
  modelsReady: false,
});

async function mount() {
  const { useHarnessAdapter } = await import("@/lib/harness/use-harness-adapter");
  const rendered = renderHook(() => useHarnessAdapter({ gateway, hermesContext }));
  // Let the mount effect's fetches settle before anything is asserted.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return rendered;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  capabilityFetches = 0;
  capabilities = { facts: { ...FACTS }, factsPending: false, factsRetryAfterMs: RETRY_AFTER_MS };
  fetchHarness.mockResolvedValue({ active: "hermes", edition: "hermes" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/setup-api/chat/capabilities")) {
        capabilityFetches += 1;
        return new Response(JSON.stringify(capabilities), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useHarnessAdapter facts backoff", () => {
  it("re-asks once the server's backoff is up when a fact is still pending", async () => {
    capabilities.factsPending = true;
    const { unmount } = await mount();
    expect(capabilityFetches).toBe(1);

    // The composer's attach button is hidden on a fact the server has already
    // said it will replace. Nothing must be asked before the backoff is up …
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1_000);
    });
    expect(capabilityFetches).toBe(1);

    // … and the recovered answer must arrive without a reload.
    capabilities = {
      facts: { ...FACTS, hermesSupportsImages: true, hermesHasVisionRoute: true },
      factsPending: false,
      factsRetryAfterMs: RETRY_AFTER_MS,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS);
    });
    expect(capabilityFetches).toBe(2);

    // And once it has answered, it stays answered — no polling loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS * 4);
    });
    expect(capabilityFetches).toBe(2);
    unmount();
  });

  it("does not re-ask at all when every fact was answered", async () => {
    const { unmount } = await mount();
    expect(capabilityFetches).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS * 5);
    });
    expect(capabilityFetches).toBe(1);
    unmount();
  });

  it("gives up after two attempts rather than polling a broken box for ever", async () => {
    capabilities.factsPending = true;
    const { unmount } = await mount();
    expect(capabilityFetches).toBe(1);

    // Each retry is only scheduled once the previous answer has been applied,
    // so the clock is advanced a window at a time rather than in one jump.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS);
    });
    expect(capabilityFetches).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS);
    });
    expect(capabilityFetches).toBe(3);

    // The mount fetch plus the two capped retries, and then silence: a box
    // whose `hermes` is genuinely broken must not be asked for the life of the
    // tab, which is what the server-side backoff exists to prevent in the
    // first place.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS);
      });
    }
    expect(capabilityFetches).toBe(3);
    unmount();
  });

  it("schedules nothing after the component has gone", async () => {
    capabilities.factsPending = true;
    const { unmount } = await mount();
    expect(capabilityFetches).toBe(1);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_THE_RETRY_MS * 5);
    });
    expect(capabilityFetches).toBe(1);
  });
});
