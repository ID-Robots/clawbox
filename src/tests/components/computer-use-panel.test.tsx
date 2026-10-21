import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ComputerUsePanel from "@/components/ComputerUsePanel";

// The owner's switch for Hermes' desktop control, mounted in Settings beside
// the path guard. Dormant: with CLAWBOX_COMPUTER_USE_SETTING off its route is
// a 404 and the card draws nothing; on the OpenClaw edition it explains
// instead of offering a switch that would do nothing.

/** Let the mount effect's fetch settle before "draws nothing" is believed. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function serve(...answers: Array<[number, unknown]>) {
  const fetchMock = vi.fn();
  for (const [status, body] of answers) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComputerUsePanel", () => {
  it("draws nothing while the setting is off (the route's 404)", async () => {
    serve([404, { error: "not available", code: "setting_off" }]);
    const { container } = render(<ComputerUsePanel />);
    await settle();
    expect(container.querySelector("[data-testid=computer-use-panel]")).toBeNull();
  });

  it("explains, with no switch, on the OpenClaw edition", async () => {
    serve([200, { supported: false, state: null, enabled: false }]);
    render(<ComputerUsePanel />);
    await waitFor(() => expect(screen.getByTestId("computer-use-unsupported")).toBeTruthy());
    expect(screen.queryByTestId("computer-use-switch")).toBeNull();
  });

  it("shows an untouched Hermes box as on by default, and switches it off", async () => {
    const fetchMock = serve(
      [200, { supported: true, state: "unmanaged", enabled: true }],
      [200, { supported: true, state: "off", enabled: false, applied: { hermes: true, gatewayRestarted: null } }],
    );
    render(<ComputerUsePanel />);
    const sw = await screen.findByTestId("computer-use-switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    // The test i18n answers catalogue keys, which says exactly which line is drawn.
    expect(screen.getByTestId("computer-use-state").textContent).toBe("settings.computerUse.default");

    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByTestId("computer-use-switch").getAttribute("aria-checked")).toBe("false"));
    expect(fetchMock).toHaveBeenLastCalledWith("/setup-api/settings/computer-use", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    }));
    expect(screen.getByTestId("computer-use-state").textContent).toBe("settings.computerUse.off");
  });

  it("draws the saved state and the route's sentence when the apply failed", async () => {
    serve(
      [200, { supported: true, state: "off", enabled: false }],
      [502, { supported: true, state: "on", enabled: true, code: "apply_failed", error: "The next web-server start applies it." }],
    );
    render(<ComputerUsePanel />);
    fireEvent.click(await screen.findByTestId("computer-use-switch"));
    await waitFor(() => expect(screen.getByTestId("computer-use-failed").textContent).toContain("The next web-server start applies it."));
    expect(screen.getByTestId("computer-use-switch").getAttribute("aria-checked")).toBe("true");
  });
});
