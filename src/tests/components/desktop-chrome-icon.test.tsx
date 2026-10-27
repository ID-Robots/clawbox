import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";

// The Google Chrome icon in Monitor Mode (src/lib/desktop-chrome-client.ts).
// On the ClawBox Desktop session's own screen the icon is drawn whether or not
// the box has a Chrome to start: with one a click opens it exactly as before,
// without one the click raises a toast that says Chrome is not installed and
// how to get it — never the kiosk's own browser, never a dead icon. Off that
// session there is no icon at all.

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => null,
  CHAT_PANEL_GAP: 12,
  noticeColumnInset: () => 0,
}));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const OWNER = { username: "clawbox", isOwner: true, multiUser: false };
const CHROME_ICON = '[data-desktop-icon-id="desktop-chrome"]';

/** What GET /setup-api/desktop/chrome answers, and what the POST answers. */
let status: unknown = { available: false };
let launch: { status: number; body: unknown } = { status: 200, body: { available: true, ok: true, survivesRestart: true } };

function answer(body: unknown, statusCode = 200) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/desktop/chrome")) {
      return (init?.method ?? "GET").toUpperCase() === "POST" ? answer(launch.body, launch.status) : answer(status);
    }
    if (url.includes("/setup-api/users/me")) return answer(OWNER);
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return answer({});
  }));
  fetchStub = vi.mocked(fetch);
}

// The desktop wraps `fetch` while it is mounted (src/lib/session-expiry.ts),
// so the stub is read through its own reference.
let fetchStub = vi.mocked(fetch);

/** The POSTs that asked the server to start Chrome, by body. */
function launches(): unknown[] {
  return fetchStub.mock.calls
    .filter(([input, init]) => String(input).includes("/setup-api/desktop/chrome") && (init?.method ?? "GET").toUpperCase() === "POST")
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")));
}

/**
 * The icon, once the desktop's copy has loaded (a lazy chunk): until then
 * every label is its raw key, and so would the toast a click raises be.
 */
async function chromeIcon(): Promise<HTMLButtonElement> {
  await waitFor(() => expect(document.querySelector(`${CHROME_ICON} button`)).not.toBeNull());
  // No word boundary: textContent runs the labels together ("…Chromeapp.terminal").
  await waitFor(() => expect(document.body.textContent ?? "").not.toMatch(/app\.[a-z][A-Za-z]+/));
  return document.querySelector<HTMLButtonElement>(`${CHROME_ICON} button`)!;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let windowOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
  status = { available: false };
  launch = { status: 200, body: { available: true, ok: true, survivesRestart: true } };
  installFetch();
  windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  // The preference writer's debounced flush, so it lands in this case.
  await wait(650);
  windowOpen.mockRestore();
  vi.unstubAllGlobals();
});

describe("the Google Chrome icon in Monitor Mode", () => {
  it("is drawn with no Chrome on the box, and a click says it is not installed and how to get it", async () => {
    status = { available: true, installed: false };
    launch = {
      status: 503,
      body: { available: true, installed: false, ok: false, error: "Google Chrome is not installed on this ClawBox", code: "not_installed" },
    };
    render(<ChromeDesktop />);
    const icon = await chromeIcon();
    expect(icon.textContent).toContain("Google Chrome");

    fireEvent.click(icon);
    // What is missing, and the one command that installs it.
    expect(await screen.findByText(/Google Chrome is not installed/)).toBeInTheDocument();
    expect(screen.getByText(/sudo bash install\.sh --step google_chrome_install/)).toBeInTheDocument();
    // Nothing opened in its place: the kiosk's own browser is not Chrome.
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("says the same when the server cannot be reached for an icon drawn as missing", async () => {
    status = { available: true, installed: false };
    render(<ChromeDesktop />);
    const icon = await chromeIcon();
    fetchStub.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(icon);
    expect(await screen.findByText(/Google Chrome is not installed/)).toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("opens Chrome exactly as before when it is installed — no toast, no fallback window", async () => {
    status = { available: true, installed: true };
    render(<ChromeDesktop />);
    fireEvent.click(await chromeIcon());
    await waitFor(() => expect(launches()).toEqual([{}]));
    await wait(50);
    expect(screen.queryByText(/Google Chrome is not installed/)).toBeNull();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("opens a Chrome installed since the page loaded, on the next click", async () => {
    status = { available: true, installed: false };
    render(<ChromeDesktop />);
    fireEvent.click(await chromeIcon());
    await waitFor(() => expect(launches()).toEqual([{}]));
    await wait(50);
    expect(screen.queryByText(/Google Chrome is not installed/)).toBeNull();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("does not call a Chrome installed since the page loaded 'not installed' when it fails to start", async () => {
    status = { available: true, installed: false };
    launch = {
      status: 500,
      body: { available: true, ok: false, error: "Google Chrome could not be started: EACCES", code: "launch_failed" },
    };
    render(<ChromeDesktop />);
    fireEvent.click(await chromeIcon());
    // The ordinary fallback for a launch that failed, as for an icon drawn as installed.
    await waitFor(() => expect(windowOpen).toHaveBeenCalledWith("https://www.google.com/", "_blank", "noopener"));
    expect(screen.queryByText(/Google Chrome is not installed/)).toBeNull();
  });

  it("is not drawn off the ClawBox Desktop session", async () => {
    status = { available: false };
    render(<ChromeDesktop />);
    await waitFor(() => expect(fetchStub.mock.calls.some(([input]) => String(input).includes("/setup-api/desktop/chrome"))).toBe(true));
    expect(await screen.findByTestId("desktop-surface")).toBeInTheDocument();
    await wait(100);
    expect(document.querySelector(CHROME_ICON)).toBeNull();
  });
});
