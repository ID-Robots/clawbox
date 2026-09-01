import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import RemoteControlPanel from "@/components/RemoteControlPanel";

vi.mock("@/lib/i18n", () => ({
  useT: (() => {
    const strings: Record<string, string> = {
      "remoteControl.loadFailed": "Failed to load status",
      "remoteControl.tunnelInstallButton": "Install Cloudflare Tunnel",
    };
    const t = (key: string) => strings[key] ?? key;
    return () => ({ t });
  })(),
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RemoteControlPanel status availability", () => {
  it("does not offer tunnel installation when status cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => null,
    })));

    render(<RemoteControlPanel />);

    expect(await screen.findByText("Failed to load status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install Cloudflare Tunnel/ })).toBeNull();
  });

  it("offers tunnel installation only after status explicitly reports it absent", async () => {
    const absentStatus = {
      tunnel: { installed: false, service: "inactive", url: null },
      portalAddDeviceUrl: "https://clawbox.com/addDevice",
      portalWeb: "https://clawbox.com",
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => absentStatus,
    })));

    render(<RemoteControlPanel />);

    expect(await screen.findByRole("button", { name: /Install Cloudflare Tunnel/ }))
      .toBeInTheDocument();
  });
});
