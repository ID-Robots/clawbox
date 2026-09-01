import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TelegramConfiguringOverlay from "@/components/TelegramConfiguringOverlay";
import { resetHarnessCache } from "@/lib/client-harness";

// The Telegram configure overlay waits for "something is listening again"
// before it shows the ready phase. On an OpenClaw box that is the gateway; on a
// Hermes box the gateway is masked and never comes back, so the overlay used to
// burn its whole health budget and then finish without ever reporting ready.

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

// The overlay's choreography is real time: 1.5 s + 2.5 s + 2 s of fixed phases
// before it polls at all, a 2 s poll interval, then 1.5 s in the ready phase —
// 7.5 s per case, 10 s for the give-up case, ~25 s of sleeping for three cases
// that assert nothing about wall-clock time. Fake timers (advancing on their
// own so RTL's waitFor and React's scheduler keep working, as elsewhere in this
// suite) let each case jump the clock past the whole sequence in one step; the
// sequence itself, the poll count and the readiness rule are unchanged.
//
// The fixed phases, in ms, and the ready phase after a poll succeeds.
const PHASES_MS = 1_500 + 2_500 + 2_000;
const READY_PHASE_MS = 1_500;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

/** Did the overlay call this path at least once? */
function called(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(([input]) => String(input) === path);
}

describe("TelegramConfiguringOverlay readiness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetHarnessCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetHarnessCache();
  });

  it("reaches the ready phase on hermes without polling the OpenClaw gateway", async () => {
    const onDone = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "hermes", edition: "hermes" });
      }
      if (url === "/setup-api/telegram/status") {
        // `receiving` is the route's "token registered with Hermes AND its
        // messaging gateway is running" signal.
        return jsonResponse({ configured: true, receiving: true, gateway: { installed: true, running: true } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TelegramConfiguringOverlay onDone={onDone} onTimeout={vi.fn()} waitFor={Promise.resolve()} />);

    // The two middle steps name what actually starts on this edition...
    await waitFor(() => {
      expect(screen.getByText("telegram.hermesStartingService")).toBeInTheDocument();
    });
    expect(screen.getByText("telegram.hermesWaitingService")).toBeInTheDocument();
    // ...and never the gateway, which is not installed on a Hermes box.
    expect(screen.queryByText("telegram.restartingGateway")).not.toBeInTheDocument();
    expect(screen.queryByText("telegram.waitingGateway")).not.toBeInTheDocument();

    // Through the fixed phases, the first (successful) poll and the ready phase.
    await advance(PHASES_MS + READY_PHASE_MS);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(true);
    // Reaching phase 4 is the whole point: the previous behaviour called
    // onDone() from the timeout branch, so the owner never saw "ready to chat".
    // The label lands in two places at phase 4 — the visible subtitle and the
    // sr-only live region — so count rather than expect a single node.
    expect(screen.queryAllByText("telegram.botReady").length).toBeGreaterThan(0);
  });

  it("still polls the gateway on an openclaw device", async () => {
    const onDone = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "openclaw", edition: "openclaw" });
      }
      if (url === "/setup-api/gateway/health") {
        return jsonResponse({ available: true, port: 18789 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TelegramConfiguringOverlay onDone={onDone} onTimeout={vi.fn()} waitFor={Promise.resolve()} />);

    await waitFor(() => {
      expect(screen.getByText("telegram.restartingGateway")).toBeInTheDocument();
    });
    expect(screen.queryByText("telegram.hermesStartingService")).not.toBeInTheDocument();

    await advance(PHASES_MS + READY_PHASE_MS);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(true);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(false);
  });

  it("hands control back without a ready phase when hermes never starts listening", async () => {
    const onDone = vi.fn();
    const onTimeout = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "hermes", edition: "hermes" });
      }
      if (url === "/setup-api/telegram/status") {
        // Token stored, but the messaging gateway did not come up.
        return jsonResponse({ configured: true, receiving: false, gateway: { installed: true, running: false } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    // Short budget so the give-up path is reached quickly: two 2 s attempts.
    const healthTimeoutMs = 4_000;
    render(
      <TelegramConfiguringOverlay onDone={onDone} onTimeout={onTimeout} waitFor={Promise.resolve()} healthTimeoutMs={healthTimeoutMs} />,
    );

    // Not there yet: the budget has to run out before the overlay gives up.
    await advance(PHASES_MS + healthTimeoutMs / 2);
    expect(onDone).not.toHaveBeenCalled();

    await advance(healthTimeoutMs / 2);
    await waitFor(() => {
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });
    expect(onDone).not.toHaveBeenCalled();

    // The parent surfaces its own error — the overlay must not claim success.
    expect(screen.queryAllByText("telegram.botReady")).toHaveLength(0);
    // Both halves matter: the negative alone would also hold if the overlay
    // polled NOTHING and timed out, which is a different bug with the same
    // outcome. Assert it did ask Hermes and simply never got a listener.
    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(true);
  });

  it("reports a failed configure promise instead of leaving an unhandled rejection", async () => {
    const onDone = vi.fn();
    const onTimeout = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/setup-api/harness/active") {
        return jsonResponse({ active: "openclaw", edition: "openclaw" });
      }
      if (String(input) === "/setup-api/gateway/health") {
        return jsonResponse({ available: true, port: 18789 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TelegramConfiguringOverlay
        onDone={onDone}
        onTimeout={onTimeout}
        waitFor={Promise.reject(new Error("configure failed"))}
      />,
    );

    await advance(PHASES_MS);
    await waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports readiness expiry even when the configure request never settles", async () => {
    const onDone = vi.fn();
    const onTimeout = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/setup-api/harness/active") {
        return jsonResponse({ active: "openclaw", edition: "openclaw" });
      }
      if (String(input) === "/setup-api/gateway/health") {
        return jsonResponse({ available: false, port: 18789 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const pendingConfigure = new Promise<void>(() => {});
    const healthTimeoutMs = 4_000;
    render(
      <TelegramConfiguringOverlay
        onDone={onDone}
        onTimeout={onTimeout}
        waitFor={pendingConfigure}
        healthTimeoutMs={healthTimeoutMs}
      />,
    );

    await advance(PHASES_MS + healthTimeoutMs);
    await waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));
    expect(onDone).not.toHaveBeenCalled();
    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(true);
  });

  it("enforces the readiness deadline when the gateway health request never settles", async () => {
    const onDone = vi.fn();
    const onTimeout = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/setup-api/harness/active") {
        return jsonResponse({ active: "openclaw", edition: "openclaw" });
      }
      if (String(input) === "/setup-api/gateway/health") {
        return new Promise<Response>(() => {});
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const healthTimeoutMs = 4_000;
    render(
      <TelegramConfiguringOverlay
        onDone={onDone}
        onTimeout={onTimeout}
        waitFor={Promise.resolve()}
        healthTimeoutMs={healthTimeoutMs}
      />,
    );

    await advance(PHASES_MS + healthTimeoutMs);
    await waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));
    expect(onDone).not.toHaveBeenCalled();
    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(true);
  });
});
