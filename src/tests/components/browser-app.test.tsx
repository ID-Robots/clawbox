import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserApp from "@/components/BrowserApp";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The Browser app's three faces and its one-click launch.
 *
 * The app IS the browser now: the home face shows the device's screen and
 * starts Chromium if it is not running. The cards it used to be live in the
 * settings page (browser-settings-panel.test.tsx) and the wizard
 * (browser-setup-wizard.test.tsx); what is pinned here is which face appears,
 * when the automatic launch fires, and — just as important — when it does not.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const table: Record<string, string> = {
        "browser.checkingStatus": "Checking browser status...",
        "browser.title": "Browser Integration",
        "browser.openSettings": "Settings",
        "browser.back": "Back",
        "browser.openBrowser": "Open Browser",
        "browser.opening": "Opening...",
        "browser.closeBrowser": "Close Browser",
        "browser.openInVNC": "Open in VNC",
        "browser.startingChromium": "Starting Chromium…",
        "browser.moveBrowsing": "Move it here",
        "browser.chromiumRequired": "Chromium is required.",
        "browser.errorNotServiceSafe": "Only the snap build is installed.",
        "browser.settings.notRunning": "Not running",
        "browser.settings.runningPid": `Running · PID ${params?.pid ?? ""}`,
        "browser.agentHeadlessMessage": "The assistant is browsing in its own background browser.",
      };
      return table[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The home face mounts the real VNCApp, which dynamically imports noVNC.
vi.mock("@novnc/novnc", () => ({
  default: class {
    disconnect = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    focus = vi.fn();
    blur = vi.fn();
    constructor(target: HTMLElement) { target.appendChild(document.createElement("canvas")); }
  },
}));

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  redirected: false,
  url: "http://localhost/",
  json: async () => body,
});

/**
 * Serve each route its own answer, so a test can describe a whole device
 * rather than one endpoint — the app reads four of them (the manage status,
 * the harness, the VNC screen and, on a write, the setup route).
 */
function stubDevice(status: Record<string, unknown>, harness = "openclaw") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.includes("/setup-api/harness/active")) return json({ active: harness, edition: harness });
    if (url.includes("/setup-api/browser/manage")) return json(status);
    if (url.includes("/setup-api/browser/setup")) return json({ setupComplete: true, autoOpen: true, startUrl: "https://www.google.com" });
    if (url.includes("/setup-api/vnc")) return json({ available: true, wsPort: 6080 });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const READY_STATUS = {
  chromium: { installed: true, path: "/usr/bin/chromium-browser", version: "Chromium 146", serviceSafe: true },
  browser: { running: true, pid: 4242, cdpReady: true },
  enabled: true,
  cdpPort: 18800,
  setupComplete: true,
  autoOpen: true,
  startUrl: "https://www.google.com",
};

const postedActions = (fetchMock: ReturnType<typeof stubDevice>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes("/setup-api/browser/manage") && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).action);

