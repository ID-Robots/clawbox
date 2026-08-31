import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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
