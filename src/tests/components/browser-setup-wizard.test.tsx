import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import BrowserSetupWizard from "@/components/BrowserSetupWizard";
import type { BrowserStatus } from "@/components/BrowserSettingsPanel";

/**
 * The Browser app's first-run wizard.
 *
 * What is pinned: the flag is written ONLY at the end (an owner interrupted
 * halfway must come back to the wizard, not to a half-configured app), the
 * agent-link step does not exist on an edition where the link is permanent,
 * and neither way out of the front door leaves the owner stuck.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function stubDevice() {
  const fetchMock = vi.fn(async (input?: RequestInfo | URL, init?: RequestInit) => {
    void input; void init;
    return json({ ok: true } as unknown);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const posts = (fetchMock: ReturnType<typeof stubDevice>, path: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes(path))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const STATUS: BrowserStatus = {
  chromium: { installed: true, path: "/usr/bin/chromium-browser", version: "Chromium 146", serviceSafe: true },
  browser: { running: false, cdpReady: false },
  enabled: false,
  cdpPort: 18800,
  setupComplete: false,
  autoOpen: true,
  startUrl: "https://www.google.com",
};

describe("BrowserSetupWizard", () => {
  let fetchMock: ReturnType<typeof stubDevice>;
  beforeEach(() => { fetchMock = stubDevice(); });

  it("leads with what the browser is, in a picture and a sentence", async () => {
    const { getByTestId, getByText } = render(
      <BrowserSetupWizard status={STATUS} harnessLabel="OpenClaw" onChanged={vi.fn()} onDone={vi.fn()} />,
    );

    expect(getByTestId("browser-art")).toHaveAttribute("aria-hidden", "true");
    expect(getByText("browser.setup.introTitle")).toBeInTheDocument();
  });

  it("walks Chromium, the agent link, then opening it — and only then finishes", async () => {
    const onDone = vi.fn();
    const { getByTestId, findByTestId } = render(
      <BrowserSetupWizard status={STATUS} harnessLabel="OpenClaw" onChanged={vi.fn()} onDone={onDone} />,
    );

    fireEvent.click(getByTestId("browser-wizard-start"));
    expect(await findByTestId("browser-wizard-chromium-ready")).toBeInTheDocument();
    // Nothing is written on the way through: the flag is the last step's job.
    expect(posts(fetchMock, "/setup-api/browser/setup")).toEqual([]);

    fireEvent.click(getByTestId("browser-wizard-next"));
    fireEvent.click(await findByTestId("browser-wizard-link"));
    await waitFor(() => expect(posts(fetchMock, "/setup-api/browser/manage")).toEqual([{ action: "enable" }]));

    fireEvent.click(getByTestId("browser-wizard-next-open"));
    fireEvent.click(await findByTestId("browser-wizard-open"));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(posts(fetchMock, "/setup-api/browser/manage")).toEqual([{ action: "enable" }, { action: "open-browser" }]);
    expect(posts(fetchMock, "/setup-api/browser/setup")).toEqual([{ setupComplete: true }]);
  });

  it("has no agent-link step where the link is permanent", async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(
      <BrowserSetupWizard status={{ ...STATUS, alwaysOn: true, enabled: true }} harnessLabel="Hermes" onChanged={vi.fn()} onDone={vi.fn()} />,
    );

    fireEvent.click(getByTestId("browser-wizard-start"));
    fireEvent.click(await findByTestId("browser-wizard-next"));

    expect(await findByTestId("browser-wizard-open")).toBeInTheDocument();
    expect(queryByTestId("browser-wizard-link")).toBeNull();
  });

  it("offers to install a Chromium a system service cannot start, and gates Next on having one at all", async () => {
    const { getByTestId, findByTestId, rerender } = render(
      <BrowserSetupWizard
        status={{ ...STATUS, chromium: { installed: false } }}
        harnessLabel="OpenClaw"
        onChanged={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(getByTestId("browser-wizard-start"));
    expect(await findByTestId("browser-wizard-next")).toBeDisabled();
    fireEvent.click(getByTestId("browser-wizard-install"));
    await waitFor(() => expect(posts(fetchMock, "/setup-api/browser/manage")).toEqual([{ action: "install-chromium" }]));

    rerender(
      <BrowserSetupWizard
        status={{ ...STATUS, chromium: { installed: true, path: "/snap/bin/chromium", serviceSafe: false } }}
        harnessLabel="OpenClaw"
        onChanged={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // Installed but not launchable: the owner is told, and not trapped.
    expect(await findByTestId("browser-wizard-next")).not.toBeDisabled();
  });

  it("lets the owner out of the front door without touching the device", async () => {
    const onDone = vi.fn();
    const { getByTestId } = render(
      <BrowserSetupWizard status={STATUS} harnessLabel="OpenClaw" onChanged={vi.fn()} onDone={onDone} />,
    );

    fireEvent.click(getByTestId("browser-wizard-skip"));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(posts(fetchMock, "/setup-api/browser/setup")).toEqual([{ setupComplete: true }]);
    expect(posts(fetchMock, "/setup-api/browser/manage")).toEqual([]);
  });

  it("says why a launch was refused instead of finishing over it", async () => {
    fetchMock.mockImplementation(async (input?: RequestInfo | URL) => {
      if (String(input).includes("/setup-api/browser/manage")) {
        return { ok: false, status: 400, json: async () => ({ error: "Chromium not installed", code: "chromium_not_service_safe" }) };
      }
      return json({ ok: true });
    });
    const onDone = vi.fn();
    const { getByTestId, findByTestId, findByText } = render(
      <BrowserSetupWizard status={{ ...STATUS, alwaysOn: true, enabled: true }} harnessLabel="Hermes" onChanged={vi.fn()} onDone={onDone} />,
    );

    fireEvent.click(getByTestId("browser-wizard-start"));
    fireEvent.click(await findByTestId("browser-wizard-next"));
    fireEvent.click(await findByTestId("browser-wizard-open"));

    expect(await findByText("browser.errorNotServiceSafe")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