describe("BrowserApp", () => {
  beforeEach(() => {
    // The harness lookup is cached for the document's lifetime; without this a
    // later test would be answered from an earlier test's device.
    resetHarnessCache();
    stubDevice(READY_STATUS);
  });

  it("shows the device's screen, not a panel of steps", async () => {
    const { findByTestId, queryByRole } = render(<BrowserApp />);

    expect(await findByTestId("browser-state")).toHaveTextContent("Running · PID 4242");
    // The install/link cards moved to the settings page.
    expect(queryByRole("button", { name: /Install Chromium/i })).toBeNull();
  });

  it("opens the Remote Desktop window on request", async () => {
    const onOpenApp = vi.fn();
    const { findByTestId } = render(<BrowserApp onOpenApp={onOpenApp} />);

    fireEvent.click(await findByTestId("browser-open-vnc"));
    expect(onOpenApp).toHaveBeenCalledWith("vnc");
  });

  it("starts Chromium by itself when the app opens on a stopped browser", async () => {
    const fetchMock = stubDevice({ ...READY_STATUS, browser: { running: false, cdpReady: false } });
    render(<BrowserApp />);

    await waitFor(() => expect(postedActions(fetchMock)).toEqual(["open-browser"]));
  });

  it("says what it is doing while the launch is in flight", async () => {
    // The real route blocks for up to fifteen seconds; a POST that never
    // settles is what that looks like from here.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) return json({ active: "openclaw", edition: "openclaw" });
      if (url.includes("/setup-api/vnc")) return json({ available: true, wsPort: 6080 });
      if (url.includes("/setup-api/browser/manage") && init?.method === "POST") return new Promise(() => {});
      return json({ ...READY_STATUS, browser: { running: false, cdpReady: false } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { findByTestId } = render(<BrowserApp />);

    expect(await findByTestId("browser-starting-pill")).toHaveTextContent("Starting Chromium…");
  });

  it("launches once, however many times the status is re-read", async () => {
    const fetchMock = stubDevice({ ...READY_STATUS, browser: { running: false, cdpReady: false } });
    render(<BrowserApp />);

    await waitFor(() => expect(postedActions(fetchMock)).toEqual(["open-browser"]));
    await new Promise((r) => setTimeout(r, 60));
    expect(postedActions(fetchMock)).toEqual(["open-browser"]);
  });

  it("does not launch when the owner switched that off", async () => {
    const fetchMock = stubDevice({ ...READY_STATUS, browser: { running: false, cdpReady: false }, autoOpen: false });
    const { findByTestId } = render(<BrowserApp />);

    await findByTestId("browser-open");
    expect(postedActions(fetchMock)).toEqual([]);
  });

  /**
   * `open-browser` terminates the headless browser holding the CDP port. That
   * is fair when a person presses the button and not fair as a side effect of
   * the agent's own `ui_open_app("browser")`, so the window offers the action
   * instead of taking it.
   */
  it("does not take the browser away from the agent by itself", async () => {
    const fetchMock = stubDevice({
      ...READY_STATUS,
      browser: { running: false, cdpReady: true, agentBrowsing: true },
    });
    const { findByTestId } = render(<BrowserApp />);

    const move = await findByTestId("browser-move-browsing");
    expect(postedActions(fetchMock)).toEqual([]);

    fireEvent.click(move);
    await waitFor(() => expect(postedActions(fetchMock)).toEqual(["open-browser"]));
  });

  it("does not try to launch a Chromium a system service cannot start", async () => {
    const fetchMock = stubDevice({
      ...READY_STATUS,
      chromium: { installed: true, path: "/snap/bin/chromium", serviceSafe: false },
      browser: { running: false, cdpReady: false },
    });
    const { findByTestId } = render(<BrowserApp />);

    expect(await findByTestId("browser-cannot-run")).toHaveTextContent("Only the snap build is installed.");
    expect(postedActions(fetchMock)).toEqual([]);
  });

  it("shows the wizard until the owner has been through it, and never auto-launches under it", async () => {
    const fetchMock = stubDevice({
      ...READY_STATUS,
      browser: { running: false, cdpReady: false },
      setupComplete: false,
    });
    const { findByTestId, queryByTestId } = render(<BrowserApp />);

    expect(await findByTestId("browser-wizard")).toBeInTheDocument();
    expect(queryByTestId("browser-state")).toBeNull();
    expect(postedActions(fetchMock)).toEqual([]);
  });

  it("keeps the browser screen when the flag is absent on an already-working box", async () => {
    const { setupComplete, ...noFlag } = READY_STATUS;
    void setupComplete;
    stubDevice(noFlag);
    const { findByTestId, queryByTestId } = render(<BrowserApp />);

    await findByTestId("browser-state");
    expect(queryByTestId("browser-wizard")).toBeNull();
  });

  it("switches to the settings page and back", async () => {
    const { findByTestId, queryByTestId } = render(<BrowserApp />);

    fireEvent.click(await findByTestId("browser-open-settings"));
    expect(await findByTestId("browser-settings-panel")).toBeInTheDocument();
    expect(queryByTestId("browser-state")).toBeNull();

    fireEvent.click(await findByTestId("browser-settings-back"));
    expect(await findByTestId("browser-state")).toBeInTheDocument();
  });

  it("says what went wrong, in this device's words, when a launch is refused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) return json({ active: "openclaw", edition: "openclaw" });
      if (url.includes("/setup-api/vnc")) return json({ available: true, wsPort: 6080 });
      if (url.includes("/setup-api/browser/manage") && init?.method === "POST") {
        return { ok: false, status: 400, json: async () => ({ error: "Chromium not installed", code: "chromium_not_service_safe" }) };
      }
      return json({ ...READY_STATUS, browser: { running: false, cdpReady: false } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { findByTestId, findAllByText } = render(<BrowserApp />);

    fireEvent.click(await findByTestId("browser-open"));
    // The stable code, said in the owner's language — not the route's English.
    expect((await findAllByText("Only the snap build is installed.")).length).toBeGreaterThan(0);
  });
});
