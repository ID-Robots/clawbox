import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";

/**
 * `incomplete_install` has two device states, and the store only ever told the
 * customer about one of them.
 *
 * The route distinguishes them: when the skill was ALREADY installed before the
 * request, the rollback deliberately leaves the customer's copy alone and the
 * body carries `preexisting: true` plus a sentence that says so. Nothing read
 * that flag — `grep -rn preexisting src/ mcp/` returned only the producer — so
 * the store threw `COPY.installIncomplete(...)`, whose copy reads "The download
 * was incomplete" / "Nothing was installed. Check your internet connection and
 * try again."
 *
 * Both halves are false here. The skill IS installed, and the retry that
 * sentence invites re-enters the same branch: `verifyAndRepair` has already had
 * its go, so the files are still missing and the installer meets its own lock
 * entry and exits 0 without fetching anything.
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

const SKILL = {
  id: "official/pdf-tools",
  name: "PDF Tools",
  source: "official",
  trust: "official",
};

const BROWSE = {
  skills: [SKILL],
  page: 1,
  pageSize: 24,
  total: 1,
  totalPages: 1,
  hasMore: false,
  facets: { sources: [{ id: "official", label: "Official", count: 1 }], providers: [] },
  catalog: { origin: "index", skillCount: 90_600, fetchedAt: new Date().toISOString(), stale: false },
  degraded: false,
};

/** The route's body for the branch that leaves a pre-existing install alone. */
const PREEXISTING = {
  error:
    'Some of "pdf-tools"\'s files are missing from the device. It was already installed before '
    + "this request, so it was left in place — remove it from the Skills store and install it again.",
  code: "incomplete_install",
  preexisting: true,
  missingFiles: ["reference/pdf.md"],
  expectedCount: 4,
  presentCount: 3,
  manifestOrigin: "skill-md",
};

/** The same code for the state the old copy DID describe: nothing installed. */
const DOWNLOAD_INCOMPLETE = {
  error: "The download was incomplete — the skill was not installed.",
  code: "incomplete_install",
  missingFiles: ["reference/pdf.md"],
  expectedCount: 4,
  presentCount: 2,
  manifestOrigin: "skill-md",
};

const HUB_ROW = {
  id: "pdf-tools",
  name: "PDF Tools",
  category: "other",
  origin: "hub",
  source: "official",
  identifier: "official/pdf-tools",
  enabled: true,
};

interface Installed {
  skills: unknown[];
  counts: { total: number };
  categories: unknown[];
}

const EMPTY_INSTALLED: Installed = { skills: [], counts: { total: 0 }, categories: [] };

function mockStore(opts: { installedPages: Installed[]; body: Record<string, unknown> }) {
  let installedCalls = 0;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/skills/browse")) return { ok: true, status: 200, json: async () => BROWSE };
    // `/skills/installed` is a prefix match for `/skills/install`, so the list
    // endpoint has to be recognised first.
    if (url.includes("/skills/installed")) {
      const body = opts.installedPages[Math.min(installedCalls, opts.installedPages.length - 1)];
      installedCalls += 1;
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.includes("/skills/install")) {
      return { ok: false, status: 502, json: async () => opts.body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { installedCalls: () => installedCalls };
}

async function openBrowseTab() {
  render(<HermesSkillsStore />);
  const tab = await screen.findByTestId("skill-tab-browse");
  await act(async () => {
    fireEvent.click(tab);
  });
  await screen.findByText("PDF Tools");
}

async function installFromBrowse() {
  const card = await screen.findByTestId("skill-install-btn");
  await act(async () => {
    fireEvent.click(within(card).getByRole("button"));
  });
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an install refused over a skill that is still installed", () => {
  it("does not tell the customer nothing was installed", async () => {
    mockStore({ installedPages: [EMPTY_INSTALLED], body: PREEXISTING });
    await openBrowseTab();
    await installFromBrowse();

    // The route's own sentence, which is the one that matches the device.
    expect(await screen.findByText(/already installed before this request/i)).toBeTruthy();
    // …and not the download story, which sends them to check the WiFi over a
    // skill that is sitting on the device.
    expect(screen.queryByText(/download was incomplete/i)).toBeNull();
  });

  it("re-reads the installed list, because the row to remove is the one on screen", async () => {
    const { installedCalls } = mockStore({
      installedPages: [EMPTY_INSTALLED, { skills: [HUB_ROW], counts: { total: 1 }, categories: [] }],
      body: PREEXISTING,
    });
    await openBrowseTab();
    const before = installedCalls();

    await installFromBrowse();

    await waitFor(() => expect(installedCalls()).toBeGreaterThan(before));
  });

  it("offers Remove on the card, not the Retry that cannot work", async () => {
    // The message says to remove it and install it again. Retry re-enters this
    // same branch: the installer meets the surviving lock entry, exits 0
    // without fetching, and the completeness check fails on the same files.
    mockStore({
      installedPages: [EMPTY_INSTALLED, { skills: [HUB_ROW], counts: { total: 1 }, categories: [] }],
      body: PREEXISTING,
    });
    await openBrowseTab();
    await installFromBrowse();

    await screen.findByText(/already installed before this request/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /^remove$/i })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });

  it("keeps the download story for the state it actually describes", async () => {
    // The guard against fixing this by deleting the branch: when nothing was
    // installed, "the download was incomplete" is the true sentence and the
    // translated copy is the right one to show.
    const { installedCalls } = mockStore({
      installedPages: [EMPTY_INSTALLED],
      body: DOWNLOAD_INCOMPLETE,
    });
    await openBrowseTab();
    const before = installedCalls();

    await installFromBrowse();

    expect(await screen.findByText(/download was incomplete/i)).toBeTruthy();
    // Nothing landed on the device, so there is no new row to go and find.
    expect(installedCalls()).toBe(before);
  });

  it("keeps Retry for a failure that left nothing on the device", async () => {
    // The guard on the button swap: no hub row for this skill, so there is
    // nothing to remove and Retry is the only step there is.
    mockStore({ installedPages: [EMPTY_INSTALLED], body: DOWNLOAD_INCOMPLETE });
    await openBrowseTab();
    await installFromBrowse();

    await screen.findByText(/download was incomplete/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });
});
