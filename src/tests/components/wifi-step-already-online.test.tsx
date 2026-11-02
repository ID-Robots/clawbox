import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WifiStep from "@/components/WifiStep";

/**
 * Step 1 on a computer that is already online over its own Wi-Fi.
 *
 * The step had two ways forward: "Continue with Ethernet", enabled only while
 * a cable is connected, and joining a network through the box's scan. On a PC
 * installed by install-x64.sh (a DGX Spark, a laptop) the network belongs to
 * the operating system: the scan's root helper is not even installed there, so
 * it found nothing, and with no cable the first step could not be passed at
 * all — on a machine that was online the whole time.
 */
vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));
vi.mock("@/hooks/useDeviceAddress", () => ({
  useDeviceAddress: () => ({ localUrl: null, primaryUrl: null }),
}));

type Eth = { connected: boolean; cable: boolean; iface: string | null; online?: boolean };

function mockFetch(eth: Eth) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.startsWith("/setup-api/wifi/ethernet")) return new Response(JSON.stringify(eth));
    if (url.startsWith("/setup-api/wifi/connect-status")) return new Response(JSON.stringify({ phase: "idle" }));
    if (url.startsWith("/setup-api/wifi/connect")) return new Response(JSON.stringify({ success: true }));
    return new Response("{}");
  }));
  return calls;
}

describe("WifiStep on a computer that is already online", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it("lets an online computer with no cable continue, marking the network step done", async () => {
    const calls = mockFetch({ connected: false, cable: false, iface: "enP7s7", online: true });
    const onNext = vi.fn();
    render(<WifiStep onNext={onNext} />);

    const button = await screen.findByRole("button", { name: /wifi\.proceedOnline/ });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText("wifi.onlineReady")).toBeInTheDocument();

    fireEvent.click(button);
    expect(onNext).toHaveBeenCalledTimes(1);
    const skip = calls.find((c) => c.url === "/setup-api/wifi/connect");
    expect(skip?.body).toBe(JSON.stringify({ skip: true }));
  });

  it("still holds a box with no cable and no internet at the choice", async () => {
    // A Jetson on first boot: broadcasting its setup hotspot, nothing upstream.
    mockFetch({ connected: false, cable: false, iface: "eth0", online: false });
    render(<WifiStep onNext={vi.fn()} />);
    const primary = await screen.findByRole("button", { name: /wifi\.proceedEthernet/ });
    await waitFor(() => expect(primary).toBeDisabled());
    expect(screen.queryByText("wifi.onlineReady")).not.toBeInTheDocument();
  });

  it("keeps the cable path exactly as it was when a cable is connected", async () => {
    mockFetch({ connected: true, cable: true, iface: "eth0", online: true });
    render(<WifiStep onNext={vi.fn()} />);
    const primary = await screen.findByRole("button", { name: /wifi\.proceedEthernet/ });
    await waitFor(() => expect(primary).toBeEnabled());
    expect(screen.getByText("wifi.ethConnected")).toBeInTheDocument();
  });
});
