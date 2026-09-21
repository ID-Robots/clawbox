// The step-3 credential-save overlay (and the shared ReconnectStage shell
// behind it) must wear the wizard's palette, not the off-palette near-black
// (#0d1117) it shipped with, and its ambient accent must follow the edition:
// a Hermes box waits in the agent's green (--agent-live), an OpenClaw box in
// coral (--coral-bright). The portal mounts on document.body — outside
// `.setup-shell` — so it must carry `data-agent="hermes"` itself for the
// Hermes token layer in globals.css to reach it.
import { describe, expect, it } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ReconnectStage from "@/components/ReconnectStage";
import CredentialsHandoffOverlay from "@/components/CredentialsHandoffOverlay";

function renderStage(hermes: boolean) {
  return render(
    <ReconnectStage
      hermes={hermes}
      steps={["Applying", "Rejoin", "Back online"]}
      phaseIndex={1}
      completed={false}
      title="Applying"
      description="Hold on."
      doneTone="cyan"
    />,
  );
}

const overlayRoot = () => screen.getByRole("status");

describe("ReconnectStage palette", () => {
  it("grounds the overlay in the wizard's --ground token, not the old hardcoded black", () => {
    renderStage(false);
    const root = overlayRoot();
    expect(root.className).toContain("reconnect-stage");
    expect(root.getAttribute("style") ?? "").toContain("var(--ground)");
    expect(root.getAttribute("style") ?? "").not.toContain("13, 17, 23");
  });

  it("keeps the coral accent on OpenClaw and carries no edition marker", () => {
    renderStage(false);
    const root = overlayRoot();
    expect(root.hasAttribute("data-agent")).toBe(false);
    const spinner = screen.getByTestId("reconnect-step-spinner");
    expect(spinner.className).toContain("--coral-bright");
    expect(spinner.className).not.toContain("--agent-live");
  });

  it("waits in the Hermes green on a Hermes box and marks the portal for the token layer", () => {
    renderStage(true);
    const root = overlayRoot();
    expect(root.getAttribute("data-agent")).toBe("hermes");
    const spinner = screen.getByTestId("reconnect-step-spinner");
    expect(spinner.className).toContain("--agent-live");
    expect(spinner.className).not.toContain("--coral-bright");
    // Rings and orbit dots included: nothing ambient may stay coral on Hermes.
    expect(root.querySelectorAll('[class*="--coral-bright"]').length).toBe(0);
  });
});

describe("CredentialsHandoffOverlay edition threading", () => {
  const base = {
    targetUrl: "http://clawbox.local/setup",
    sameOrigin: true,
    hotspotSsid: "ClawBox-Setup",
    onContinue: () => {},
  };

  it("hands hermes through to the shared stage", () => {
    render(<CredentialsHandoffOverlay {...base} hermes />);
    expect(overlayRoot().getAttribute("data-agent")).toBe("hermes");
  });

  it("defaults to the OpenClaw palette when no edition is passed", () => {
    render(<CredentialsHandoffOverlay {...base} hotspotSsid={null} />);
    const root = overlayRoot();
    expect(root.hasAttribute("data-agent")).toBe(false);
    expect(screen.getByTestId("reconnect-step-spinner").className).toContain("--coral-bright");
  });
});
