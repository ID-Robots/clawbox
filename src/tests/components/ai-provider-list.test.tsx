/**
 * The unified provider list (src/components/AiProviderList.tsx) — every AI
 * provider in one place with a switch each.
 *
 * The two rules pinned here are the ones the route enforces and the list must
 * reflect: a switch flips through POST /setup-api/providers/enabled and
 * re-reads the truth from the box (never an optimistic flip), and the default
 * provider's switch is LOCKED — nothing on this card may re-route the chat
 * behind the owner's back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";
import AiProviderList from "@/components/AiProviderList";

vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

const ROWS = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "anthropic", label: "Anthropic", state: "connected", isDefault: false, section: "ai", enabled: false },
  { id: "google", label: "Google", state: "disconnected", isDefault: false, section: "ai", enabled: true },
  { id: "llamacpp", label: "Gemma 4", state: "connected", isDefault: false, section: "localAi", enabled: true },
];

let posts: { url: string; body: unknown }[] = [];

/** The box's answers to every call this list makes, in one stub. */
function stubFetch(rows = ROWS, opts: { refuse?: { status: number; error: string }; locale?: string; defaultAnswer?: { body: unknown; status?: number }; unattachedRepairs?: unknown[]; unrunnable?: string[] } = {}) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // The I18nProvider's one read: which language the owner picked.
    if (url.startsWith("/setup-api/preferences")) {
      return json(opts.locale ? { ui_language: opts.locale } : {});
    }
    if (url.startsWith("/setup-api/providers/status")) {
      return json({
        harness: "openclaw",
        providers: rows,
        defaultProvider: "clawai",
        unrunnable: opts.unrunnable ?? [],
        degraded: false,
        ...(opts.unattachedRepairs ? { unattachedRepairs: opts.unattachedRepairs } : {}),
      });
    }
    if (url === "/setup-api/providers/enabled" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "is_default" }, opts.refuse.status);
      return json({ harness: "openclaw", providers: rows, defaultProvider: "clawai", degraded: false });
    }
    if (url === "/setup-api/providers/default" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (opts.defaultAnswer) return json(opts.defaultAnswer.body, opts.defaultAnswer.status ?? 200);
      return json({ ok: true });
    }
    return json({ error: "unexpected" }, 404);
  }));
}

