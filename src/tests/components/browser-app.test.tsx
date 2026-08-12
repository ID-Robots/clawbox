import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserApp from "@/components/BrowserApp";
import { resetHarnessCache } from "@/lib/client-harness";

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
        "browser.builtInMessage": "Browsing is built into this edition.",
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

/**
 * Serve the status route the given payload and the harness route the given
 * harness, so a test can describe a whole device rather than one endpoint.
 */
function stubDevice(status: Record<string, unknown>, harness = "openclaw") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: harness, edition: harness }) };
    }
    return { ok: true, json: async () => status };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const READY_STATUS = {
  chromium: { installed: true, path: "/usr/bin/chromium-browser", version: "Chromium 146" },
  browser: { running: false, cdpReady: false },
  enabled: true,
  cdpPort: 18800,
};

describe("BrowserApp", () => {
  beforeEach(() => {
    // The harness lookup is cached for the document's lifetime; without this a
    // later test would be answered from an earlier test's device.
    resetHarnessCache();
    stubDevice(READY_STATUS);
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

  describe("when the integration is a switch", () => {
    it("offers the toggle", async () => {
      const { getByRole } = render(<BrowserApp />);

      await waitFor(() => {
        expect(getByRole("button", { name: /Disable/i })).toBeInTheDocument();
      });
    });

    it("describes the link as a connection that was made", async () => {
      const { findByText } = render(<BrowserApp />);
      expect(await findByText(/Browser is connected to OpenClaw\./)).toBeInTheDocument();
    });

    it("shows the OpenClaw tools profile it wrote", async () => {
      const { findByText } = render(<BrowserApp />);
      expect(await findByText("tools profile: full")).toBeInTheDocument();
    });
  });

  // On an edition with no OpenClaw CLI the link is permanent, so a toggle here
  // would be a control with nothing to control — and, before this, one whose
  // only possible outcome was an error banner.
  describe("when the integration is always on", () => {
    beforeEach(() => {
      stubDevice({ ...READY_STATUS, alwaysOn: true }, "hermes");
    });

    it("offers no toggle", async () => {
      const { queryByRole, findByRole } = render(<BrowserApp />);

      // Wait for the panel to finish loading before asserting an absence.
      await findByRole("button", { name: /Open Browser/i });

      expect(queryByRole("button", { name: /^Enable$/i })).toBeNull();
      expect(queryByRole("button", { name: /^Disable$/i })).toBeNull();
    });

    it("says the capability is built in rather than connected", async () => {
      const { findByText, queryByText } = render(<BrowserApp />);

      expect(await findByText(/Browsing is built into this edition\./)).toBeInTheDocument();
      expect(queryByText(/Browser is connected to OpenClaw\./)).toBeNull();
    });

    it("names the tools the agent actually holds instead of an OpenClaw config key", async () => {
      const { findByText, queryByText } = render(<BrowserApp />);

      expect(await findByText(/browser_open/)).toBeInTheDocument();
      expect(queryByText("tools profile: full")).toBeNull();
    });

    it("still lets the owner open the desktop browser", async () => {
      const { findByRole } = render(<BrowserApp />);
      expect(await findByRole("button", { name: /Open Browser/i })).toBeInTheDocument();
    });
  });
});
