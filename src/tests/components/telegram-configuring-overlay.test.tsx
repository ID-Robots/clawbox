import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
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

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

/** Did the overlay call this path at least once? */
function called(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(([input]) => String(input) === path);
}

describe("TelegramConfiguringOverlay readiness", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetHarnessCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    render(<TelegramConfiguringOverlay onDone={onDone} waitFor={Promise.resolve()} />);

    // The two middle steps name what actually starts on this edition...
    await waitFor(() => {
      expect(screen.getByText("telegram.hermesStartingService")).toBeInTheDocument();
    });
    expect(screen.getByText("telegram.hermesWaitingService")).toBeInTheDocument();
    // ...and never the gateway, which is not installed on a Hermes box.
    expect(screen.queryByText("telegram.restartingGateway")).not.toBeInTheDocument();
    expect(screen.queryByText("telegram.waitingGateway")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    }, { timeout: 20_000 });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(true);
    // Reaching phase 4 is the whole point: the previous behaviour called
    // onDone() from the timeout branch, so the owner never saw "ready to chat".
    // The label lands in two places at phase 4 — the visible subtitle and the
    // sr-only live region — so count rather than expect a single node.
    expect(screen.queryAllByText("telegram.botReady").length).toBeGreaterThan(0);
  }, 30_000);

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

    render(<TelegramConfiguringOverlay onDone={onDone} waitFor={Promise.resolve()} />);

    await waitFor(() => {
      expect(screen.getByText("telegram.restartingGateway")).toBeInTheDocument();
    });
    expect(screen.queryByText("telegram.hermesStartingService")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    }, { timeout: 20_000 });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(true);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(false);
  }, 30_000);

  it("hands control back without a ready phase when hermes never starts listening", async () => {
    const onDone = vi.fn();
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

    // Short budget so the give-up path is reached quickly.
    render(
      <TelegramConfiguringOverlay onDone={onDone} waitFor={Promise.resolve()} healthTimeoutMs={4_000} />,
    );

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    }, { timeout: 20_000 });

    // The parent surfaces its own error — the overlay must not claim success.
    expect(screen.queryAllByText("telegram.botReady")).toHaveLength(0);
    // Both halves matter: the negative alone would also hold if the overlay
    // polled NOTHING and timed out, which is a different bug with the same
    // outcome. Assert it did ask Hermes and simply never got a listener.
    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
    expect(called(fetchMock, "/setup-api/telegram/status")).toBe(true);
  }, 30_000);
});
