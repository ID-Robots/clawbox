import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";

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
    vi.unstubAllGlobals();
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
});
