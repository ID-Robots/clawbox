import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import HarnessPicker from "@/components/HarnessPicker";

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

afterEach(() => vi.unstubAllGlobals());

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
    expect(warning.textContent).toContain("without scanning");
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
