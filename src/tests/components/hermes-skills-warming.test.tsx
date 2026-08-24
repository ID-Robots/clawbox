import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";

/**
 * A freshly flashed box has no offline skill index, so the first Browse is
 * answered — not left pending — by a route that reports `origin: 'warming'`,
 * `degraded: true` and zero results while a build runs behind it.
 *
 * The store used to gate its "building the catalogue" panel on `loading`, which
 * is false for a request that COMPLETED, so it fell through to the generic
 * empty state and told the user there was nothing in a catalogue of ~90 000
 * skills. Worse, nothing re-asked: the skills only appeared after the window was
 * reopened.
 */

/**
 * The store renders its copy through `t()` (TASK-458). On the desktop it sits
 * under the page's I18nProvider; here it is rendered bare, so resolve keys
 * against the real English catalogue — the assertions below then stay on the
 * sentences a user actually reads, not on test ids.
 */
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { skillsEn } = await import("@/lib/hermes-translations/en-skills");
  return {
    ...actual,
    useT: () => ({
      locale: "en" as const,
      localeResolved: true,
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          skillsEn[key] ?? key,
        ),
    }),
  };
});

const WARMING = {
  skills: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 1,
  hasMore: false,
  facets: { sources: [], providers: [] },
  catalog: { origin: "warming" },
  degraded: true,
};

const READY = {
  skills: [
    { id: "official/pdf-tools", name: "PDF Tools", source: "official", trust: "official" },
  ],
  page: 1,
  pageSize: 24,
  total: 1,
  totalPages: 1,
  hasMore: false,
  facets: { sources: [{ id: "official", label: "Official", count: 1 }], providers: [] },
  catalog: { origin: "index", skillCount: 90_600, fetchedAt: new Date().toISOString(), stale: false },
  degraded: false,
};

const INSTALLED = { skills: [], counts: { total: 0 }, categories: [] };

/** Serves the installed list always, and the browse endpoint from a script. */
function mockBrowse(pages: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/skills/browse")) {
      const body = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => INSTALLED };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, browseCalls: () => call };
}

async function openBrowseTab() {
  render(<HermesSkillsStore />);
  const tab = await screen.findByTestId("skill-tab-browse");
  await act(async () => {
    fireEvent.click(tab);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Browse while the skill index is still building", () => {
  it("says the catalogue is being prepared instead of that it is empty", async () => {
    mockBrowse([WARMING]);
    await openBrowseTab();

    expect(await screen.findByText(/Building the skill catalogue/i)).toBeTruthy();
    // The two strings the user actually saw on the device.
    expect(screen.queryByText(/Nothing in .* yet/i)).toBeNull();
    expect(screen.queryByText(/Try a different term/i)).toBeNull();
  });

  it("tells the user it will fill in on its own", async () => {
    mockBrowse([WARMING]);
    await openBrowseTab();

    expect(await screen.findByText(/Skills will appear here as soon as it is ready/i)).toBeTruthy();
  });

  it("re-asks and shows the skills once the index is ready, with no user action", async () => {
    const { browseCalls } = mockBrowse([WARMING, READY]);
    await openBrowseTab();

    await screen.findByText(/Building the skill catalogue/i);
    const before = browseCalls();

    // No click, no retyped search — only time passing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    await waitFor(() => expect(screen.getByText("PDF Tools")).toBeTruthy());
    expect(browseCalls()).toBeGreaterThan(before);
    expect(screen.queryByText(/Building the skill catalogue/i)).toBeNull();
  });

  it("stops polling once the catalogue answers", async () => {
    mockBrowse([WARMING, READY]);
    await openBrowseTab();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(screen.getByText("PDF Tools")).toBeTruthy());
    const calls = () => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const settled = calls();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls()).toBe(settled);
  });

  it("still reports a genuinely empty result once the device HAS a catalogue", async () => {
    // origin 'index' with no matches is a real answer, not a warm-up.
    mockBrowse([{ ...READY, skills: [], total: 0 }]);
    await openBrowseTab();

    expect(await screen.findByText(/Nothing in .* yet/i)).toBeTruthy();
    expect(screen.queryByText(/Building the skill catalogue/i)).toBeNull();
  });
});
