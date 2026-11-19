import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WifiStep from "@/components/WifiStep";

/**
 * TASK-2702. A WiFi join the page can follow (Ethernet, or before the hotspot
 * drops) says what the box is doing — turning the radio on, switching — and,
 * once joined, where the box is now: the "Connected" dialog with the network,
 * the address it got there and its .local name. A failure says why. A page
 * that loses the box mid-switch hands over to the handoff overlay as before.
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
vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));
vi.mock("@/hooks/useDeviceAddress", () => ({
  useDeviceAddress: () => ({ localUrl: "http://clawbox.local", primaryUrl: "http://10.42.0.1" }),
}));
vi.mock("@/hooks/useReconnect", () => ({ useReconnect: () => "probing" }));

/** connect-status answers, one per poll; the last one repeats. `"down"` = the box is unreachable. */
function mockFetch(statuses: (Record<string, unknown> | "down")[]) {
  let polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/setup-api/wifi/ethernet")) return new Response(JSON.stringify({ connected: false, cable: false }));
    if (url.startsWith("/setup-api/wifi/connect-status")) {
      // The step's own on-mount look for an earlier failure.
      if (polls === 0 && !connectPosted) return new Response(JSON.stringify({ phase: "idle" }));
      const s = statuses[Math.min(polls++, statuses.length - 1)];
      if (s === "down") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(s));
    }
    if (url.startsWith("/setup-api/wifi/connect")) {
      connectPosted = true;
      return new Response(JSON.stringify({ status: "connecting" }));
    }
    return new Response("{}");
  }));
}
let connectPosted = false;

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function joinHomeNet() {
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /wifi\.useWifiInstead/ }));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /wifi\.otherNetwork/ }));
  fireEvent.change(screen.getByLabelText("wifi.networkName"), { target: { value: "HomeNet" } });
  fireEvent.change(screen.getByLabelText("wifi.password"), { target: { value: "home-pass-1" } });
  fireEvent.click(screen.getByRole("button", { name: "wifi.connect" }));
  await flush();
}

describe("WifiStep while the box switches to the owner's WiFi", () => {
  beforeEach(() => {
    connectPosted = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows each step, then the Connected dialog with the network, its address and the .local name", async () => {
    mockFetch([
      { phase: "connecting", ssid: "HomeNet", reason: null, message: "", step: "radio-on" },
      { phase: "connecting", ssid: "HomeNet", reason: null, message: "", step: "joining" },
      { phase: "connected", ssid: "HomeNet", reason: null, message: "ok", ip: "192.0.2.23" },
    ]);
    const onNext = vi.fn();
    render(<WifiStep onNext={onNext} />);
    await joinHomeNet();

    await flush(1000);
    expect(screen.getByText("wifi.stepRadioOn")).toBeInTheDocument();
    await flush(1500);
    expect(screen.getByText("wifi.handoffJoining:HomeNet…")).toBeInTheDocument();
    await flush(1500);

    const dialog = screen.getByTestId("wifi-connected-dialog");
    expect(dialog).toHaveTextContent("wifi.connectedTitle");
    expect(dialog).toHaveTextContent("HomeNet");
    expect(dialog).toHaveTextContent("192.0.2.23");
    expect(dialog).toHaveTextContent("clawbox.local");
    // This page could follow the whole switch: no handoff overlay over it.
    expect(screen.queryByText("wifi.handoffTitle")).toBeNull();
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "wifi.ok" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("wifi-connected-dialog")).toBeNull();
  });

  it("a radio that could not be turned on fails with the reason, not a bare sentence", async () => {
    mockFetch([
      { phase: "failed", ssid: "HomeNet", reason: "radio-off", message: "Not authorized to perform this operation" },
    ]);
    render(<WifiStep onNext={vi.fn()} />);
    await joinHomeNet();
    await flush(1000);

    expect(screen.getByText("wifi.radioOff:Not authorized to perform this operation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "wifi.connect" })).toBeEnabled();
  });

  it("any other failure names nmcli's reason", async () => {
    mockFetch([
      { phase: "failed", ssid: "HomeNet", reason: "other", message: "No network with SSID 'HomeNet' found." },
    ]);
    render(<WifiStep onNext={vi.fn()} />);
    await joinHomeNet();
    await flush(1000);

    expect(screen.getByText("wifi.connectionFailed:No network with SSID 'HomeNet' found.")).toBeInTheDocument();
  });

  it("losing the box mid-switch hands over to the overlay, and a later failure takes it down again", async () => {
    mockFetch(["down", { phase: "failed", ssid: "HomeNet", reason: "wrong-password", message: "Incorrect password" }]);
    render(<WifiStep onNext={vi.fn()} />);
    await joinHomeNet();

    await flush(1000);
    expect(screen.getByText("wifi.handoffTitle")).toBeInTheDocument();
    await flush(1500);
    expect(screen.queryByText("wifi.handoffTitle")).toBeNull();
    expect(screen.getByText("wifi.wrongPassword")).toBeInTheDocument();
  });
});
