import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import AppStore from "@/components/AppStore";

/**
 * The store's failure states.
 *
 * A failed list fetch used to leave apps=[] with no error state, so the grid
 * showed the search empty-state "No apps found" — claiming an empty catalogue
 * when the store was simply unreachable — with no way to retry. And an install
 * refusal was collapsed to a generic message with a Retry button even when
 * retrying could never help (ClawHub has no such skill) or when the right next
 * step was a choice (several publishers share the slug).
 *
 * `useT` falls back to identity when no provider is mounted, so copy asserts
 * as translation keys ("store.loadError", "store.retry").
 */

const APP = {
  name: "Weather Deck",
  slug: "weather-deck",
  summary: "Forecast cards for the desktop shell.",
  category: "Utilities",
  rating: 5,
  installs: "2800+",
  channel: "official",
};

const LIST = {
  total: 1,
  categories: [{ id: "Utilities", name: "Utilities", count: 1 }],
  apps: [APP],
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

let listFails: boolean;
let installResponses: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  listFails = false;
  installResponses = [];
  // The suite runs with `mockReset: true`, which strips the implementation off
  // the shared IntersectionObserver stub in setup.ts before each test. The
  // store observes a scroll sentinel on mount, so re-stub it here.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The list fetch failure is logged deliberately; keep it out of the runner
  // output without asserting on it.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/setup-api/apps/install")) {
        const next = installResponses.shift() ?? { status: 200, body: { ok: true, clawhub: { success: true } } };
        return jsonResponse(next.body, next.status);
      }
      if (url.startsWith("/setup-api/apps/store")) {
        if (listFails) return Promise.reject(new TypeError("Failed to fetch"));
        return jsonResponse(LIST);
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app store — load failure", () => {
  it("shows an error state with Retry instead of 'No apps found', and no made-up count", async () => {
    listFails = true;
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);

    await screen.findByText("store.loadError");
    expect(screen.queryByText("store.noAppsFound")).toBeNull();
    // The subtitle carries no fabricated count while nothing has loaded.
    expect(screen.getByText("store.poweredByNoCount")).toBeInTheDocument();

    // Retry re-runs the fetch; once the store answers, the catalogue renders
    // and the error state is gone.
    listFails = false;
    fireEvent.click(screen.getByRole("button", { name: "store.retry" }));
    await screen.findByText("Weather Deck");
    expect(screen.queryByText("store.loadError")).toBeNull();
  });
});

