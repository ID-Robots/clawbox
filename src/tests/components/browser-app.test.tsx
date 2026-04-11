import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserApp from "@/components/BrowserApp";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "browser.checkingStatus": "Checking browser status...",
        "browser.title": "Browser Integration",
        "browser.subtitle": "Real Chromium browser for OpenClaw AI",
        "browser.chromiumBrowser": "Chromium Browser",
        "browser.openclawIntegration": "OpenClaw Integration",
        "browser.desktopBrowser": "Desktop Browser",
        "browser.chromiumRequired": "Chromium is required.",
        "browser.enabledMessage": "Browser is connected to OpenClaw.",
        "browser.disabledMessage": "Connect the browser to OpenClaw.",
        "browser.launchMessage": "Launch a real Chromium window on the desktop that OpenClaw can control.",
        "browser.runningMessage": "Browser is already running.",
        "browser.installChromium": "Install Chromium",
        "browser.installing": "Installing...",
        "browser.enable": "Enable",
        "browser.enabling": "Enabling...",
        "browser.disable": "Disable",
        "browser.disabling": "Disabling...",
        "browser.openBrowser": "Open Browser",
        "browser.opening": "Opening...",
        "browser.closeBrowser": "Close Browser",
        "browser.closing": "Closing...",
        "browser.openInVNC": "Open in VNC",
        "browser.ready": "Ready",
        "browser.starting": "Starting",
      };
      return translations[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("BrowserApp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chromium: { installed: true, path: "/usr/bin/chromium-browser", version: "Chromium 146" },
        browser: { running: false, cdpReady: false },
        enabled: true,
        cdpPort: 18800,
      }),
    })));
  });

  it("shows the VNC button even before the desktop browser is running", async () => {
    const onOpenApp = vi.fn();
    const { getByRole } = render(<BrowserApp onOpenApp={onOpenApp} />);

    await waitFor(() => {
      expect(getByRole("button", { name: /Open Browser/i })).toBeInTheDocument();
    });

    const openVncButton = getByRole("button", { name: /Open in VNC/i });
    expect(openVncButton).toBeInTheDocument();

    fireEvent.click(openVncButton);
    expect(onOpenApp).toHaveBeenCalledWith("vnc");
  });
});
