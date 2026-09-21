/**
 * Settings → Remote Control on a box running its NAMED tunnel: the address is
 * the box's permanent `<boxHandle>.clawbox.tech`, labelled as such, and there
 * is no "Regenerate Tunnel URL" — a restart would come back on the same name.
 * On the quick tunnel (and on a server that predates `mode`) nothing changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import RemoteControlPanel from "@/components/RemoteControlPanel";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";

function serve(tunnel: Record<string, unknown>) {
  const status = { tunnel, portalAddDeviceUrl: "https://clawbox.com/addDevice", portalWeb: "https://clawbox.com" };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => status }) as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RemoteControlPanel — named tunnel", () => {
  it("shows the permanent hostname under its own label, with no regenerate button", async () => {
    serve({ installed: true, service: "active", url: `https://${HOST}`, history: [], mode: "named", hostname: HOST });
    render(<RemoteControlPanel />);
    expect(await screen.findByTestId("remote-control-tunnel-url")).toHaveTextContent(`https://${HOST}`);
    expect(screen.getByText("remoteControl.namedUrlLabel")).toBeInTheDocument();
    expect(screen.getByTestId("remote-control-named-desc")).toHaveTextContent("remoteControl.namedUrlDesc");
    expect(screen.queryByText("remoteControl.tunnelUrlLabel")).toBeNull();
    expect(screen.queryByText("remoteControl.regenerate")).toBeNull();
  });

  it("keeps the existing copy on the quick tunnel", async () => {
    serve({ installed: true, service: "active", url: "https://abc.trycloudflare.com", history: [], mode: "quick", hostname: null });
    render(<RemoteControlPanel />);
    await screen.findByTestId("remote-control-tunnel-url");
    expect(screen.getByText("remoteControl.tunnelUrlLabel")).toBeInTheDocument();
    expect(screen.getByText("remoteControl.regenerate")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-control-named-desc")).toBeNull();
  });

  it("keeps the existing copy when the server does not report a mode", async () => {
    serve({ installed: true, service: "active", url: "https://abc.trycloudflare.com", history: [] });
    render(<RemoteControlPanel />);
    await screen.findByTestId("remote-control-tunnel-url");
    expect(screen.getByText("remoteControl.regenerate")).toBeInTheDocument();
  });
});
