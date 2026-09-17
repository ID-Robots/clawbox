/**
 * Settings → Remote Control, the TUNNEL URL field.
 *
 * The address was rendered into a one-line read-only <input> sized by `flex-1`
 * next to a `shrink-0` Copy button. A generated trycloudflare hostname is
 * longer than that box on the settings column, so the URL was clipped
 * mid-glyph with no ellipsis and no scrollbar — nothing said the rest of it
 * existed, and an owner reading the address off the screen typed a URL that
 * was never the whole one.
 *
 * It is text to be READ, so it wraps: the whole address is on screen, still
 * selectable, and Copy is still beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import RemoteControlPanel from "@/components/RemoteControlPanel";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

// The shape that started it: four hyphenated words in front of the domain.
const LONG_URL = "https://stat-door-tournament-resorts.trycloudflare.com";

const RUNNING_STATUS = {
  tunnel: { installed: true, service: "active", url: LONG_URL, history: [] },
  portalAddDeviceUrl: "https://clawbox.com/addDevice",
  portalWeb: "https://clawbox.com",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => RUNNING_STATUS }) as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPanel() {
  render(<RemoteControlPanel />);
  return await screen.findByTestId("remote-control-tunnel-url");
}

describe("RemoteControlPanel — the tunnel URL is shown whole", () => {
  it("renders the entire address, not a prefix of it", async () => {
    const url = await mountPanel();
    expect(url).toHaveTextContent(LONG_URL);
  });

  it("wraps instead of clipping: no truncation, and a break the hostname allows", async () => {
    const url = await mountPanel();
    // `break-all` is what lets a string with no spaces wrap at all; `truncate`
    // (overflow-hidden + text-ellipsis + whitespace-nowrap) is the opposite of
    // showing the whole thing and must not be here.
    expect(url.className).toContain("break-all");
    expect(url.className).not.toContain("truncate");
    expect(url.className).not.toContain("whitespace-nowrap");
    // Without `min-w-0` a flex child will not shrink below its content width,
    // which is what pushed the address under the button in the first place.
    expect(url.className).toContain("min-w-0");
  });

  it("keeps the text selectable rather than shipping an inert label", async () => {
    const url = await mountPanel();
    // `select-all` preserves the old input's click-selects-the-whole-address.
    expect(url.className).toContain("select-all");
  });

  it("keeps the Copy button beside it", async () => {
    await mountPanel();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "remoteControl.copy" })).toBeInTheDocument(),
    );
  });
});
