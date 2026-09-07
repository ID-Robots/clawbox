import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import type { Locale } from "@/lib/i18n";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { translations } from "@/lib/translations";
import HarnessPicker from "@/components/HarnessPicker";

// The real English catalogue, so a key the card asks for that nobody added
// fails here instead of shipping the raw key to the owner.
/** The locale the card must format its timestamp for; "en" would prove nothing. */
const UI_LOCALE = "de";
/** When true, `t` answers the raw key — the state I18nProvider serves while its
    catalogue import is in flight, and forever if that import fails. */
let catalogueMissing = false;

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: UI_LOCALE,
    t: (key: string, params?: Record<string, string | number>) => {
      if (catalogueMissing) return key;
      const raw = translations.en[key] ?? key;
      return params ? raw.replace(/\{(\w+)\}/g, (m, name) => String(params[name] ?? m)) : raw;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/**
 * On a single-harness edition the picker collapses to a read-only badge. That
 * badge is then the only place the user is told whether their one agent engine
 * is actually up, so its dot has to follow the status route rather than being
 * decoration.
 */

function mockStatus(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
}

const locked = (healthy: boolean) => ({
  active: "hermes",
  locked: true,
  edition: "hermes",
  harnesses: [{ id: "hermes", label: "Hermes", healthy }],
});

afterEach(() => {
  catalogueMissing = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Fake timers that still let `findBy`/`waitFor` tick on their own, so a hold
 * or a poll interval is jumped over rather than waited out. Returns the
 * jump; the top-level afterEach puts the real clock back.
 */
function fakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
}

describe("HarnessPicker locked badge", () => {
  it("shows the harness as up when the status route says it is healthy", async () => {
    mockStatus(locked(true));
    render(<HarnessPicker />);

    const dot = await screen.findByTestId("harness-locked-dot");
    expect(dot.className).toContain("bg-emerald-400");
    expect(screen.getByText("Hermes")).toBeTruthy();
  });

  it("does not show a healthy dot when the only harness is down", async () => {
    mockStatus(locked(false));
    render(<HarnessPicker />);

    const dot = await screen.findByTestId("harness-locked-dot");
    expect(dot.className).not.toContain("bg-emerald-400");
    // Same muted dot the switcher uses for an unavailable harness.
    expect(dot.className).toContain("bg-white/25");
    expect(dot.getAttribute("title")).toContain("not running");
  });

  it("renders the switcher instead of the badge when the edition is not locked", async () => {
    mockStatus({
      active: "openclaw",
      locked: false,
      edition: "dual",
      harnesses: [
        { id: "openclaw", label: "OpenClaw", healthy: true },
        { id: "hermes", label: "Hermes", healthy: false },
      ],
    });
    render(<HarnessPicker />);

    await waitFor(() => expect(screen.getByText("OpenClaw")).toBeTruthy());
    expect(screen.queryByTestId("harness-locked-dot")).toBeNull();
  });

  // The status route's body is unvalidated JSON, and the list can be absent.
  // The picker sits in Settings → System, so a render throw here is not local:
  // it tears down the whole desktop tree and every panel goes blank. Fall back
  // to the bare id instead.
  it("still renders when the status response carries no harness list", async () => {
    mockStatus({ active: "hermes", locked: true });
    render(<HarnessPicker />);

    const dot = await screen.findByTestId("harness-locked-dot");
    expect(dot.className).toContain("bg-white/25");
    expect(screen.getByText("hermes")).toBeTruthy();
  });
});

/**
 * The card is also where a Hermes box says whether the agent is scanning shell
 * commands before it runs them. Both directions matter: a box whose scanner was
 * wiped by a factory reset has to say so, and a box whose scanner is ready must
 * stay silent, or the warning stops being read.
 */
describe("HarnessPicker shell-scan warning", () => {
  const withScan = (shellScan: unknown) => ({ ...locked(true), shellScan });

  it("warns when the agent is running shell commands without the scanner", async () => {
    mockStatus(withScan({ state: "off", reason: "not-installed", failOpen: true, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    const warning = await screen.findByTestId("shell-scan-warning");
    expect(warning.textContent).toContain("Shell command scanning is off");
    expect(warning.textContent).toContain("without checking them");
    // A security control not doing its job is an alert, not a status update.
    expect(warning.getAttribute("role")).toBe("alert");
  });

  it("tells the owner the agent will not even retry the download yet", async () => {
    // Upstream suppresses the re-download for 24 h after a failure, so
    // "connect it to the internet" is not the whole story.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    mockStatus(withScan({ state: "off", reason: "not-installed", failOpen: true, retrySuppressedUntil: until }));
    render(<HarnessPicker />);

    const warning = await screen.findByTestId("shell-scan-warning");
    expect(warning.textContent).toContain("will not retry the download before");
    // Formatted for the UI locale, not the runtime default — the rest of the
    // sentence is already in the owner's language.
    expect(warning.textContent).toContain(new Date(until).toLocaleString(UI_LOCALE));
  });

  it("falls back to English rather than showing a raw key if the catalogue never loaded", async () => {
    // I18nProvider answers t(key) === key until its dynamic import of the
    // catalogue resolves, and forever if it fails ("the device is offline
    // mid-update"). Everything else on this card is hardcoded English, so the
    // one sentence that says a security control is off would be the only thing
    // on screen rendering as `shellScan.offTitle`.
    catalogueMissing = true;
    mockStatus(withScan({ state: "off", reason: "not-installed", failOpen: true, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    const warning = await screen.findByTestId("shell-scan-warning");
    expect(warning.textContent).toContain("Shell command scanning is off");
    expect(warning.textContent).not.toContain("shellScan.");
  });

  it("says commands are BLOCKED, not merely unscanned, when the box fails closed", async () => {
    mockStatus(withScan({ state: "off", reason: "not-installed", failOpen: false, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    const warning = await screen.findByTestId("shell-scan-warning");
    expect(warning.textContent).toContain("Shell commands are blocked");
  });

  it("names the config switch when scanning was turned off deliberately", async () => {
    mockStatus(withScan({ state: "off", reason: "disabled-by-config", failOpen: true, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    expect((await screen.findByTestId("shell-scan-warning")).textContent).toContain("tirith_enabled");
  });

  it("does not call a failed settings read a security failure", async () => {
    // "We could not read the settings" is this box failing, not the control
    // being off — a polite live region, and wording that says so.
    mockStatus(withScan({ state: "unknown", reason: "config-unreadable", failOpen: true, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    const warning = await screen.findByTestId("shell-scan-warning");
    expect(warning.textContent).toContain("unknown");
    expect(warning.getAttribute("role")).toBe("status");
  });

  it("does NOT warn when the scanner is ready", async () => {
    mockStatus(withScan({ state: "on", reason: "ok", failOpen: true, retrySuppressedUntil: null }));
    render(<HarnessPicker />);

    await screen.findByTestId("harness-locked-dot");
    expect(screen.queryByTestId("shell-scan-warning")).toBeNull();
  });

  it("does NOT warn on a harness the route reports no scanner for", async () => {
    // OpenClaw has no tirith; the route answers null and the card must be quiet.
    mockStatus({ ...locked(true), shellScan: null });
    render(<HarnessPicker />);

    await screen.findByTestId("harness-locked-dot");
    expect(screen.queryByTestId("shell-scan-warning")).toBeNull();
  });
});

describe("HarnessPicker locked badge copy", () => {
  // The title, hint and buttons were keyed already; the "This edition" chip
  // beside the lock stayed a literal, so it was the one English word on a
  // German Harness page (locale sweep DE-2, 2026-09-07). With the catalogue
  // withheld, the chip must show the KEY it asked for — a literal would show
  // English here and pass every locale by accident.
  it("asks the catalogue for the 'This edition' chip rather than printing English", async () => {
    catalogueMissing = true;
    mockStatus(locked(true));
    render(<HarnessPicker />);

    await screen.findByTestId("harness-locked-dot");
    expect(screen.getByText("settings.harnessThisEdition")).toBeInTheDocument();
    expect(screen.queryByText("This edition")).toBeNull();
    expect(translations.en["settings.harnessThisEdition"]).toBe("This edition");
  });
});

/**
 * The swap (owner's ask, 2026-09-07): on a locked box the card draws BOTH
 * harnesses as tiles and a button that changes the box's edition through the
 * `harness_swap` root step, streamed by POST /setup-api/harness/swap. The
 * existing status route says which harness runs; the swap route's GET says
 * whether there is anything to swap to, whether one is under way, and what
 * plan the box is on.
 */
const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];

const lockedOpenclaw = (healthy = true) => ({
  active: "openclaw",
  locked: true,
  edition: "openclaw",
  harnesses: [{ id: "openclaw", label: "OpenClaw", healthy }],
});

const swapReady = (over: Record<string, unknown> = {}) => ({
  edition: "openclaw",
  active: "openclaw",
  locked: true,
  target: "hermes",
  swappable: true,
  inProgress: false,
  inProgressTarget: null,
  plan: { tier: "flash", planNameKey: "ai.planNamePro" },
  businessPlanRequired: false,
  allowed: true,
  ...over,
});

/** An NDJSON body the test feeds line by line, so the view between lines can be asserted. */
function ndjsonStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    body,
    push: (line: unknown) => controller?.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
    close: () => controller?.close(),
  };
}

type PostAnswer = { ok: boolean; status?: number; body?: ReadableStream<Uint8Array>; json?: () => Promise<unknown> };

/** fetch routed by URL and method — the status route, the swap GET, the swap POST. */
function mockRoutes(opts: { status: unknown; swap?: unknown; post?: PostAnswer }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/setup-api/harness/swap" && init?.method === "POST") {
      return opts.post ?? { ok: false, status: 500, json: async () => ({ error: "no POST stub" }) };
    }
    if (url === "/setup-api/harness/swap") {
      return opts.swap === undefined
        ? { ok: false, status: 404, json: async () => ({ error: "not found" }) }
        : { ok: true, status: 200, json: async () => opts.swap };
    }
    return { ok: true, status: 200, json: async () => opts.status };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const swapPosts = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === "/setup-api/harness/swap" && c.init?.method === "POST");
const swapReads = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === "/setup-api/harness/swap" && c.init?.method !== "POST");

async function openSwapDialog() {
  fireEvent.click(await screen.findByTestId("harness-swap-button"));
  return screen.findByTestId("harness-swap-dialog");
}

describe("HarnessPicker swap tiles", () => {
  it("draws both harnesses with their logos, marks this box, and offers the swap to the other", async () => {
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady() });
    const { container } = render(<HarnessPicker />);

    const openclaw = await screen.findByTestId("harness-tile-openclaw");
    const hermes = screen.getByTestId("harness-tile-hermes");
    expect(openclaw.querySelector('img[src="/openclaw-logo.svg"]')).not.toBeNull();
    expect(hermes.querySelector('img[src="/hermes-agent.png"]')).not.toBeNull();
    expect(openclaw.textContent).toContain("The OpenClaw gateway");
    expect(hermes.textContent).toContain("Hermes agent");

    // The chip and the health dot sit on the tile of the harness this box
    // runs, and the dot follows the status route as the badge's did.
    expect(openclaw.querySelector('[data-testid="harness-this-box"]')?.textContent).toBe("This box");
    expect(hermes.querySelector('[data-testid="harness-this-box"]')).toBeNull();
    expect(openclaw.querySelector('[data-testid="harness-tile-dot"]')?.className).toContain("bg-emerald-400");

    const button = screen.getByTestId("harness-swap-button");
    expect(hermes.contains(button)).toBe(true);
    expect(button.textContent).toContain("Switch to Hermes");
    expect(button.textContent).toContain("swap_horiz");

    // The plan row is the swap route's plan, named through its own key.
    const plan = screen.getByTestId("harness-swap-plan");
    expect(plan.textContent).toContain("Your plan: Pro plan");
    expect(plan.textContent).toContain("part of the Business plan");

    // The tiles replace the badge; they do not sit beside it.
    expect(screen.queryByTestId("harness-locked-dot")).toBeNull();
    expect(container.textContent).not.toMatch(/settings\.harness/);
  });

  it("keeps the muted dot on the active tile when the one harness is down", async () => {
    mockRoutes({ status: lockedOpenclaw(false), swap: swapReady() });
    render(<HarnessPicker />);

    const dot = await screen.findByTestId("harness-tile-dot");
    expect(dot.className).toContain("bg-white/25");
    expect(dot.getAttribute("title")).toContain("not running");
  });

  it("keeps the badge alone when the swap route says there is nothing to swap to", async () => {
    // A dual box switches at runtime and an edition nothing named cannot be
    // swapped: the route answers swappable false and the card shows what it
    // always showed.
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady({ target: null, swappable: false }) });
    render(<HarnessPicker />);

    await screen.findByTestId("harness-locked-dot");
    expect(screen.queryByTestId("harness-tile-openclaw")).toBeNull();
    expect(screen.queryByTestId("harness-swap-button")).toBeNull();
    expect(screen.queryByTestId("harness-swap-plan")).toBeNull();
  });

  it("keeps the badge alone on a server that has no swap route", async () => {
    mockRoutes({ status: lockedOpenclaw(true) });
    render(<HarnessPicker />);

    await screen.findByTestId("harness-locked-dot");
    expect(screen.queryByTestId("harness-swap-button")).toBeNull();
  });

  it("shows the in-progress row and no button while a swap is under way", async () => {
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady({ inProgress: true, inProgressTarget: "hermes" }) });
    render(<HarnessPicker />);

    const row = await screen.findByTestId("harness-swap-in-progress");
    expect(row.textContent).toContain("A swap to Hermes is in progress");
    expect(row.getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("harness-swap-button")).toBeNull();
    // Both tiles are still drawn — the row replaces the button, not the picture.
    expect(screen.getByTestId("harness-tile-hermes")).toBeTruthy();
  });

  it("polls while a swap is in progress and reloads once the box says it has ended", async () => {
    // The row is what a second tab (or one whose stream was lost) lands on,
    // and a swap takes minutes: read once, it outlived the swap on a page
    // whose cached edition was by then the wrong one.
    const advance = fakeClock();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/setup-api/harness/swap" && init?.method !== "POST") {
          reads += 1;
          // The first two reads see the unit still running; the third sees it gone.
          const running = reads < 3;
          return { ok: true, status: 200, json: async () => swapReady({ inProgress: running, inProgressTarget: running ? "hermes" : null }) };
        }
        return { ok: true, status: 200, json: async () => lockedOpenclaw(true) };
      }),
    );
    render(<HarnessPicker />);

    await screen.findByTestId("harness-swap-in-progress");
    expect(reads).toBe(1);
    await advance(5_000);
    await waitFor(() => expect(reads).toBe(2));
    expect(reload).not.toHaveBeenCalled();
    await advance(5_000);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Ended means ended: no further reads, no second reload.
    await advance(15_000);
    expect(reads).toBe(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("HarnessPicker swap dialog", () => {
  it("opens on the button, names the plan on Continue, and Cancel closes it without posting", async () => {
    const { calls } = mockRoutes({ status: lockedOpenclaw(true), swap: swapReady() });
    const { container } = render(<HarnessPicker />);

    const dialog = await openSwapDialog();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("Switch this box to Hermes");
    // Section 1: the Business-plan callout with the plan and the portal link.
    const callout = screen.getByTestId("harness-swap-callout");
    expect(callout.textContent).toContain("Pro plan");
    const link = screen.getByTestId("harness-swap-upgrade-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(PORTAL_DASHBOARD_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    // Section 2: what the swap does, in full.
    const steps = screen.getByTestId("harness-swap-steps");
    expect(steps.querySelectorAll("li").length).toBe(7);
    expect(steps.textContent).toContain("Hermes is installed from the internet");
    // Towards Hermes the persona DOES carry over (hermes_edition seeds the
    // shared identity from the OpenClaw workspace), so the promise stands here.
    expect(steps.textContent).toContain("what it knows about you carry over");
    expect(steps.textContent).toContain("Telegram approvals and other providers are per harness");
    expect(steps.textContent).toContain("The same button swaps back");
    expect(screen.getByTestId("harness-swap-continue").textContent).toContain("Continue on the Pro plan");
    expect(container.textContent).not.toMatch(/settings\.harness/);

    fireEvent.click(screen.getByTestId("harness-swap-cancel"));
    await waitFor(() => expect(screen.queryByTestId("harness-swap-dialog")).toBeNull());
    expect(swapPosts(calls)).toHaveLength(0);
  });

  it("closes on Escape while the question is up", async () => {
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady() });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("harness-swap-dialog")).toBeNull());
  });

  it("offers Upgrade alone when the plan does not allow the swap", async () => {
    mockRoutes({
      status: lockedOpenclaw(true),
      swap: swapReady({ businessPlanRequired: true, allowed: false }),
    });
    render(<HarnessPicker />);

    await openSwapDialog();
    const upgrade = screen.getByTestId("harness-swap-upgrade");
    expect(upgrade.getAttribute("href")).toBe(PORTAL_DASHBOARD_URL);
    expect(upgrade.textContent).toContain("Upgrade");
    expect(screen.queryByTestId("harness-swap-continue")).toBeNull();
    expect(screen.getByTestId("harness-swap-callout").textContent).toContain("needs the Business plan");
    // The card's note says the same, in place of "every plan can use it".
    expect(screen.getByTestId("harness-swap-plan").textContent).toContain("needs the Business plan");
    expect(screen.getByTestId("harness-swap-plan").textContent).not.toContain("every plan can use it");
    // Cancel is still the way out.
    expect(screen.getByTestId("harness-swap-cancel")).toBeTruthy();
  });

  it("posts the target, follows the stream phase by phase, and reloads on success", async () => {
    const stream = ndjsonStream();
    const { calls } = mockRoutes({
      status: lockedOpenclaw(true),
      swap: swapReady(),
      post: { ok: true, status: 200, body: stream.body },
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));

    await waitFor(() => expect(swapPosts(calls)).toHaveLength(1));
    expect(JSON.parse(String(swapPosts(calls)[0].init?.body))).toEqual({ harness: "hermes" });
    // The question is gone: no Cancel, no Continue, and the phase list is up
    // with the first phase pulsing.
    expect(screen.queryByTestId("harness-swap-cancel")).toBeNull();
    expect(screen.queryByTestId("harness-swap-continue")).toBeNull();
    expect(screen.getByTestId("harness-swap-phase-request").getAttribute("data-state")).toBe("current");
    // The Continue button that had focus is gone; focus must not have fallen
    // out of a panel that has just made everything else inert.
    const dialog = screen.getByTestId("harness-swap-dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.getElementById("harness-swap-title")?.textContent).toBe("Switching to Hermes…");

    await act(async () => {
      stream.push({ phase: "install", status: "Installing Hermes" });
      stream.push({ status: "hermes 0.9.1 ready" });
      // The step's own marker for its `done`, which the route forwards as a
      // plain line: a signal, not a sentence for the pane.
      stream.push({ status: "[harness-swap] phase=done" });
    });
    await screen.findByText("Installing Hermes");
    expect(screen.getByText("hermes 0.9.1 ready")).toBeTruthy();
    expect(screen.getByTestId("harness-swap-log").textContent).not.toContain("[harness-swap]");
    expect(screen.getByTestId("harness-swap-phase-request").getAttribute("data-state")).toBe("done");
    const install = screen.getByTestId("harness-swap-phase-install");
    expect(install.getAttribute("data-state")).toBe("current");
    expect(install.className).toContain("animate-pulse");
    expect(screen.getByTestId("harness-swap-phase-lock").getAttribute("data-state")).toBe("pending");
    expect(screen.getByTestId("harness-swap-dialog").textContent).toContain("cannot be cancelled");
    // Escape does nothing to a root step in flight.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("harness-swap-dialog")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      stream.push({ phase: "done", status: "Swap complete" });
      stream.push({ success: true, active: "hermes", reload: true, notes: [] });
      stream.close();
    });
    // Nothing to read: the short hold, then the reload.
    const done = await screen.findByTestId("harness-swap-done");
    expect(done.textContent).toContain("Done — reloading…");
    expect(document.getElementById("harness-swap-title")?.textContent).toBe("Switched to Hermes");
    expect(screen.queryByTestId("harness-swap-reload")).toBeNull();
    expect(screen.getByTestId("harness-swap-phase-done").getAttribute("data-state")).toBe("done");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 4_000 });
  });

  it("holds the notes behind a Reload button instead of reloading over them", async () => {
    // The notes name what the owner has to do next, nothing on the box shows
    // them again after the reload, and a swap is minutes long: an owner who
    // walked away must find them still there, not a desktop that threw them
    // away 1.5 s after it finished.
    const advance = fakeClock();
    const stream = ndjsonStream();
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady(), post: { ok: true, status: 200, body: stream.body } });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    await act(async () => {
      stream.push({ phase: "done", status: "Swap complete" });
      stream.push({
        success: true,
        active: "hermes",
        reload: true,
        notes: [
          "Telegram approvals are per harness — approve your account again",
          "Sign in to ClawBox AI again in Settings → Providers",
        ],
      });
      stream.close();
    });
    const done = await screen.findByTestId("harness-swap-done");
    expect(done.textContent).toContain("Before the desktop reloads");
    expect(done.textContent).toContain("approve your account again");
    expect(done.textContent).toContain("Sign in to ClawBox AI again");
    expect(done.textContent).not.toContain("reloading…");
    const button = screen.getByTestId("harness-swap-reload");
    expect(button.textContent).toContain("Reload now");
    await waitFor(() => expect(document.activeElement).toBe(button));

    await advance(60_000);
    expect(reload).not.toHaveBeenCalled();
    // Escape is still inert: the desktop behind is on the wrong harness
    // until the reload, and the button is the reload.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("harness-swap-dialog")).toBeTruthy();
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("counts the time the root step has been running", async () => {
    // A Hermes install is minutes of pip with long silences and the follow
    // forwards one journal line per poll, so without a clock the pane sits
    // unchanged for a minute with nothing to say the box is alive.
    const advance = fakeClock();
    const stream = ndjsonStream();
    const { calls } = mockRoutes({ status: lockedOpenclaw(true), swap: swapReady(), post: { ok: true, status: 200, body: stream.body } });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    await waitFor(() => expect(swapPosts(calls)).toHaveLength(1));
    expect(screen.getByTestId("harness-swap-elapsed").textContent).toContain("0:00");
    await advance(65_000);
    expect(screen.getByTestId("harness-swap-elapsed").textContent).toContain("Running for 1:05");
  });

  it("says the sentence and offers Close when the stream ends in an error", async () => {
    const stream = ndjsonStream();
    const { calls } = mockRoutes({
      status: lockedOpenclaw(true),
      swap: swapReady(),
      post: { ok: true, status: 200, body: stream.body },
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    await waitFor(() => expect(swapPosts(calls)).toHaveLength(1));
    const readsBefore = swapReads(calls).length;

    await act(async () => {
      stream.push({ phase: "install", status: "Installing Hermes" });
      stream.push({ error: "Hermes did not install: the installer exited 1. The box is still the openclaw edition." });
      stream.close();
    });
    const error = await screen.findByTestId("harness-swap-error");
    expect(error.textContent).toContain("Hermes did not install");
    expect(error.getAttribute("role")).toBe("alert");
    expect(reload).not.toHaveBeenCalled();
    // The heading is the dialog's accessible name: "Switching to Hermes…"
    // over a failure was announced as that contradiction.
    expect(document.getElementById("harness-swap-title")?.textContent).toBe("Switch this box to Hermes");
    // The one control the stage has takes the focus the stream took away.
    const close = screen.getByTestId("harness-swap-close");
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("harness-swap-dialog")).toBeNull());
    // A swap that failed may have changed the box: the card re-reads it.
    await waitFor(() => expect(swapReads(calls).length).toBeGreaterThan(readsBefore));
  });

  it("says the connection was lost — not that the swap failed — when the stream ends without a verdict", async () => {
    // The web server or the tunnel going away under the swap leaves the root
    // unit running: "the swap failed" here, then "in progress" on the card a
    // minute later, were two contradictory statements about one swap.
    const stream = ndjsonStream();
    const { calls } = mockRoutes({ status: lockedOpenclaw(true), swap: swapReady(), post: { ok: true, status: 200, body: stream.body } });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    await waitFor(() => expect(swapPosts(calls)).toHaveLength(1));
    await act(async () => {
      stream.push({ phase: "install", status: "Installing Hermes" });
      stream.close();
    });
    const error = await screen.findByTestId("harness-swap-error");
    expect(error.textContent).toContain("Lost the connection to the box");
    expect(error.textContent).toContain("may still be going");
    expect(error.textContent).not.toContain("The swap failed");
  });

  it("words the half-swapped verdict in the owner's language", async () => {
    // `lock_unchanged` is the one outcome that says the box may be half
    // swapped — the sentence that decides what the owner does next cannot
    // be the only English on a German panel.
    const stream = ndjsonStream();
    const { calls } = mockRoutes({ status: lockedOpenclaw(true), swap: swapReady(), post: { ok: true, status: 200, body: stream.body } });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    await waitFor(() => expect(swapPosts(calls)).toHaveLength(1));
    await act(async () => {
      stream.push({ error: "The root step finished, but the edition lock still says openclaw. See the ClawBox service log.", code: "lock_unchanged" });
      stream.close();
    });
    const error = await screen.findByTestId("harness-swap-error");
    expect(error.textContent).toContain("still reports its old edition");
    expect(error.textContent).not.toContain("edition lock still says");
  });

  it("does not promise the persona on the way back to OpenClaw, which runs no identity sync", async () => {
    // Only hermes_edition seeds the shared identity from the OpenClaw
    // workspace; the openclaw arm is install → lock → gateway_setup with no
    // sync, so a Hermes box swapping back is told what OpenClaw keeps, not
    // what the swap does not do.
    mockRoutes({ status: locked(true), swap: swapReady({ edition: "hermes", active: "hermes", target: "openclaw" }) });
    render(<HarnessPicker />);

    const dialog = await openSwapDialog();
    expect(dialog.textContent).toContain("Switch this box to OpenClaw");
    const steps = screen.getByTestId("harness-swap-steps");
    expect(steps.querySelectorAll("li").length).toBe(7);
    expect(steps.textContent).toContain("OpenClaw keeps the persona and memory of its own workspace");
    expect(steps.textContent).not.toContain("what it knows about you carry over");
  });

  it("words a refusal the box sent a code for in the owner's language", async () => {
    mockRoutes({
      status: lockedOpenclaw(true),
      swap: swapReady(),
      post: { ok: false, status: 409, json: async () => ({ error: "a coding run is live", code: "coding_run_live" }) },
    });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    const error = await screen.findByTestId("harness-swap-error");
    expect(error.textContent).toContain("A coding run is still working");
    expect(error.textContent).not.toContain("a coding run is live");
  });

  it("falls back to the box's own sentence for a refusal without a known code", async () => {
    mockRoutes({
      status: lockedOpenclaw(true),
      swap: swapReady(),
      post: { ok: false, status: 403, json: async () => ({ error: "Only the owner's browser may do this.", code: "cross_origin" }) },
    });
    render(<HarnessPicker />);

    await openSwapDialog();
    fireEvent.click(screen.getByTestId("harness-swap-continue"));
    expect((await screen.findByTestId("harness-swap-error")).textContent).toContain("Only the owner's browser");
  });
});

describe("HarnessPicker swap copy", () => {
  // Every string the swap draws is a key, and every key is in all ten packs:
  // a German desktop must not learn what a harness swap does in English.
  const NEW_KEYS = Object.keys(translations.en).filter(
    (key) => key.startsWith("settings.harnessTagline") || key.startsWith("settings.harnessThisBox") || key.startsWith("settings.harnessSwap"),
  );

  it("carries every swap key in all ten catalogues", () => {
    expect(NEW_KEYS.length).toBeGreaterThanOrEqual(46);
    for (const locale of LOCALES) {
      for (const key of NEW_KEYS) {
        expect(translations[locale][key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
    // The placeholders travel with the sentence.
    for (const locale of LOCALES) {
      expect(translations[locale]["settings.harnessSwapTo"]).toContain("{name}");
      expect(translations[locale]["settings.harnessSwapInProgress"]).toContain("{name}");
      expect(translations[locale]["settings.harnessSwapPlan"]).toContain("{plan}");
      expect(translations[locale]["settings.harnessSwapContinue"]).toContain("{plan}");
      expect(translations[locale]["settings.harnessSwapDoneTitle"]).toContain("{name}");
      expect(translations[locale]["settings.harnessSwapElapsed"]).toContain("{time}");
    }
  });

  it("asks the catalogue for every tile and dialog string rather than printing English", async () => {
    catalogueMissing = true;
    mockRoutes({ status: lockedOpenclaw(true), swap: swapReady() });
    const { container } = render(<HarnessPicker />);

    await openSwapDialog();
    const text = container.textContent ?? "";
    for (const key of ["settings.harnessThisBox", "settings.harnessSwapTo", "settings.harnessSwapPlan", "settings.harnessSwapContinue", "settings.harnessSwapStepBack"]) {
      expect(text).toContain(key);
    }
    expect(text).not.toContain("This box");
    expect(text).not.toContain("Switch to Hermes");
  });
});