describe("app store — installed catalogue", () => {
  it("loads an installed app whose row is absent from the initial catalogue page", async () => {
    const installedOnly = {
      name: "Later Page Skill",
      slug: "later-page-skill",
      summary: "Installed, but outside the capped first catalogue page.",
      category: "Utilities",
      rating: 4.8,
      installs: "900+",
      developer: "late-publisher",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/apps/store?slug=later-page-skill") {
        return jsonResponse(installedOnly);
      }
      if (url.startsWith("/setup-api/apps/store")) return jsonResponse(LIST);
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppStore
        installedAppIds={["later-page-skill"]}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );

    // The first page genuinely does not contain the installed slug.
    await screen.findByText("Weather Deck");
    expect(screen.queryByText("Later Page Skill")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "store.installed" }));

    expect(await screen.findByText("Later Page Skill")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/setup-api/apps/store?slug=later-page-skill",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText("store.noInstalledApps")).toBeNull();
  });

  it("says what is actually true about apps built on the box, and asks ClawHub about them once", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // An app the coding agent built is an id in `installed_apps` and nothing
      // on ClawHub.
      if (url === "/setup-api/apps/store?slug=angry-pigs") return jsonResponse({ error: "not_found" }, 404);
      if (url.startsWith("/setup-api/apps/store")) return jsonResponse(LIST);
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const lookups = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("slug=angry-pigs")).length;

    render(<AppStore installedAppIds={["angry-pigs"]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await screen.findByText("Weather Deck");

    fireEvent.click(screen.getByRole("button", { name: "store.installed" }));
    // Not "you haven't installed any apps yet": this box has one installed,
    // it simply did not come from the store.
    await waitFor(() => expect(screen.getByTestId("store-empty-state").textContent)
      .toBe("The apps installed on this box did not come from the store — an app built here has no store listing."));
    await waitFor(() => expect(lookups()).toBe(1));

    // The tab used to re-ask on every visit, so opening it three times meant
    // three more 404s and three more console errors.
    fireEvent.click(screen.getByRole("button", { name: "store.all" }));
    await screen.findByText("Weather Deck");
    fireEvent.click(screen.getByRole("button", { name: "store.installed" }));
    await screen.findByTestId("store-empty-state");
    expect(lookups()).toBe(1);
  });

  // The Installed list is cut by the search box as well as by what is
  // installed, so an empty list under a search says nothing about where the
  // apps came from. This box has one installed app and it IS a store app.
  it("answers a search that matched nothing with 'no apps found', not 'not from the store'", async () => {
    render(<AppStore installedAppIds={["weather-deck"]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await screen.findByText("Weather Deck");

    fireEvent.click(screen.getByRole("button", { name: "store.installed" }));
    expect(await screen.findByText("Weather Deck")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("store.searchApps"), { target: { value: "zzz" } });

    await waitFor(() => expect(screen.getByTestId("store-empty-state").textContent).toBe("store.noAppsFound"));

    // Clear the search and the honest statement about this box comes back —
    // there is no store row left to match once the filter is gone, because
    // the catalogue fetch for "zzz" answered with the same one app.
    fireEvent.change(screen.getByPlaceholderText("store.searchApps"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Weather Deck")).toBeInTheDocument());
  });

  it("ignores a stale first-page response after switching to Installed", async () => {
    let resolveFirstPage: ((response: Response) => void) | null = null;
    const firstPage = new Promise<Response>((resolve) => { resolveFirstPage = resolve; });
    const installedOnly = {
      name: "Installed During Load",
      slug: "installed-during-load",
      summary: "The installed lookup owns the list after the tab switch.",
      category: "Utilities",
      rating: 4.7,
      installs: "700+",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/apps/store?slug=installed-during-load") {
        return jsonResponse(installedOnly);
      }
      if (url.startsWith("/setup-api/apps/store")) return firstPage;
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppStore
        installedAppIds={["installed-during-load"]}
        onInstall={vi.fn()}
        onUninstall={vi.fn()}
      />,
    );

    // Ensure the first-page request is genuinely in flight before changing
    // tabs; the mock intentionally ignores AbortSignal and resolves late.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("limit=200"))).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "store.installed" }));
    expect(await screen.findByText("Installed During Load")).toBeInTheDocument();

    await act(async () => {
      resolveFirstPage?.(await jsonResponse(LIST));
      await Promise.resolve();
    });

    expect(screen.getByText("Installed During Load")).toBeInTheDocument();
    expect(screen.queryByText("store.noInstalledApps")).toBeNull();
  });
});

describe("app store — install failures", () => {
  /** Open the install confirmation for the one listed app and confirm it. */
  async function confirmInstall() {
    fireEvent.click(await screen.findByRole("button", { name: "store.install" }));
    fireEvent.click(await screen.findByRole("button", { name: "store.installAnyway" }));
  }

  it("offers the publisher choice on a 409 'ambiguous' and re-posts the picked ref", async () => {
    const onInstall = vi.fn();
    installResponses = [{
      status: 409,
      body: {
        ok: false,
        code: "ambiguous",
        error: "several publishers",
        matches: [
          { ownerHandle: "alice", ref: "@alice/weather-deck", url: "https://clawhub.ai/alice/skills/weather-deck" },
          { ownerHandle: "bob", ref: "@bob/weather-deck", url: "https://clawhub.ai/bob/skills/weather-deck" },
        ],
      },
    }];
    render(<AppStore installedAppIds={[]} onInstall={onInstall} onUninstall={vi.fn()} />);
    await confirmInstall();

    await screen.findByText("store.choosePublisher");
    expect(screen.getByRole("button", { name: "@bob" })).toBeInTheDocument();
    // The choice is the owner's — nothing auto-retries, and no Retry button
    // pretends the same request could succeed.
    expect(screen.queryByRole("button", { name: "store.retry" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "@alice" }));
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const installCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/setup-api/apps/install"));
    expect(installCalls).toHaveLength(2);
    expect(JSON.parse((installCalls[1][1] as RequestInit).body as string)).toEqual({ appId: "@alice/weather-deck" });
  });

  it("shows the route's specific reason and hides Retry when the failure is not retryable", async () => {
    installResponses = [{
      status: 404,
      body: { ok: false, code: "not_found", retryable: false, error: 'ClawHub has no skill named "weather-deck".' },
    }];
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await confirmInstall();

    await screen.findByText('ClawHub has no skill named "weather-deck".');
    expect(screen.queryByRole("button", { name: "store.retry" })).toBeNull();
  });

  it("keeps Retry for a retryable failure", async () => {
    installResponses = [{
      status: 502,
      body: { ok: false, code: "upstream", retryable: true, error: "ClawHub is having trouble right now. Try again in a few minutes." },
    }];
    render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    await confirmInstall();

    await screen.findByText("ClawHub is having trouble right now. Try again in a few minutes.");
    expect(screen.getByRole("button", { name: "store.retry" })).toBeInTheDocument();
  });
});
