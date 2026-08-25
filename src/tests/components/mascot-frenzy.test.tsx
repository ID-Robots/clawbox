import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";
import { FRENZY_QUOTES } from "@/lib/mascot-frenzy";
import { en } from "@/lib/mascot-packs/en";

// The mascot pulls its name/phrases over the network and reads persisted UI
// state — stub both so the component mounts deterministically in jsdom.
vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale: "en", localeResolved: true }) }));
vi.mock("@/lib/client-kv", () => ({
  get: () => null,
  getJSON: () => null,
  set: vi.fn(),
  setJSON: vi.fn(),
}));
// Must resolve REAL phrase sets — the component reads `phrases.sass` on load
// and `phrases.power` during a frenzy. Dynamic-import the (unmocked) packs
// inside the factory so this survives vi.mock's hoisting above the imports.
vi.mock("@/lib/mascot-client", async () => {
  const { neutral } = await import("@/lib/mascot-packs/neutral");
  const { en } = await import("@/lib/mascot-packs/en");
  return {
    fetchUserName: () => Promise.resolve(null),
    initialPhraseSet: () => neutral,
    fetchPhraseSet: async () => en,
    pickNameGreeting: () => ({ template: "", text: "" }),
  };
});

// Drive `prefers-reduced-motion` per-test. matchMedia is consulted once on mount.
let reduceMotion = false;
function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

describe("Mascot frenzy — reduced-motion / freeze gating", () => {
  beforeEach(() => {
    reduceMotion = false;
    installMatchMedia();
    // Neutralize the self-scheduling frenzy walk loop so it can't spin in jsdom;
    // the frenzy *state* (which the accessibility gate controls) is set
    // synchronously and independently of the rAF loop.
    vi.stubGlobal("requestAnimationFrame", () => 1 as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function fireNewOrder() {
    act(() => {
      window.dispatchEvent(new Event("clawbox-new-order"));
    });
  }

  it("does NOT enter frenzy on a new order when prefers-reduced-motion is set", async () => {
    reduceMotion = true;
    const { container } = render(<Mascot />);
    // Let the mount effects (including the reduced-motion read) settle.
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());

    fireNewOrder();

    // The frenzy block never renders — the crab holds still for a
    // vestibular-sensitive user even though an order arrived.
    expect(container.querySelector('[data-frenzy="1"]')).toBeNull();
  });

  it("starts a frenzy normally, then cancels it when the crab freezes", async () => {
    const { container, rerender } = render(<Mascot frozen={false} />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());

    fireNewOrder();
    // Motion allowed → frenzy is live.
    await waitFor(() => expect(container.querySelector('[data-frenzy="1"]')).not.toBeNull());

    // Freezing mid-frenzy (e.g. chat opens) must tear the frenzy down, not just
    // block future ones.
    act(() => rerender(<Mascot frozen={true} />));
    await waitFor(() => expect(container.querySelector('[data-frenzy="1"]')).toBeNull());
  });

  // The mount schedules the crab's first ambient action 2 s later, and that
  // timer is NOT the one `handleNewOrder` cancels. An order inside that window
  // used to leave both loops running: the ambient action cleared the frenzy's
  // walk rAF and pushed its own idle/sleep line into the bubble, so a money
  // frenzy could read "💤". A frenzy now owns the crab until it ends.
  it("keeps the ambient action loop out of the bubble while the frenzy runs", async () => {
    // Math.random is pinned so the ambient action is a known one: pickAction
    // lands on `idle`, and getSpeech('idle') picks en.idle[6]. Unfixed, that
    // string reaches the bubble at t=2000ms.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ambientLine = en.idle[Math.floor(0.5 * en.idle.length)];
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    // Let the phrase fetch land so the frenzy quotes come from the en pack.
    await act(async () => { await Promise.resolve(); });

    fireNewOrder();
    await waitFor(() => expect(container.querySelector('[data-frenzy="1"]')).not.toBeNull());

    // Past the mount's 2 s first-action timer, still inside the first frenzy
    // quote's 4.5 s on screen.
    await act(async () => { vi.advanceTimersByTime(2500); });

    const bubble = container.querySelector('[data-speech="1"]')?.textContent ?? "";
    expect(bubble).not.toBe(ambientLine);
    expect(FRENZY_QUOTES.en).toContain(bubble);
    // …and the frenzy itself survived: the ambient action used to cancel its
    // walk loop on the way past.
    expect(container.querySelector('[data-frenzy="1"]')).not.toBeNull();

    vi.useRealTimers();
  });
});
