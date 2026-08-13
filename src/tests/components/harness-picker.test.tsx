import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import HarnessPicker from "@/components/HarnessPicker";

/**
 * On a single-harness edition the picker collapses to a read-only badge. That
 * badge is then the only place the user is told whether their one agent engine
 * is actually up, so its dot has to follow the status route rather than being
 * decoration.
 *
 * The dot is asserted through the `--set-*` role it paints, not a literal:
 * `--set-success` (cyan, DONE on every edition) for up, `--set-outline` (the
 * 3:1 control boundary) for down. What matters here is that the two states stay
 * distinguishable and follow the health flag — the palette behind the roles is
 * globals.css's business, and pinning a hue here is what previously kept this
 * component off the role layer.
 */
const UP = "bg-[var(--set-success)]";
const DOWN = "bg-[var(--set-outline)]";

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
    expect(dot.className).toContain(UP);
    expect(screen.getByText("Hermes")).toBeTruthy();
  });

  it("does not show a healthy dot when the only harness is down", async () => {
    mockStatus(locked(false));
    render(<HarnessPicker />);

    const dot = await screen.findByTestId("harness-locked-dot");
    expect(dot.className).not.toContain(UP);
    // Same muted dot the switcher uses for an unavailable harness.
    expect(dot.className).toContain(DOWN);
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
    expect(dot.className).toContain(DOWN);
    expect(screen.getByText("hermes")).toBeTruthy();
  });
});
