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
