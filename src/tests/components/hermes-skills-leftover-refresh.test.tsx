import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";

/**
 * PR #517's new 409 tells the customer to go and remove a leftover. The store
 * never showed them the leftover.
 *
 * `rollback_incomplete` means the request created a lock entry the device could
 * not take back — a NEW row in the installed list — and its message is
 * "Remove "x" from the Skills store, then try again." `doInstall` falls through
 * to the generic `if (!res.ok) throw` and lands in the catch, which only sets an
 * error toast; `installed.refresh()` runs exclusively on the success path. So the
 * Installed tab still shows the pre-request list, and the skill the customer has
 * just been told to remove is not there to remove until they reload the page.
 *
 * The uninstall route's `removal_incomplete` is the mirror image — the lock entry
 * went, the directory did not, and the skill comes back into the list as a local
 * one — so it needs the same refresh.
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

const LEFTOVER = {
  error:
    'This skill did not pass the device’s security scan. The device could not fully undo the '
    + 'install: "pdf-tools" is still listed in the Skills store and its files are still on the '
    + 'device. Remove "pdf-tools" from the Skills store, then try again.',
  code: "rollback_incomplete",
  requiresConfirmation: false,
  name: "pdf-tools",
  leftover: { lockEntry: true, directory: "present" },
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

/**
 * Serves browse from a fixed page and the installed list from a script whose
 * LAST entry repeats, so "did the store re-read the list?" is answered by the
 * call count and by what ends up on screen.
 */
function mockStore(opts: { installedPages: Installed[]; action: () => unknown }) {
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
    if (url.includes("/skills/install") || url.includes("/skills/uninstall")) {
      return opts.action();
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

/** Click Install on the card, then confirm in the dialog. */
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

describe("a leftover the store has been told to remove has to be on screen", () => {
  it("re-reads the installed list when an install reports a leftover it could not undo", async () => {
    const { installedCalls } = mockStore({
      // The phantom entry the failed rollback left is a NEW row: the first read
      // (on mount) cannot contain it.
      installedPages: [EMPTY_INSTALLED, { skills: [HUB_ROW], counts: { total: 1 }, categories: [] }],
      action: () => ({ ok: false, status: 409, json: async () => LEFTOVER }),
    });
    await openBrowseTab();
    const before = installedCalls();

    await installFromBrowse();

    await waitFor(() => expect(installedCalls()).toBeGreaterThan(before));
  });

  it("shows the leftover in the Installed tab, where the message says to remove it", async () => {
    mockStore({
      installedPages: [EMPTY_INSTALLED, { skills: [HUB_ROW], counts: { total: 1 }, categories: [] }],
      action: () => ({ ok: false, status: 409, json: async () => LEFTOVER }),
    });
    await openBrowseTab();
    await installFromBrowse();

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-tab-installed"));
    });
    // The row the customer was told to remove, with the Remove button on it.
    const removes = await screen.findAllByRole("button", { name: /remove/i });
    expect(removes.length).toBeGreaterThan(0);
  });

  it("still tells the customer what happened", async () => {
    mockStore({
      installedPages: [EMPTY_INSTALLED],
      action: () => ({ ok: false, status: 409, json: async () => LEFTOVER }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(await screen.findByText(/could not fully undo the install/i)).toBeTruthy();
  });

  it("does not re-read the list for an ordinary refusal that changed nothing", async () => {
    // The guard against turning every error into a refetch: a bundled-name
    // conflict is refused BEFORE the CLI runs, so nothing on the device moved.
    const { installedCalls } = mockStore({
      installedPages: [EMPTY_INSTALLED],
      action: () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: "bundled_conflict", conflictsWith: "pdf", error: "no" }),
      }),
    });
    await openBrowseTab();
    const before = installedCalls();

    await installFromBrowse();

    await waitFor(() => expect(screen.getByText(/came with this device/i)).toBeTruthy());
    expect(installedCalls()).toBe(before);
  });
});

describe("the same rule for a removal the device could not finish", () => {
  it("re-reads the installed list when an uninstall leaves the files behind", async () => {
    const { installedCalls } = mockStore({
      installedPages: [
        { skills: [HUB_ROW], counts: { total: 1 }, categories: [] },
        {
          skills: [{ ...HUB_ROW, origin: "local", identifier: undefined }],
          counts: { total: 1 },
          categories: [],
        },
      ],
      action: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          code: "removal_incomplete",
          error:
            'The device removed "pdf-tools" from the Skills store, but its files are still on the '
            + "device.",
          leftover: { lockEntry: false, directory: "present" },
        }),
      }),
    });
    render(<HermesSkillsStore />);
    await act(async () => {
      fireEvent.click(await screen.findByTestId("skill-tab-installed"));
    });
    const remove = (await screen.findAllByRole("button", { name: /remove/i }))[0];
    const before = installedCalls();

    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /remove/i }));
    });

    await waitFor(() => expect(installedCalls()).toBeGreaterThan(before));
  });
});