/** The list as Settings mounts it: inside the app's I18nProvider. */
function renderList() {
  return render(<I18nProvider><AiProviderList /></I18nProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiProviderList", () => {
  it("lists the connected cloud providers with the default marked — not the unconnected ones, not the on-device engines", async () => {
    stubFetch();
    renderList();
    for (const row of ROWS.filter((r) => r.state === "connected" && r.section !== "localAi")) {
      expect(await screen.findByTestId(`ai-provider-${row.id}`)).toBeInTheDocument();
    }
    // Connecting a provider is the panel below the list, not a row in it.
    expect(screen.queryByTestId("ai-provider-google")).not.toBeInTheDocument();
    // The on-device model has its own tab.
    expect(screen.queryByTestId("ai-provider-llamacpp")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-default-openai")).not.toBeInTheDocument();
    // A switched-off provider says so instead of pretending to be disconnected.
    expect(screen.getByTestId("ai-provider-anthropic").textContent).toContain("Switched off");
  });

  it("flips a provider through the route and re-reads the list", async () => {
    stubFetch();
    renderList();
    const sw = await screen.findByTestId("ai-provider-switch-openai");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/providers/enabled",
      body: { provider: "openai", enabled: false },
    }));
    // Two status reads: the mount and the re-read after the flip.
    await waitFor(() => {
      const statusReads = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => String(c[0]).startsWith("/setup-api/providers/status"));
      expect(statusReads.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("locks the default provider's switch, with the way out as its hint", async () => {
    stubFetch();
    renderList();
    const sw = await screen.findByTestId("ai-provider-switch-clawai");
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("title", "Make another provider the default first.");
    // Visible on the row too, not only on hover — a phone has no hover — and
    // the switch names it as its description.
    expect(screen.getByTestId("ai-provider-locked-hint-clawai")).toHaveTextContent("Make another provider the default first.");
    expect(sw).toHaveAccessibleDescription("Make another provider the default first.");
    expect(screen.queryByTestId("ai-provider-locked-hint-openai")).not.toBeInTheDocument();
    fireEvent.click(sw);
    expect(posts).toEqual([]);
  });

  it("offers Make default only for a connected, enabled, non-default row", async () => {
    stubFetch();
    renderList();
    await screen.findByTestId("ai-provider-openai");
    expect(screen.getByTestId("ai-provider-make-default-openai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-make-default-clawai")).not.toBeInTheDocument();
    // Switched off, so not offered as a default either.
    expect(screen.queryByTestId("ai-provider-make-default-anthropic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ai-provider-make-default-openai"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/providers/default", body: { provider: "openai" } }));
  });

  /**
   * TASK-608. On OpenClaw, making a provider the default restarts the gateway,
   * and the gateway does not always bind again inside the route's readiness
   * budget. The default IS written; only the restart is still in flight, and
   * the route says so with `ok` plus a `warning`.
   *
   * Read as a failure this is the worst of both: the star stays on the old
   * provider, nothing tells the chat header or the capability probe, and the
   * owner clicks again and pays a second restart — over a change that landed.
   * So the warning is a notice, and everything the success path does still runs.
   */
  it("treats a default whose gateway is still coming back as saved, with a notice", async () => {
    stubFetch(ROWS, { defaultAnswer: { body: {
      ok: true,
      provider: "openai",
      model: "openai/gpt-5",
      warning: "Saved, but the gateway did not come back — the new model applies once it is serving again.",
    } } });
    renderList();
    fireEvent.click(await screen.findByTestId("ai-provider-make-default-openai"));

    // waitFor on the TEXT, not on the node: the region is mounted in every
    // state (so the announcement is a text change rather than a node
    // insertion), which means finding it proves nothing on its own.
    await waitFor(() =>
      expect(screen.getByTestId("ai-provider-default-warning")).toHaveTextContent("the gateway did not come back"));
    // A notice, not the red failure line: `role="status"` and no `alert`.
    expect(screen.getByTestId("ai-provider-default-warning")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // ...and the panel still re-read the box, which is what repaints the star.
    await waitFor(() => {
      const statusReads = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => String(c[0]).startsWith("/setup-api/providers/status"));
      expect(statusReads.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows the box's refusal in its own words", async () => {
    stubFetch(ROWS.map((r) => ({ ...r, isDefault: false })), { refuse: { status: 409, error: "Make another provider the default first." } });
    renderList();
    fireEvent.click(await screen.findByTestId("ai-provider-switch-clawai"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Make another provider the default first.");
  });

  // Every string on this card used to be hardcoded English, so a German box
  // read a German Settings page with one English card in the middle of it.
  // Resolve against the REAL German table rather than a hand-written map, so
  // this breaks if the card stops reading the catalogue.
  it("reads its copy from the catalogue — a German box sees German", async () => {
    stubFetch(ROWS, { locale: "de" });
    const de = translations.de;
    renderList();
    expect(await screen.findByText(de["settings.providers.title"])).toBeInTheDocument();
    expect(screen.getByText(de["settings.providers.hint"])).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-anthropic")).toHaveTextContent(de["settings.providers.switchedOff"]);
    expect(screen.getByTestId("ai-provider-default-clawai")).toHaveTextContent(de["settings.providers.default"]);
    expect(screen.getByTestId("ai-provider-make-default-openai")).toHaveTextContent(de["settings.providers.makeDefault"]);
    expect(screen.getByTestId("ai-provider-switch-clawai")).toHaveAttribute("title", de["settings.providers.lockedHint"]);
    expect(screen.getByTestId("ai-provider-switch-openai")).toHaveAccessibleName(
      de["settings.providers.enable"].replace("{name}", "OpenAI"),
    );
  });

  it("says so in the owner's language when nothing is connected yet", async () => {
    stubFetch(ROWS.map((r) => ({ ...r, state: "disconnected", isDefault: false })), { locale: "fr" });
    renderList();
    expect(await screen.findByText(translations.fr["settings.providers.empty"])).toBeInTheDocument();
  });

  // TASK-663. "Nothing is connected yet" and "we have not been able to ask
  // yet" are different sentences, and this list could only say the first one:
  // an unprobed row cannot pass the connected/needs-sign-in filter, so a box
  // whose harness was still booting read as having no providers at all.
  it("waits rather than announcing an empty box while rows are still being checked", async () => {
    stubFetch(ROWS.map((r) => ({ ...r, state: "checking", isDefault: false })));
    renderList();

    expect(await screen.findByTestId("ai-provider-list-loading")).toBeInTheDocument();
    expect(screen.queryByText(translations.en["settings.providers.empty"])).not.toBeInTheDocument();
    // ...and it says WHICH wait this is. The window can run to the unit's own
    // TimeoutStartSec, and three unlabelled grey bars for that long are
    // indistinguishable from a page that has hung.
    const live = screen.getByTestId("ai-provider-list-checking");
    expect(live).toHaveTextContent(translations.en["settings.checking"]);
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the checking announcement MOUNTED once the rows settle, and empties it", async () => {
    // A live region that appears together with its text announces a node
    // insertion, which assistive tech may drop entirely; one that is already
    // mounted announces a text change, which it will not. Conditional mounting
    // is therefore the bug, and it is invisible to a test that only ever looks
    // while the text is there — so this looks while it is NOT.
    stubFetch(ROWS);
    renderList();
    await screen.findByTestId("ai-provider-openai");

    const live = screen.getByTestId("ai-provider-list-checking");
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("");
  });

  // The other half of TASK-663, and the reason `checking` cannot be a state
  // that never resolves: NOTHING emits a provider-change signal when a harness
  // finishes booting, so a panel opened during those seconds used to hold its
  // first answer until the customer navigated away and back. The hook goes
  // back on its own — on a bounded schedule, and only while there is something
  // left to check.
  it("re-asks on its own while rows are being checked, and stops once they settle", async () => {
    let rows: Record<string, unknown>[] = ROWS.map((r) => ({ ...r, state: "checking", isDefault: false }));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/setup-api/preferences")) return json({});
      if (url.startsWith("/setup-api/providers/status")) {
        return json({ harness: "hermes", providers: rows, defaultProvider: "clawai", degraded: false });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const statusCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/setup-api/providers/status")).length;

    renderList();
    await screen.findByTestId("ai-provider-list-loading");
    const asked = statusCalls();

    // The dashboard finished booting. No signal, no navigation — the row has
    // to appear because the hook asked again.
    rows = ROWS as unknown as Record<string, unknown>[];
    await waitFor(
      () => expect(screen.getByTestId("ai-provider-openai")).toBeInTheDocument(),
      { timeout: 4_000 },
    );
    expect(statusCalls()).toBeGreaterThan(asked);

    // ...and an answer with nothing left to check ends the polling, rather
    // than leaving a timer running against the box for the life of the panel.
    const settled = statusCalls();
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(statusCalls()).toBe(settled);
  });

  // A read that FAILED is no evidence the probe finished. Booking the next
  // retry only from the success path ended the loop on the first transient 500
  // — the setup server restarting itself is one — and froze the spinner on
  // screen for the life of the mount, with the box coming up seconds later and
  // nothing on the page noticing.
  it("keeps polling after a failed read while rows are still being checked", async () => {
    let answer: "checking" | "error" | "good" = "checking";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.startsWith("/setup-api/preferences")) return json({});
      if (url.startsWith("/setup-api/providers/status")) {
        if (answer === "error") return json({ error: "boom" }, 500);
        const rows = answer === "checking"
          ? ROWS.map((r) => ({ ...r, state: "checking", isDefault: false }))
          : ROWS;
        return json({ harness: "hermes", providers: rows, defaultProvider: "clawai", degraded: false });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderList();
    await screen.findByTestId("ai-provider-list-loading");

    // The poll that lands mid-outage fails; the one after it must still happen.
    answer = "error";
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument(), { timeout: 4_000 });

    answer = "good";
    await waitFor(
      () => expect(screen.getByTestId("ai-provider-openai")).toBeInTheDocument(),
      { timeout: 6_000 },
    );
  });
});

/**
 * TASK-663 — the client half of the same promise.
 *
 * The server says `checking` while an answer from the harness is still owed,
 * and that window is the unit's own: a dashboard sitting in `ExecStartPre` on a
 * loaded box can legitimately be starting for minutes, and systemd does not give
 * up before `TimeoutStartSec`. A client that gives up FIRST is the worst of the
 * three outcomes: the last poll is answered "still checking", nothing books
 * another read, and the panel holds spinner rows with no banner for the life of
 * the mount — no error to click, no state to read, and the box answering fine
 * ten seconds later.
 *
 * So the polling is bounded in RATE, never in COUNT: while the answer says
 * checking, the panel keeps asking, and the moment the answer changes it shows
 * what it got.
 */
describe("a checking answer that outlasts any fixed retry budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubSlowBoot(answer: () => "checking" | "settled") {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/setup-api/preferences")) return json({});
      if (url.startsWith("/setup-api/providers/status")) {
        const rows = answer() === "checking"
          ? ROWS.map((r) => ({ ...r, state: "checking", isDefault: false }))
          : ROWS;
        return json({ harness: "hermes", providers: rows, defaultProvider: "clawai", degraded: false });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return () =>
      fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/setup-api/providers/status")).length;
  }

  /** Fake time, one second at a time: each `act` exit is what lets React flush
   *  the state change a fired retry timer produced, and book the next one. */
  async function advance(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    }
  }

  it("keeps asking after a long run of failed reads, because a failed read is not an answer", async () => {
    // The setup server restarting itself — an in-app update does exactly this —
    // while the panel is open on a booting box. A failed read is no evidence the
    // probe finished, so the rows still say `checking`; a client that gives up
    // after N of them leaves the panel exactly where the fixed checking budget
    // used to: spinner rows, and (in `HermesProviderConfig`, whose error line
    // needs a NULL summary) no message at all.
    let answer: "checking" | "down" | "settled" = "checking";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.startsWith("/setup-api/preferences")) return json({});
      if (url.startsWith("/setup-api/providers/status")) {
        if (answer === "down") return json({ error: "restarting" }, 503);
        const rows = answer === "checking"
          ? ROWS.map((r) => ({ ...r, state: "checking", isDefault: false }))
          : ROWS;
        return json({ harness: "hermes", providers: rows, defaultProvider: "clawai", degraded: false });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const statusCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/setup-api/providers/status")).length;

    renderList();
    await advance(1_000);
    expect(screen.getByTestId("ai-provider-list-loading")).toBeInTheDocument();

    // Two minutes of 503s — far more consecutive failures than any fixed budget.
    answer = "down";
    await advance(120_000);
    const gaveUpAt = statusCalls();
    await advance(40_000);
    expect(statusCalls()).toBeGreaterThan(gaveUpAt);

    // ...and the box comes back, with nobody having navigated away.
    answer = "settled";
    await advance(30_000);
    expect(screen.getByTestId("ai-provider-openai")).toBeInTheDocument();
  });

  it("keeps asking for as long as the box says checking, and never freezes on the spinner", async () => {
    let answer: "checking" | "settled" = "checking";
    const statusCalls = stubSlowBoot(() => answer);

    renderList();
    await advance(1_000);
    expect(screen.getByTestId("ai-provider-list-loading")).toBeInTheDocument();

    // Two minutes of `checking` — well inside what the unit's TimeoutStartSec
    // allows, and three times the fixed budget the panel used to have. The
    // assertion is that the count keeps GROWING rather than that it passed some
    // threshold: any reinstated count would eventually be passed by a big
    // enough number and this would go green again.
    await advance(120_000);
    const afterTwoMinutes = statusCalls();
    expect(afterTwoMinutes).toBeGreaterThanOrEqual(12);
    await advance(120_000);
    expect(statusCalls()).toBeGreaterThan(afterTwoMinutes);

    // ...and when the box finally answers, the panel shows it. Nobody navigated
    // away and back; nothing emitted a signal.
    answer = "settled";
    await advance(30_000);
    expect(screen.getByTestId("ai-provider-openai")).toBeInTheDocument();
  });
});

/**
 * TASK-738 — a plugin with no row of its own.
 *
 * A core bump strands entries for plugins an older core BUNDLED and the
 * installed one does not; the gateway refuses readiness over them, so the
 * updater switches them off. `byteplus` has no Providers row and no Channels
 * row, so before this the only trace was a line in the update log — the owner
 * saw a provider that had silently stopped existing.
 */
describe("AiProviderList — plugins with no row of their own", () => {
  const STRANDED = [{
    pluginId: "byteplus",
    stage: "not-installed",
    reason: "plugin not installed: byteplus — install the official external plugin"
      + " with: openclaw plugins install @openclaw/byteplus-provider",
    atMs: 1_700_000_000_000,
  }];

  it("names the plugin, says why, and offers the Retry", async () => {
    stubFetch(ROWS, { unattachedRepairs: STRANDED });
    renderList();

    expect(await screen.findByTestId("plugin-repair-byteplus")).toBeInTheDocument();
    const group = screen.getByTestId("ai-provider-plugin-repairs");
    // The label, or a name the owner has never seen is just sitting in his
    // provider list with nothing saying what it is.
    expect(group).toHaveTextContent(translations.en["settings.providers.strandedPlugins"]);
    expect(group).toHaveTextContent("byteplus");
    expect(screen.getByTestId("plugin-repair-byteplus")).toHaveTextContent(/plugin not installed: byteplus/);
    expect(screen.getByTestId("plugin-repair-retry-byteplus")).toBeInTheDocument();
  });

  it("shows nothing at all on a box with none", async () => {
    stubFetch();
    renderList();
    expect(await screen.findByTestId("ai-provider-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-plugin-repairs")).not.toBeInTheDocument();
  });
});

describe("a provider the box can run no model from", () => {
  /**
   * TASK-668, the owner's ruling: a row whose every model the gateway would
   * refuse is not part of "what is connected".
   *
   * The hiding is HERE rather than in the payload. The server names such
   * providers in `unrunnable` and keeps their rows, so the Connect panel below
   * can still offer one with its real connection label and its switch —
   * dropping the row server-side took both away, and connecting is the way out
   * of the state that hid it.
   */
  it("leaves it out of the list, and leaves the rest alone", async () => {
    stubFetch(ROWS, { unrunnable: ["openai"] });

    render(<I18nProvider><AiProviderList /></I18nProvider>);

    await waitFor(() => expect(screen.getByTestId("ai-provider-clawai")).toBeInTheDocument());
    expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-anthropic")).toBeInTheDocument();
  });

  it("shows every row when the box has named none", async () => {
    stubFetch(ROWS, { unrunnable: [] });

    render(<I18nProvider><AiProviderList /></I18nProvider>);

    await waitFor(() => expect(screen.getByTestId("ai-provider-openai")).toBeInTheDocument());
    expect(screen.getByTestId("ai-provider-anthropic")).toBeInTheDocument();
  });
});
