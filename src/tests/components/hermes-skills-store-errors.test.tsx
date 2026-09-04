import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
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

/** What phase 1 of the inspect route answers for the card above. */
const DETAIL = {
  id: SKILL.id,
  name: SKILL.name,
  source: SKILL.source,
  trust: SKILL.trust,
  needsRemoteDocs: true,
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

function mockStore(opts: {
  installed?: unknown;
  browse?: Reply;
  action?: () => Reply;
  /** The detail panel's two phases: `?id=` (metadata) and `?id=&docs=1`. */
  inspect?: (docs: boolean) => Reply;
  /** Called on every read of the installed list, so a test can count them. */
  onInstalled?: () => void;
}) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/skills/inspect")) {
      return opts.inspect ? opts.inspect(url.includes("docs=1")) : reply(200, { skill: DETAIL });
    }
    if (url.includes("/skills/browse")) return opts.browse ?? reply(200, BROWSE);
    // `/skills/installed` is a prefix match for `/skills/install`, so the list
    // endpoint has to be recognised first.
    if (url.includes("/skills/installed")) {
      opts.onInstalled?.();
      return reply(200, opts.installed ?? EMPTY_INSTALLED);
    }
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
async function installFromBrowse(announced = "skills.liveInstallFailed") {
  await screen.findByText("PDF Tools");
  const card = await screen.findByTestId("skill-install-btn");
  await act(async () => {
    fireEvent.click(within(card).getByRole("button"));
  });
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: bgCopy("skills.install") }));
  });
  // The polite announcement lands with the card's error state. `announced` is
  // the KEY the caller expects: a refusal whose code says the outcome is not
  // established announces that, not a failure.
  await screen.findByText(bgCopy(announced, { name: "PDF Tools" }));
}

