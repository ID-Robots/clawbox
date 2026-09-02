import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";
import { bg } from "@/lib/hermes-translations/bg";

/**
 * HERMES-04. The install and uninstall routes name every refusal with a machine
 * `code` and ALSO compose an English sentence for it; the store threw the
 * sentence at the card verbatim, so a Bulgarian owner read "Installing "x" took
 * too long and was stopped…" under a Bulgarian button. The browse route was
 * worse: it carried no code at all, and the red empty state's title was
 * runHermesCli's own word for its SIGKILL — "hermes timed out".
 *
 * Rendered in Bulgarian on purpose: an English assertion cannot tell a mapped
 * string from a passed-through one. `bgCopy` throws on a key the locale does
 * not carry, so a missing translation is reported as such rather than as a
 * `.replace` on undefined.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { bg: table } = await import("@/lib/hermes-translations/bg");
  return {
    ...actual,
    useT: () => ({
      locale: "bg" as const,
      localeResolved: true,
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          table[key] ?? key,
        ),
    }),
  };
});

function bgCopy(key: string, params: Record<string, string> = {}): string {
  const source = bg[key];
  if (typeof source !== "string") throw new Error(`bg.ts is missing "${key}"`);
  return Object.entries(params).reduce(
    (out, [name, value]) => out.replaceAll(`{${name}}`, value),
    source,
  );
}

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

const HUB_ROW = {
  id: "pdf-tools",
  name: "PDF Tools",
  category: "other",
  origin: "hub",
  source: "official",
  identifier: "official/pdf-tools",
  enabled: true,
};

const EMPTY_INSTALLED = { skills: [], counts: { total: 0 }, categories: [] };
const ONE_INSTALLED = { skills: [HUB_ROW], counts: { total: 1 }, categories: [] };

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };

const reply = (status: number, body: unknown): Reply => ({
  ok: status < 400,
  status,
  json: async () => body,
});

function mockStore(opts: { installed?: unknown; browse?: Reply; action?: () => Reply }) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/skills/browse")) return opts.browse ?? reply(200, BROWSE);
    // `/skills/installed` is a prefix match for `/skills/install`, so the list
    // endpoint has to be recognised first.
    if (url.includes("/skills/installed")) return reply(200, opts.installed ?? EMPTY_INSTALLED);
    if (url.includes("/skills/install") || url.includes("/skills/uninstall")) {
      return opts.action ? opts.action() : reply(200, { ok: true });
    }
    return reply(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function openBrowseTab() {
  render(<HermesSkillsStore />);
  const tab = await screen.findByTestId("skill-tab-browse");
  await act(async () => {
    fireEvent.click(tab);
  });
}

/** Click Install on the card, then confirm in the dialog. */
async function installFromBrowse() {
  await screen.findByText("PDF Tools");
  const card = await screen.findByTestId("skill-install-btn");
  await act(async () => {
    fireEvent.click(within(card).getByRole("button"));
  });
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: bgCopy("skills.install") }));
  });
  // The polite announcement lands with the card's error state.
  await screen.findByText(bgCopy("skills.liveInstallFailed", { name: "PDF Tools" }));
}

