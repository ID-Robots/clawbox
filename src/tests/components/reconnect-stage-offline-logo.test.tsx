// The reconnect overlay's logo must render with the box's server already gone.
//
// ReconnectStage is the shell behind ReconnectingOverlay, WifiHandoffOverlay
// and CredentialsHandoffOverlay — every one of which is on screen *because*
// the box is restarting (an update reboot) or moving networks (the AP-to-LAN
// handoff after WiFi credentials are saved). It used to draw the mascot with
// `next/image src="/clawbox-crab.png"`, which the browser resolves to a
// `/_next/image?url=...` request against the very server that is down, so the
// one screen that exists to reassure the user showed a broken-image icon and
// the alt text "ClawBox". The other usages (SetupWizard step 1, WifiStep,
// /login) never hit this because the server is up when they mount.
//
// These tests pin the fix at the level that actually matters: whatever the
// overlay paints must need zero network.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@/tests/helpers/test-utils";
import ReconnectStage from "@/components/ReconnectStage";
import { CLAWBOX_CRAB_DATA_URI } from "@/lib/clawbox-crab-inline";

function renderOverlay(completed = false) {
  return render(
    <ReconnectStage
      steps={["Saving", "Restarting", "Back online"]}
      phaseIndex={1}
      completed={completed}
      title="Reconnecting"
      description="Your ClawBox is restarting."
    />,
  );
}

/**
 * The rule is about the SCREEN, not about one component: anything on display
 * while the box's own server is down must need zero network. There are two such
 * screens and they were fixed a year apart, because the second was never
 * looked for — the power menu's "Restarting" overlay drew the same mascot with
 * the same `next/image`, and it is the one screen guaranteed to be watched
 * through an outage. Read from the source so a third cannot be added quietly.
 */
describe("every screen that outlives the server", () => {
  it("draws the restart overlay's mascot without asking the server for it", () => {
    const tray = readFileSync(join(process.cwd(), "src", "components", "SystemTray.tsx"), "utf-8");
    expect(tray).toContain("CrabWaitMark");
    expect(tray).not.toMatch(/from "next\/image"/);
    expect(tray).not.toMatch(/<Image[\s\S]{0,200}clawbox-crab\.png/);
  });
});

describe("ReconnectStage offline logo", () => {
  it("renders the mascot from an inline data URI, not a server path", () => {
    renderOverlay();
    const logo = screen.getByTestId("reconnect-logo") as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe(CLAWBOX_CRAB_DATA_URI);
    expect(logo.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it("requests nothing over the network anywhere in the overlay", () => {
    renderOverlay();
    // Anything the browser would have to fetch — a bare public path, the
    // next/image optimizer endpoint, or an absolute URL — puts the overlay
    // back at the mercy of the server it is waiting for.
    const sourced = Array.from(
      document.body.querySelectorAll("img, image, source, use, iframe"),
    );
    expect(sourced.length).toBeGreaterThan(0);
    for (const el of sourced) {
      for (const attr of ["src", "srcset", "href", "xlink:href"]) {
        const value = el.getAttribute(attr);
        if (value === null) continue;
        expect(value).toMatch(/^data:/);
      }
    }
  });

  it("keeps the mascot's sizing and ring layout unchanged", () => {
    renderOverlay();
    const logo = screen.getByTestId("reconnect-logo");
    // 52px: the tight square artwork drawn at this size is ~50px wide and
    // ~40px tall — the footprint the old padded 100px render (62x52 px of
    // crab in an 87x128 image) had inside the 64px ring.
    expect(logo).toHaveAttribute("width", "52");
    expect(logo).toHaveAttribute("height", "52");
    // Asserted as the rendered SIZE rather than as `h-[52px] w-[52px]`: the
    // mark scales with its `size` prop now (CrabWaitMark), so the dimensions
    // are computed and cannot be fixed Tailwind classes. 52px is still what a
    // default-size overlay draws — the property this test is about — and it is
    // pinned here in the one place that survives the mark being reused smaller.
    expect(logo.style.width).toBe("52px");
    expect(logo.style.height).toBe("52px");
    expect(logo.className).toContain("object-contain");
  });

  it("swaps the mascot for the inline success check when completed", () => {
    renderOverlay(true);
    expect(screen.queryByTestId("reconnect-logo")).toBeNull();
    expect(document.body.querySelector("svg")).toBeTruthy();
  });

  it("inlines the real crab PNG byte-for-byte", () => {
    // Drift guard: the data URI is generated from the asset on disk by
    // scripts/generate-crab-inline.mjs. If someone updates the artwork and
    // forgets to rerun it, the overlay silently keeps the old mascot.
    const png = readFileSync(join(process.cwd(), "public", "clawbox-crab.png"));
    const inlined = Buffer.from(
      CLAWBOX_CRAB_DATA_URI.replace(/^data:image\/png;base64,/, ""),
      "base64",
    );
    expect(inlined.equals(png)).toBe(true);
  });
});
