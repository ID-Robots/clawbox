import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { KIOSK_BAR_EVENT, KIOSK_BAR_VAR, kioskBarInset, useKioskBarInset } from "@/lib/kiosk-bar-inset";

/**
 * The desktop's half of the kiosk bar (kiosk/extension/bar.js draws it; this
 * reads how tall it is). Nothing sets the variable on any browser but the
 * laptop's kiosk, so the inset is 0 there and the desktop's layout is the one
 * it always had.
 */

function Probe() {
  return <span data-testid="inset">{useKioskBarInset()}</span>;
}

afterEach(() => {
  document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
});

describe("kioskBarInset", () => {
  it("is 0 with no bar", () => {
    expect(kioskBarInset()).toBe(0);
  });

  it("reads the height the extension set on <html>", () => {
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
    expect(kioskBarInset()).toBe(40);
  });
});

describe("useKioskBarInset", () => {
  it("follows the bar as it shows and hides", () => {
    render(<Probe />);
    expect(screen.getByTestId("inset").textContent).toBe("0");
    act(() => {
      document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
      window.dispatchEvent(new Event(KIOSK_BAR_EVENT));
    });
    expect(screen.getByTestId("inset").textContent).toBe("40");
    act(() => {
      document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
      window.dispatchEvent(new Event(KIOSK_BAR_EVENT));
    });
    expect(screen.getByTestId("inset").textContent).toBe("0");
  });

  it("picks up a bar that was already up when it mounted", () => {
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
    render(<Probe />);
    expect(screen.getByTestId("inset").textContent).toBe("40");
  });
});
