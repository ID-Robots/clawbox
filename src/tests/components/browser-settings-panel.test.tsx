import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserSettingsPanel, { type BrowserStatus } from "@/components/BrowserSettingsPanel";

/**
 * The Browser app's embedded settings page.
 *
 * Every control here has to write something that exists: the manage route's
 * actions, or the owner's three settings. What is pinned is that each one
 * posts what it says it does, that the edition without an agent-link switch is
 * not offered one, and that "show the setup again" clears the FLAG and nothing
 * else — a half-cleared state would put the wizard over a live link.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function stubDevice() {
  const fetchMock = vi.fn(async (input?: RequestInfo | URL, init?: RequestInit) => {
    void input; void init;
    return json({ ok: true, setupComplete: false, autoOpen: true, startUrl: "https://www.google.com" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const setupPosts = (fetchMock: ReturnType<typeof stubDevice>) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/setup-api/browser/setup"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const STATUS: BrowserStatus = {
  chromium: { installed: true, path: "/usr/bin/chromium-browser", version: "Chromium 146", serviceSafe: true },
  browser: { running: false, cdpReady: false },
  enabled: true,
  cdpPort: 18800,
  setupComplete: true,
  autoOpen: true,
  startUrl: "https://www.google.com",
};

function renderPanel(status: BrowserStatus = STATUS, extra: Partial<Parameters<typeof BrowserSettingsPanel>[0]> = {}) {
  const props = {
    status,
    harnessLabel: "OpenClaw",
    actionLoading: null,
    onAction: vi.fn(),
    onChanged: vi.fn(),
    onOpenVnc: vi.fn(),
    onShowWizard: vi.fn(),
    ...extra,
  };
  return { props, ...render(<BrowserSettingsPanel {...props} />) };
}

describe("BrowserSettingsPanel", () => {
  let fetchMock: ReturnType<typeof stubDevice>;
  beforeEach(() => { fetchMock = stubDevice(); });

  it("runs the manage actions through the app that owns the spinner", async () => {
    const { props, getByTestId } = renderPanel();

    fireEvent.click(getByTestId("browser-settings-power"));
    expect(props.onAction).toHaveBeenCalledWith("open-browser");

    fireEvent.click(getByTestId("browser-settings-install"));
    expect(props.onAction).toHaveBeenCalledWith("install-chromium");

    fireEvent.click(getByTestId("browser-settings-link"));
    expect(props.onAction).toHaveBeenCalledWith("disable");
  });

  it("saves the auto-open switch", async () => {
    const { props, getByTestId } = renderPanel();

    fireEvent.click(getByTestId("browser-settings-auto-open"));

    await waitFor(() => expect(setupPosts(fetchMock)).toEqual([{ autoOpen: false }]));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("saves the start page", async () => {
    const { getByTestId } = renderPanel();

    fireEvent.change(getByTestId("browser-settings-start-url"), { target: { value: "https://example.com/" } });
    fireEvent.click(getByTestId("browser-settings-start-url-save"));

    await waitFor(() => expect(setupPosts(fetchMock)).toEqual([{ startUrl: "https://example.com/" }]));
  });

  it("shows the device's refusal of a start page in the owner's words", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "nope", code: "bad_start_url" }) } as never);
    const { getByTestId, findByText } = renderPanel();

    fireEvent.change(getByTestId("browser-settings-start-url"), { target: { value: "ftp://example.com/" } });
    fireEvent.click(getByTestId("browser-settings-start-url-save"));

    expect(await findByText("browser.errorStartUrl")).toBeInTheDocument();
  });

  it("warns about a Chromium a system service cannot start", () => {
    const { getByTestId } = renderPanel({
      ...STATUS,
      chromium: { installed: true, path: "/snap/bin/chromium", serviceSafe: false },
    });

    expect(getByTestId("browser-settings-snap-warning")).toBeInTheDocument();
  });

  /**
   * TASK-1480: which browser "the browser" is comes from the device — the
   * owner may have pointed it at a profile and port of their own — and a
   * browser they started is opened (brought forward), never closed, from here.
   */
  it("names the configured profile and port, and offers Open for a browser the owner started", () => {
    const { getByText, getByTestId, props } = renderPanel({
      ...STATUS,
      cdpPort: 9222,
      profileDir: "/home/clawbox/.config/google-chrome-debug",
      ownProfile: false,
      browser: { running: true, pid: 4242, cdpReady: true, external: true },
    });

    expect(getByText("CDP :9222")).toBeInTheDocument();
    expect(getByText("/home/clawbox/.config/google-chrome-debug/")).toBeInTheDocument();
    fireEvent.click(getByTestId("browser-settings-power"));
    expect(props.onAction).toHaveBeenCalledWith("open-browser");
  });

  /**
   * One browser per box: the window is the assistant's browser too and is kept
   * running, so the panel says so, offers Open (bring it forward) and never
   * Close, and drops the open-by-itself switch that no longer decides anything.
   */
  it("says the browser is shared with the assistant and offers no Close for it", () => {
    const { getByTestId, queryByTestId, props } = renderPanel({
      ...STATUS,
      sharedWithAssistant: true,
      browser: { running: true, pid: 4242, cdpReady: true, shared: true },
    });

    expect(getByTestId("browser-settings-shared")).toHaveTextContent("browser.settings.sharedHint");
    expect(queryByTestId("browser-settings-legacy-profile")).toBeNull();
    expect(queryByTestId("browser-settings-auto-open")).toBeNull();
    fireEvent.click(getByTestId("browser-settings-power"));
    expect(props.onAction).toHaveBeenCalledWith("open-browser");
  });

  it("tells the owner where the assistant's old profile is when its sign-ins did not come along", () => {
    const { getByTestId } = renderPanel({
      ...STATUS,
      sharedWithAssistant: true,
      legacyAgentProfile: "/home/clawbox/.openclaw/browser/openclaw/user-data",
      browser: { running: true, pid: 4242, cdpReady: true, shared: true },
    });

    expect(getByTestId("browser-settings-legacy-profile")).toHaveTextContent("browser.settings.legacyProfileNote");
  });

  it("keeps Close and the open-by-itself switch where the assistant has a browser of its own", () => {
    const { getByTestId, queryByTestId, props } = renderPanel({
      ...STATUS,
      sharedWithAssistant: false,
      browser: { running: true, pid: 4242, cdpReady: true },
    });

    expect(queryByTestId("browser-settings-shared")).toBeNull();
    expect(getByTestId("browser-settings-auto-open")).toBeInTheDocument();
    fireEvent.click(getByTestId("browser-settings-power"));
    expect(props.onAction).toHaveBeenCalledWith("close-browser");
  });

  it("still names ClawBox's own profile on a box that reports none", () => {
    const { getByText } = renderPanel();
    expect(getByText("~/.config/clawbox-browser/")).toBeInTheDocument();
  });

  it("offers no agent-link switch where the link is permanent", () => {
    const { queryByTestId } = renderPanel({ ...STATUS, alwaysOn: true });
    expect(queryByTestId("browser-settings-link")).toBeNull();
  });

  it("puts the wizard back by clearing the flag alone", async () => {
    const { props, getByTestId } = renderPanel();

    fireEvent.click(getByTestId("browser-settings-show-wizard"));

    await waitFor(() => expect(setupPosts(fetchMock)).toEqual([{ setupComplete: false }]));
    expect(props.onShowWizard).toHaveBeenCalled();
    // Nothing was disconnected on the way.
    expect(props.onAction).not.toHaveBeenCalled();
  });
});
