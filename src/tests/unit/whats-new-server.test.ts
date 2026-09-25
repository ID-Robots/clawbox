import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHATS_NEW_RELEASE } from "@/lib/whats-new";

// TASK-1198: the What's New state when a read it depends on FAILS.
//
// Each of these used to fail the whole route with a 500, and the desktop drew
// nothing over a question only one section of the card asks. Now each has the
// safe answer for what it guards: a plan that cannot be read sells nothing,
// and a dismissal that cannot be read keeps the card hidden rather than
// bringing it back to an owner who closed it.
//
// Every dependency is replaced here, because the real config store never
// throws on a read (it swallows into `{}`) — these failures come from the
// harness-swap and plan-gate modules around it, and from a store that is
// replaced or wrapped some day. The route suite runs the real modules.

vi.mock("@/lib/config-store", () => ({
  CONFIG_ROOT: "/nonexistent-clawbox-root",
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/edition-source", () => ({ readEditionSource: vi.fn() }));
vi.mock("@/lib/harness-swap", () => ({
  readSwapPlan: vi.fn(),
  swapAllowed: vi.fn(),
  swapTargetFor: vi.fn(),
}));
vi.mock("@/lib/paid-plan-gate", () => ({ planGateFor: vi.fn() }));

async function load() {
  vi.resetModules();
  const store = await import("@/lib/config-store");
  const source = await import("@/lib/edition-source");
  const swap = await import("@/lib/harness-swap");
  const gate = await import("@/lib/paid-plan-gate");
  vi.mocked(store.get).mockResolvedValue(undefined);
  vi.mocked(source.readEditionSource).mockReturnValue({ edition: "openclaw", defaulted: false });
  vi.mocked(swap.readSwapPlan).mockResolvedValue({ tier: null, planNameKey: "free" } as never);
  vi.mocked(swap.swapTargetFor).mockReturnValue("hermes");
  vi.mocked(swap.swapAllowed).mockReturnValue(false);
  vi.mocked(gate.planGateFor).mockReturnValue({ required: true, satisfied: false, plan: null });
  return { ...(await import("@/lib/whats-new-server")), store, swap, gate };
}

/**
 * A box on the release line the card announces, so the card is shown whenever
 * nothing hides it. Derived, not a literal: a box on any other line is shown no
 * card at all, and every case below would pass for the wrong reason.
 */
const RUNNING_VERSION = `${WHATS_NEW_RELEASE}.0`;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // CONFIG_ROOT has no package.json, so this is the running version.
  process.env.NEXT_PUBLIC_APP_VERSION = RUNNING_VERSION;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  warn.mockRestore();
});

describe("whats-new-server — a read that fails", () => {
  it("offers both lines when every read answers (the baseline the cases below depart from)", async () => {
    const { readWhatsNewState } = await load();
    expect(await readWhatsNewState()).toEqual({
      show: true,
      release: WHATS_NEW_RELEASE,
      version: RUNNING_VERSION,
      edition: "openclaw",
      cta: { paidFeatures: true, editionSwitch: "hermes" },
      freeMonthCode: null,
    });
  });

  it("still shows the card, with no plan section, when the swap plan cannot be read", async () => {
    const { readWhatsNewState, swap } = await load();
    vi.mocked(swap.readSwapPlan).mockRejectedValue(new Error("EIO: i/o error"));

    const state = await readWhatsNewState();

    expect(state).toEqual({
      show: true,
      release: WHATS_NEW_RELEASE,
      version: RUNNING_VERSION,
      edition: "openclaw",
      // Nothing sold that the box could not check the owner lacks.
      cta: { paidFeatures: false, editionSwitch: null },
      freeMonthCode: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the plan on record"), "EIO: i/o error");
  });

  it("still shows the card, with no plan section, when the plan gate cannot be judged", async () => {
    const { readWhatsNewState, gate } = await load();
    vi.mocked(gate.planGateFor).mockImplementation(() => {
      throw new Error("plan gate unavailable");
    });

    const state = await readWhatsNewState();

    expect(state.show).toBe(true);
    expect(state.cta).toEqual({ paidFeatures: false, editionSwitch: null });
    expect(state).not.toHaveProperty("unavailable");
  });

  it("keeps the card hidden, rather than bringing it back, when the dismissal cannot be read", async () => {
    const { readWhatsNewState, store } = await load();
    vi.mocked(store.get).mockRejectedValue(new Error("EACCES: permission denied"));

    const state = await readWhatsNewState();

    expect(state).toEqual({
      show: false,
      release: WHATS_NEW_RELEASE,
      version: RUNNING_VERSION,
      edition: "openclaw",
      cta: { paidFeatures: false, editionSwitch: null },
      freeMonthCode: null,
      unavailable: true,
    });
  });

  it("does not hand the fallback's plan section to the next answer", async () => {
    // `NO_PLAN_CTA` is shared; a caller that mutated one answer's `cta` must
    // not change what the next fallback offers.
    const { readWhatsNewState, swap } = await load();
    vi.mocked(swap.readSwapPlan).mockRejectedValue(new Error("EIO"));
    const first = await readWhatsNewState();
    first.cta.paidFeatures = true;

    expect((await readWhatsNewState()).cta).toEqual({ paidFeatures: false, editionSwitch: null });
  });
});
