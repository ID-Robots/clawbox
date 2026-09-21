import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import RemoteControlPanel from "@/components/RemoteControlPanel";

vi.mock("@/lib/i18n", () => ({
  useT: (() => {
    const strings: Record<string, string> = {
      "remoteControl.addDevice": "Add device for quick access",
      "remoteControl.regenerate": "Regenerate Tunnel URL",
    };
    const t = (key: string) => strings[key] ?? key;
    return () => ({ t });
  })(),
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The pair under the Tunnel URL split on the VIEWPORT (`sm:grid-cols-2`), not
 * on the space it actually had: inside Settings' 576px column each cell was
 * 263px, which wrapped "Add device for quick access" to three lines beside a
 * one-line neighbour stretched to match it.
 */
describe("Remote Control action pair", () => {
  it("splits into two columns only when a column fits its label", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tunnel: { installed: true, service: "active", url: "https://tunnel.example.com" },
        portalAddDeviceUrl: "https://clawbox.com/addDevice",
        portalWeb: "https://clawbox.com",
      }),
    })));

    render(<RemoteControlPanel />);

    const addDevice = await screen.findByRole("link", { name: /Add device for quick access/ });
    const regenerate = screen.getByRole("button", { name: /Regenerate Tunnel URL/ });
    const pair = addDevice.parentElement!;
    expect(pair).toContainElement(regenerate);

    // jsdom has no layout, so the track definition is the assertion: the pair
    // wraps to one full-width column below 18rem per cell instead of squeezing
    // both onto a viewport-derived half.
    expect(pair.className).toContain("grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))]");
    expect(pair.className).not.toContain("sm:grid-cols-2");
  });
});
