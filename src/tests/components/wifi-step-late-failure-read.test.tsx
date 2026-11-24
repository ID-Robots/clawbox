import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WifiStep from "@/components/WifiStep";

/**
 * The WiFi step's look, on mount, for an earlier join that failed.
 *
 * A join that fails reopens the setup hotspot and the owner lands back on this
 * step, which then reopens the form on the network that failed and says why.
 * That read answers whenever it answers. Answering after the owner had already
 * gone on to type a network, it put the old network's name over theirs —
 * Connect would then join the old network with the new password — and an old
 * failure over the form they were filling in.
 */
vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/hooks/useDeviceAddress", () => ({
  useDeviceAddress: () => ({ localUrl: "http://clawbox.local", primaryUrl: "http://10.42.0.1" }),
}));

let failureRead: PromiseWithResolvers<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  failureRead = Promise.withResolvers();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // Answers only when a test lands it.
    if (url.startsWith("/setup-api/wifi/connect-status")) {
      return { ok: true, json: () => failureRead.promise } as unknown as Response;
    }
    if (url.startsWith("/setup-api/wifi/ethernet")) {
      return new Response(JSON.stringify({ connected: false, cable: false }));
    }
    if (url.startsWith("/setup-api/wifi/scan")) {
      return new Response(JSON.stringify({ networks: [{ ssid: "HomeNet", signal: 70, security: "WPA2" }] }));
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EARLIER_FAILURE = () => ({
  phase: "failed",
  ssid: "OldNet",
  reason: "wrong-password",
  message: "",
  at: Date.now(),
});

async function mountStep() {
  render(<WifiStep onNext={vi.fn()} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/wifi/connect-status", expect.any(Object));
  });
}

/** Let the held read answer, and everything it sets render. */
async function land(body: Record<string, unknown>) {
  await act(async () => {
    failureRead.resolve(body);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WifiStep — an earlier failure reported after the owner moved on", () => {
  it("keeps the network the owner typed, and does not show the old failure over it", async () => {
    await mountStep();
    fireEvent.click(screen.getByRole("button", { name: /wifi\.useWifiInstead/ }));
    fireEvent.click(await screen.findByRole("button", { name: /wifi\.otherNetwork/ }));
    fireEvent.change(screen.getByLabelText("wifi.networkName"), { target: { value: "NewNet" } });

    await land(EARLIER_FAILURE());

    expect(screen.getByLabelText("wifi.networkName")).toHaveValue("NewNet");
    expect(screen.queryByText("wifi.wrongPassword")).not.toBeInTheDocument();
  });

  it("still reopens the failed network when the owner has not started choosing", async () => {
    await mountStep();

    await land(EARLIER_FAILURE());

    expect(screen.getByLabelText("wifi.networkName")).toHaveValue("OldNet");
    expect(screen.getByText("wifi.wrongPassword")).toBeInTheDocument();
  });
});
