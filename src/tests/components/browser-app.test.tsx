import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserApp from "@/components/BrowserApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetBrowserAutoLaunch } from "@/lib/browser-auto-launch";

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
    // The automatic launch belongs to the desktop session rather than to a
    // mount (that is what the minimize test below is about), and a fact that
    // outlives a mount outlives a test too — every test here opens a fresh
    // desktop.
    resetBrowserAutoLaunch();
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

  /**
   * A mount is not an opening. ChromeWindow unmounts a minimized window's
   * children, so the guard that says "this window has had its go" cannot live
   * on the component: restoring a minimized Browser window used to start
   * Chromium again on the device's own screen.
   */
  it("does not start Chromium again when a minimized window is restored", async () => {
    const fetchMock = stubDevice({ ...READY_STATUS, browser: { running: false, cdpReady: false } });
    const first = render(<BrowserApp />);
    await waitFor(() => expect(postedActions(fetchMock)).toEqual(["open-browser"]));

    // Minimize (the desktop drops the children) and restore (they mount anew).
    first.unmount();
    const second = render(<BrowserApp />);

    await second.findByTestId("browser-state");
    await new Promise((r) => setTimeout(r, 60));
    expect(postedActions(fetchMock)).toEqual(["open-browser"]);
  });

  /**
   * And the case that made it matter: the owner closed the browser by hand.
   * A window that re-opened it on the next restore would be overruling them
   * on the appliance's own screen.
   */
  it("never re-opens a browser the owner closed, however often the window comes back", async () => {
    let running = true;
    const posted: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) return json({ active: "openclaw", edition: "openclaw" });
      if (url.includes("/setup-api/vnc")) return json({ available: true, wsPort: 6080 });
      if (url.includes("/setup-api/browser/manage") && init?.method === "POST") {
        const action = String(JSON.parse(String(init.body)).action);
        posted.push(action);
        running = action === "open-browser";
        return json({ ok: true });
      }
      if (url.includes("/setup-api/browser/manage")) {
        return json({ ...READY_STATUS, browser: { running, cdpReady: running, pid: 4242 } });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<BrowserApp />);
    fireEvent.click(await first.findByTestId("browser-close"));
    await waitFor(() => expect(posted).toEqual(["close-browser"]));

    first.unmount();
    const second = render(<BrowserApp />);

    // The strip offers the launch by hand, and nothing was posted behind it.
    await second.findByTestId("browser-open");
    await new Promise((r) => setTimeout(r, 60));
    expect(posted).toEqual(["close-browser"]);
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

  it("stops polling fast for a Chromium that came up but never bound its port", async () => {
    // "Starting" also means "a process exists that has not bound its port",
    // and that state can last for the life of the window. The manage route
    // spawns `chromium --version` and walks the process table on every read,
    // so the launch cadence must expire rather than become the standing one.
    const fetchMock = stubDevice({ ...READY_STATUS, browser: { running: true, pid: 4242, cdpReady: false } });
    const reads = () => fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/setup-api/browser/manage")
        && (init as RequestInit | undefined)?.method !== "POST",
    ).length;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BrowserApp />);
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(30_000);
      // 1.5 s apart while the launch is being followed.
      expect(reads()).toBeGreaterThan(10);

      // Past the window the launch earns, the cadence is the idle one: five
      // seconds, so half a minute is a handful of reads rather than twenty.
      await vi.advanceTimersByTimeAsync(30_000);
      const settled = reads();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reads() - settled).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
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
