// INV-1: nothing reaches a speech bubble unless it is script-compatible with
// the locale the UI is rendering.
//
// On beta the mascot rendered whatever string it picked, so a Bulgarian line
// inside the English phrase bag (mascot-phrases.ts:69) and the Bulgarian
// frenzy quotes hardcoded in this component appeared on English boxes — and
// on Japanese, German, Swedish ones too.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";
import { classifyScript } from "@/lib/mascot-language";
import { neutral } from "@/lib/mascot-packs/neutral";

let locale = "en";
vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale }) }));
vi.mock("@/lib/client-kv", () => ({
  get: () => null,
  getJSON: () => null,
  set: vi.fn(),
  setJSON: vi.fn(),
  remove: vi.fn(),
}));

// A phrase set in the locale under test, so the fallbacks the component uses
// are locale-correct too.
const JAPANESE_POWER = ["⚡ 最強のカニ", "👑 我こそが箱"];
vi.mock("@/lib/mascot-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mascot-client")>("@/lib/mascot-client");
  const { neutral: neutralPack } = await import("@/lib/mascot-packs/neutral");
  return {
    ...actual,
    fetchUserName: () => Promise.resolve(null),
    initialPhraseSet: () => neutralPack,
    fetchPhraseSet: async () =>
      locale === "ja" ? { ...neutralPack, power: JAPANESE_POWER } : neutralPack,
  };
});

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

function bubbleText(container: HTMLElement): string {
  const bubble = container.querySelector('[data-speech="1"]');
  return bubble?.textContent ?? "";
}

describe("Mascot render gate", () => {
  beforeEach(() => {
    locale = "en";
    installMatchMedia();
    vi.stubGlobal("requestAnimationFrame", () => 1 as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function mount() {
    const view = render(<Mascot />);
    await waitFor(() => expect(view.container.querySelector("img")).toBeTruthy());
    return view;
  }

  it("renders only English-compatible frenzy quotes on an English box", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await mount();

    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    await waitFor(() => expect(bubbleText(container)).not.toBe(""));

    const seen: string[] = [bubbleText(container)];
    for (let i = 0; i < 12; i += 1) {
      await act(async () => { vi.advanceTimersByTime(5000); });
      seen.push(bubbleText(container));
    }

    expect(seen.filter(Boolean).length).toBeGreaterThan(1);
    for (const text of seen.filter(Boolean)) {
      // The hardcoded frenzy easter egg contains Bulgarian lines; none of them
      // may reach an English bubble.
      expect(classifyScript(text), `"${text}" is not renderable on an English box`).not.toBe("cyrillic");
      expect(classifyScript(text), `"${text}" mixes scripts`).not.toBe("mixed");
    }
  });

  it("falls back to the locale's own phrases when no hardcoded quote fits", async () => {
    locale = "ja";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await mount();
    // Let the phrase fetch land before the frenzy picks its lines.
    await act(async () => { await Promise.resolve(); });

    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    await waitFor(() => expect(bubbleText(container)).not.toBe(""));

    const seen: string[] = [bubbleText(container)];
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { vi.advanceTimersByTime(5000); });
      seen.push(bubbleText(container));
    }

    for (const text of seen.filter(Boolean)) {
      expect(JAPANESE_POWER, `"${text}" is not a Japanese line`).toContain(text);
    }
  });

  it("renders only Bulgarian-compatible quotes on a Bulgarian box", async () => {
    // The mirror image of the first case: on beta the very first frenzy quote
    // ("💰💰💰 MONEY RAIN!!!") was English on every box, Bulgarian ones or not.
    locale = "bg";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await mount();

    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    await waitFor(() => expect(bubbleText(container)).not.toBe(""));

    const seen: string[] = [bubbleText(container)];
    for (let i = 0; i < 12; i += 1) {
      await act(async () => { vi.advanceTimersByTime(5000); });
      seen.push(bubbleText(container));
    }

    expect(seen.filter(Boolean).length).toBeGreaterThan(1);
    for (const text of seen.filter(Boolean)) {
      expect(["cyrillic", "neutral"], `"${text}" is not renderable on a Bulgarian box`)
        .toContain(classifyScript(text));
    }
  });

  it("seeds itself from the language-free pack, so the first bubble is never English", () => {
    // The component's initial refs are NEUTRAL_PACK — on beta they were the
    // English inspiration bag, which every non-English box rendered until the
    // first fetch landed.
    for (const phrase of neutral.sass) {
      expect(classifyScript(phrase)).toBe("neutral");
    }
  });
});