/** Click Remove on the Installed row, then confirm in the dialog. */
async function removeFromInstalled() {
  render(<HermesSkillsStore />);
  await act(async () => {
    fireEvent.click(await screen.findByTestId("skill-tab-installed"));
  });
  const remove = (await screen.findAllByRole("button", { name: bgCopy("skills.remove") }))[0];
  await act(async () => {
    fireEvent.click(remove);
  });
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: bgCopy("skills.remove") }));
  });
  await screen.findByText(bgCopy("skills.liveRemoveFailed", { name: "pdf-tools" }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an install refusal the route names by code is shown in the owner's language", () => {
  it("install_timeout renders the translated deadline copy, not the route's sentence", async () => {
    mockStore({
      action: () =>
        reply(504, {
          error:
            'Installing "pdf-tools" took too long and was stopped, so nothing was installed. '
            + "Some community skills download from a rate-limited source and can be slow — try again in a moment.",
          code: "install_timeout",
        }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText(/took too long/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.installTimeout", { name: "PDF Tools" }))).toBeTruthy();
  });

  it("already_installed renders the translated copy", async () => {
    mockStore({
      action: () =>
        reply(409, { error: "That skill is already installed on this device.", code: "already_installed" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText(/already installed on this device/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.alreadyInstalled"))).toBeTruthy();
  });

  it("dangerous_skill_blocked renders the translated copy with the scan's verdict", async () => {
    mockStore({
      action: () =>
        reply(409, {
          error:
            'The device\'s installer refused to install "pdf-tools": its security scan returned a '
            + "dangerous verdict for a community source, which it will not install even when confirmed.",
          code: "dangerous_skill_blocked",
          requiresConfirmation: false,
          warning: { verdict: "dangerous", trust: "community", capabilities: [], severityCounts: {} },
        }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText(/will not install even when confirmed/i)).toBeNull();
    expect(
      screen.getByText(
        bgCopy("skills.blockedByDevice", {
          name: "PDF Tools",
          verdict: bgCopy("skills.safetyBucket.dangerous"),
          trust: bgCopy("skills.trustBucket.community"),
        }),
      ),
    ).toBeTruthy();
  });

  it("cli_missing from the install route is one failure to the owner, in their language", async () => {
    mockStore({
      action: () => reply(502, { error: "Hermes is not installed on this device", code: "cli_missing" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText(/not installed on this device/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.installFailed"))).toBeTruthy();
  });

  it("a refusal with no code at all gets the generic line; the route's sentence goes to the console", async () => {
    // An older device build, or a transport error. The sentence is English
    // composed on the server — the one place it belongs is the console, as
    // the browse tab already does with its own.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStore({ action: () => reply(502, { error: "Hermes is not installed on this device" }) });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText(/not installed on this device/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.installFailed"))).toBeTruthy();
    expect(error).toHaveBeenCalledWith("[skills install]", "Hermes is not installed on this device");
  });

  it("dangerous_skill_blocked with no verdict in the payload still says dangerous — the only verdict that code is sent for", async () => {
    mockStore({
      action: () => reply(409, { error: "The device's installer refused to install it.", code: "dangerous_skill_blocked" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(
      screen.getByText(
        bgCopy("skills.blockedByDevice", {
          name: "PDF Tools",
          verdict: bgCopy("skills.safetyBucket.dangerous"),
          trust: bgCopy("skills.trustBucket.unknown"),
        }),
      ),
    ).toBeTruthy();
  });

  it("keeps the route's sentence for a code this build does not know", async () => {
    // The guard against over-mapping: a newer route may name a refusal this
    // build has no copy for, and its sentence is still better than "HTTP 502".
    mockStore({
      action: () => reply(502, { error: "A sentence from a newer device build.", code: "brand_new_code" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.getByText("A sentence from a newer device build.")).toBeTruthy();
  });
});

describe("an uninstall refusal the route names by code is shown in the owner's language", () => {
  it("builtin_skill renders the translated copy, not the route's sentence", async () => {
    mockStore({
      installed: ONE_INSTALLED,
      action: () =>
        reply(409, { error: '"pdf-tools" came with this device, so it cannot be removed.', code: "builtin_skill" }),
    });
    await removeFromInstalled();

    expect(screen.queryByText(/came with this device/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.builtinSkill", { name: "pdf-tools" }))).toBeTruthy();
  });

  it("uninstall_refused renders the translated copy", async () => {
    mockStore({
      installed: ONE_INSTALLED,
      action: () => reply(502, { error: "The device refused to remove that skill.", code: "uninstall_refused" }),
    });
    await removeFromInstalled();

    expect(screen.queryByText(/refused to remove/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.uninstallRefused"))).toBeTruthy();
  });
});

describe("an uninstall failure with no code at all", () => {
  it("gets the generic line, not the CLI's sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStore({ installed: ONE_INSTALLED, action: () => reply(502, { error: "hermes call cancelled" }) });
    await removeFromInstalled();

    expect(screen.queryByText(/hermes call cancelled/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.uninstallFailed"))).toBeTruthy();
  });
});

describe("a browse failure never paints the CLI's own words", () => {
  it("cancelled — a code no card can receive while it is still on screen — takes the generic line", async () => {
    mockStore({ browse: reply(502, { error: "The request was cancelled.", code: "cancelled" }) });
    await openBrowseTab();
    await screen.findByRole("button", { name: bgCopy("skills.retry") });

    expect(screen.queryByText(/was cancelled/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.browseFailed"))).toBeTruthy();
  });

  it("cli_timeout renders the translated copy, not 'hermes timed out'", async () => {
    mockStore({ browse: reply(502, { error: "hermes timed out", code: "cli_timeout" }) });
    await openBrowseTab();
    await screen.findByRole("button", { name: bgCopy("skills.retry") });

    expect(screen.queryByText(/hermes timed out/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.browseTimeout"))).toBeTruthy();
  });

  it("cli_missing renders the translated copy", async () => {
    mockStore({
      browse: reply(502, { error: "Hermes is not installed on this device", code: "cli_missing" }),
    });
    await openBrowseTab();
    await screen.findByRole("button", { name: bgCopy("skills.retry") });

    expect(screen.queryByText(/not installed on this device/i)).toBeNull();
    expect(screen.getByText(bgCopy("skills.browseUnavailable"))).toBeTruthy();
  });

  it("a failure with no code at all still gets a translated title", async () => {
    // An older device build, or a transport error: the raw text goes to the
    // console, the card gets the generic copy.
    mockStore({ browse: reply(502, { error: "Browse failed" }) });
    await openBrowseTab();
    await screen.findByRole("button", { name: bgCopy("skills.retry") });

    expect(screen.queryByText("Browse failed")).toBeNull();
    expect(screen.getByText(bgCopy("skills.browseFailed"))).toBeTruthy();
  });
});