/** Click Remove on the Installed row, then confirm in the dialog. */
async function removeFromInstalled(announced = "skills.liveRemoveFailed") {
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
  await screen.findByText(bgCopy(announced, { name: "pdf-tools" }));
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
      action: () =>
        reply(409, {
          error: "The device's installer refused to install it.",
          code: "dangerous_skill_blocked",
          warning: { trust: "community" },
        }),
    });
    await openBrowseTab();
    await installFromBrowse();

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

  it("drops the source clause when the payload carried no trust tier — it is not an 'unknown' source", async () => {
    // The device refuses a dangerous verdict from a COMMUNITY or a TRUSTED
    // source, and its own sentence says "third-party" when the scan named no
    // tier. Filling that gap with the rail's `unknown` bucket told the owner
    // where the skill came from — a claim this payload never made.
    mockStore({
      action: () => reply(409, { error: "The device's installer refused to install it.", code: "dangerous_skill_blocked" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(
      screen.getByText(
        bgCopy("skills.blockedByDeviceUnknownSource", {
          name: "PDF Tools",
          verdict: bgCopy("skills.safetyBucket.dangerous"),
        }),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(bgCopy("skills.trustBucket.unknown")))).toBeNull();
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

  it("ambiguous_name renders the translated copy, keeping the lock ids", async () => {
    // F-09's refusal: two installed skills answer to one string, so the device
    // removed neither. The candidate LOCK IDS are not translatable text — they
    // are the only strings that separate the two on the next attempt — so the
    // line is localised around them.
    mockStore({
      installed: ONE_INSTALLED,
      action: () =>
        reply(409, {
          error: 'More than one installed skill on this device answers to "pdf-tools". '
            + "Remove it by its own name: acme-pdf, pdf-tools.",
          code: "ambiguous_name",
          candidates: ["acme-pdf", "pdf-tools"],
        }),
    });
    await removeFromInstalled();

    expect(screen.queryByText(/More than one installed skill/i)).toBeNull();
    expect(
      screen.getByText(
        bgCopy("skills.ambiguousName", { name: "pdf-tools", names: "acme-pdf, pdf-tools" }),
      ),
    ).toBeTruthy();
  });

  it("falls back to the route's sentence when ambiguous_name carries no candidates", async () => {
    // Without the ids the localised line would say a choice is needed and give
    // nothing to choose between; the route's own words at least name them.
    mockStore({
      installed: ONE_INSTALLED,
      action: () =>
        reply(409, { error: "Remove it by its own name: acme-pdf, pdf-tools.", code: "ambiguous_name" }),
    });
    await removeFromInstalled();

    expect(screen.getByText(/Remove it by its own name/)).toBeTruthy();
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

/**
 * The search box takes any text; the browse route refuses some of it (a leading
 * "-", or more than 128 characters) with a 400. That 400 carried no code, so
 * the card said "couldn't load the catalogue" — a device failure the device did
 * not have — under a Retry that re-sends the same rejected text.
 */
describe("a search the route will not run is the owner's to fix, not the device's", () => {
  it("says the search cannot be used, in the owner's language", async () => {
    mockStore({ browse: reply(400, { error: "Invalid query", code: "bad_query" }) });
    await openBrowseTab();

    expect(await screen.findByText(bgCopy("skills.browseBadQuery"))).toBeTruthy();
    expect(screen.queryByText(bgCopy("skills.browseFailed"))).toBeNull();
  });

  it("offers to clear the search rather than to retry it", async () => {
    mockStore({ browse: reply(400, { error: "Invalid query", code: "bad_query" }) });
    await openBrowseTab();

    expect(await screen.findByRole("button", { name: bgCopy("skills.clearSearch") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: bgCopy("skills.retry") })).toBeNull();
  });
});

/**
 * The detail panel is the fourth surface of the same store, fed by the inspect
 * route — whose catch answered runHermesCli's own English and had it painted in
 * an Alert under a localised header.
 */
describe("the detail panel says its failures in the owner's language too", () => {
  async function openFirstCard() {
    await openBrowseTab();
    const open = await screen.findByText("PDF Tools");
    await act(async () => {
      fireEvent.click(open);
    });
  }

  it("a device with no Hermes is named as such, not by the CLI's sentence", async () => {
    mockStore({
      inspect: () => reply(502, { error: "Hermes is not installed on this device.", code: "cli_missing" }),
    });
    await openFirstCard();

    expect(await screen.findByText(bgCopy("skills.detailUnavailable"))).toBeTruthy();
    expect(screen.queryByText(/not installed on this device/i)).toBeNull();
  });

  it("any other metadata failure gets the generic line, code or no code", async () => {
    mockStore({ inspect: () => reply(502, { error: "Could not load skill details" }) });
    await openFirstCard();

    expect(await screen.findByText(bgCopy("skills.detailFailed"))).toBeTruthy();
    expect(screen.queryByText("Could not load skill details")).toBeNull();
  });

  it("a documentation-only failure says the body is missing, not the skill", async () => {
    // Phase 1 answered: the metadata is on screen. Only the docs fetch failed,
    // and claiming the skill could not be loaded would contradict the page.
    mockStore({
      inspect: (docs) =>
        docs
          ? reply(504, { error: "Could not load the full documentation", code: "cli_timeout" })
          : reply(200, { skill: DETAIL }),
    });
    await openFirstCard();

    expect(await screen.findByText(bgCopy("skills.detailDocsFailed"))).toBeTruthy();
    expect(screen.queryByText(bgCopy("skills.detailFailed"))).toBeNull();
  });
});

/**
 * TASK-658. Three refusals the store told the wrong story about.
 *
 * `too_large` is not a failure — the CLI's own output overran the read cap
 * AFTER it ran, so the outcome is unknown. The MCP tool has always told the
 * agent so ("call skill_list and look for it before deciding anything") while
 * the store said "Install failed": one device state, two contradictory stories,
 * and the one shown to the owner is the one that invites a second install.
 *
 * The rail's two refusals used to arrive with no code at all and landed on the
 * catalogue's "couldn't load, retry" — a device-failure card for a checkbox,
 * with a button whose only effect is to resend what was just rejected.
 */
describe("TASK-658: a refusal the owner can undo says so", () => {
  it("too_large on install says the outcome is unknown, not that it failed", async () => {
    mockStore({
      action: () => reply(502, { error: "The device's answer was too large to use.", code: "too_large" }),
    });
    await openBrowseTab();
    // ...including in the live region, which is where a screen-reader owner
    // would otherwise have heard the failure story the card no longer tells.
    await installFromBrowse("skills.liveInstallUnknown");

    expect(screen.getByText(bgCopy("skills.installUnknownOutcome", { name: "PDF Tools" }))).toBeTruthy();
    expect(screen.queryByText(bgCopy("skills.installFailed"))).toBeNull();
    expect(screen.queryByText(bgCopy("skills.liveInstallFailed", { name: "PDF Tools" }))).toBeNull();
    // Amber, not the red failure chrome around a sentence that says the
    // outcome is not known.
    const line = screen.getByText(bgCopy("skills.installUnknownOutcome", { name: "PDF Tools" }));
    expect(line.className).toContain("text-amber-400");
    expect(line.className).not.toContain("text-red-400");
  });

  it("an unproven removal is not painted as a failure, and re-reads the list it points at", async () => {
    // The route answers this when it timed out AND could not read the hub lock:
    // the removal may well have happened. Red chrome plus "Uninstall failed"
    // over a skill that is gone is the false failure this card is about — and
    // the copy sends the owner to the Installed tab, so that tab has to be
    // re-read before they get there.
    let installedReads = 0;
    mockStore({
      installed: ONE_INSTALLED,
      onInstalled: () => {
        installedReads += 1;
      },
      action: () =>
        reply(502, {
          error: "The device ran out of time and could not confirm whether the skill was removed.",
          code: "uninstall_unproven",
        }),
    });
    await removeFromInstalled("skills.liveRemoveUnknown");

    const line = screen.getByText(bgCopy("skills.uninstallUnknownOutcome", { name: "pdf-tools" }));
    expect(line.className).toContain("text-amber-400");
    expect(screen.queryByText(bgCopy("skills.uninstallFailed"))).toBeNull();
    await waitFor(() => expect(installedReads).toBeGreaterThan(1));
  });

  it("an invalid_argument from install keeps the owner's language, not the route's sentence", async () => {
    // `refusalLine` hands a code this build has no copy for the route's own
    // English — right for a newer device naming a refusal we do not know, and
    // wrong for a code added in the same commit as the route. The field these
    // 400s name is never something the owner typed (the store POSTs the id off
    // a browse card), so the localised generic is the honest line.
    mockStore({
      action: () => reply(400, { error: "Invalid skill id", code: "invalid_argument", field: "id" }),
    });
    await openBrowseTab();
    await installFromBrowse();

    expect(screen.queryByText("Invalid skill id")).toBeNull();
    expect(screen.getByText(bgCopy("skills.installFailed"))).toBeTruthy();
  });

  it("invalid_argument on browse names the filters, and offers to clear them", async () => {
    mockStore({ browse: reply(400, { error: "Invalid trust", code: "invalid_argument", field: "trust" }) });
    await openBrowseTab();

    expect(await screen.findByText(bgCopy("skills.browseBadFilter"))).toBeTruthy();
    expect(screen.queryByText(bgCopy("skills.browseFailed"))).toBeNull();
    // Retry would resend exactly what was refused.
    expect(screen.queryByRole("button", { name: bgCopy("skills.retry") })).toBeNull();
    expect(screen.getByRole("button", { name: bgCopy("skills.filtersClearAll") })).toBeTruthy();
  });

  it("too_many_facets says there are too many, not that one is invalid", async () => {
    mockStore({
      browse: reply(400, {
        error: "Too many trust filters — at most 12 at a time.",
        code: "too_many_facets",
        field: "trust",
        limit: 12,
      }),
    });
    await openBrowseTab();

    expect(await screen.findByText(bgCopy("skills.browseTooManyFilters"))).toBeTruthy();
    expect(screen.queryByText(bgCopy("skills.browseBadFilter"))).toBeNull();
  });
});
