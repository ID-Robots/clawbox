import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
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
  vi.unstubAllGlobals();
});

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
