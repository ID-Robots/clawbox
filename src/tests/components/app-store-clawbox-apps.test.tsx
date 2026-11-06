/**
 * ClawBox Apps in the Store app (src/components/AppStore.tsx): the category
 * tab comes first even before the portal's category list names it, a
 * ClawBox app is marked as one, and installing it posts `source: "clawbox"`
 * so the box downloads and verifies its package instead of asking ClawHub.
 * A registration that did not happen is not reported as an install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import AppStore from "@/components/AppStore";

const SKILL = { name: "Weather Deck", slug: "weather-deck", summary: "Forecast cards.", category: "Utilities", rating: 4.5, installs: "2800+" };
const CLAWBOX_APP = {
  name: "Tinder Clone", slug: "tinder-clone", description: "Swipe on profiles.", category: "clawbox-apps", source: "clawbox",
  kind: "webapp", version: "1.0.0", packageUrl: "/api/store/apps/tinder-clone/package", sha256: "a".repeat(64), size: 1234,
};
const LIST = { total: 2, categories: [{ id: "Utilities", name: "Utilities", count: 1 }], apps: [SKILL, CLAWBOX_APP] };

let installAnswer: unknown;
const posts: unknown[] = [];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response);
}

beforeEach(() => {
  posts.length = 0;
  installAnswer = { ok: true, appId: "tinder-clone", source: "clawbox", registered: true, webappUrl: "/setup-api/webapps?app=tinder-clone" };
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/setup-api/apps/install")) {
      posts.push(JSON.parse(String(init?.body)));
      return jsonResponse(installAnswer);
    }
    if (url.startsWith("/setup-api/apps/store")) return jsonResponse(LIST);
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function installTinder(onInstall = vi.fn()) {
  render(<AppStore installedAppIds={[]} onInstall={onInstall} onUninstall={vi.fn()} />);
  const card = (await screen.findByText("Tinder Clone")).closest("[data-app-card], li, article, div[class*='rounded-xl']") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "store.install" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("store.clawboxConfirmMessage")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "store.installClawboxApp" }));
  return onInstall;
}

describe("ClawBox Apps in the Store", () => {
  it("shows the ClawBox Apps tab first, and marks the app", async () => {
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await screen.findByText("Tinder Clone");
    const tabs = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    const clawbox = tabs.indexOf("ClawBox Apps");
    expect(clawbox).toBeGreaterThan(-1);
    expect(clawbox).toBeLessThan(tabs.indexOf("Utilities"));
    expect(screen.getAllByLabelText("store.clawboxApp").length).toBeGreaterThan(0);
  });

  it("keeps the ClawBox Apps tab when another category's list holds no ClawBox app", async () => {
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await screen.findByText("Tinder Clone");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/setup-api/apps/store")) return jsonResponse({ total: 1, categories: LIST.categories, apps: [SKILL] });
      return jsonResponse({});
    }) as typeof fetch);
    fireEvent.click(screen.getByRole("button", { name: "Utilities" }));
    await waitFor(() => expect(screen.queryByText("Tinder Clone")).toBeNull());
    expect(screen.getByRole("button", { name: "ClawBox Apps" })).toBeInTheDocument();
  });

  it("never links a ClawBox app to a ClawHub page guessed from its developer", async () => {
    const withDeveloper = { ...CLAWBOX_APP, developer: "someone" };
    vi.mocked(fetch).mockImplementation(((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/setup-api/apps/store?slug=")) return jsonResponse(withDeveloper);
      if (url.startsWith("/setup-api/apps/store")) return jsonResponse({ ...LIST, apps: [SKILL, withDeveloper] });
      return jsonResponse({});
    }) as typeof fetch);
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    fireEvent.click(await screen.findByText("Tinder Clone"));
    await screen.findByTestId("store-clawbox-app-badge");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("slug=tinder-clone"))).toBe(true));
    const links = screen.queryAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(links.filter((href) => href.startsWith("https://clawhub.ai/"))).toEqual([]);
  });

  it("installs a ClawBox app by its source, and hands the desktop its window", async () => {
    const onInstall = await installTinder();
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ appId: "tinder-clone", source: "clawbox" }]);
    expect(onInstall.mock.calls[0][0]).toMatchObject({ id: "tinder-clone", source: "clawbox", webappUrl: "/setup-api/webapps?app=tinder-clone" });
  });

  it("does not report an app whose server would not start as installed", async () => {
    installAnswer = { ok: true, appId: "tinder-clone", source: "clawbox", registered: false, webappUrl: null, detail: "Its server could not be put on the desktop." };
    const onInstall = await installTinder();
    expect(await screen.findByText("Its server could not be put on the desktop.")).toBeInTheDocument();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("still installs a skill the way it always did", async () => {
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    const card = (await screen.findByText("Weather Deck")).closest("[data-app-card], li, article, div[class*='rounded-xl']") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "store.install" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "store.installAnyway" }));
    await waitFor(() => expect(posts).toEqual([{ appId: "weather-deck" }]));
  });
});
