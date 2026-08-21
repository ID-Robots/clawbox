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
let localeResolved = true;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale, localeResolved }) }));
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
const GERMAN_POWER = ["⚡ ALLMACHT!", "👑 KNIET NIEDER!"];

const { seedSpy, fetchSpy } = vi.hoisted(() => ({ seedSpy: vi.fn(), fetchSpy: vi.fn() }));
vi.mock("@/lib/mascot-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mascot-client")>("@/lib/mascot-client");
  const { neutral: neutralPack } = await import("@/lib/mascot-packs/neutral");
  return {
    ...actual,
    fetchUserName: () => Promise.resolve(null),
    initialPhraseSet: (l: string) => { seedSpy(l); return neutralPack; },
    fetchPhraseSet: async (l: string) => {
      fetchSpy(l);
      if (locale === "ja") return { ...neutralPack, power: JAPANESE_POWER };
      if (locale === "de") return { ...neutralPack, power: GERMAN_POWER };
      return neutralPack;
    },
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
    localeResolved = true;
    seedSpy.mockClear();
    fetchSpy.mockClear();
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

  it("speaks its own pack's power lines on a German box, not the English easter egg", async () => {
    // German is Latin-script, so a SCRIPT filter waves all 19 English frenzy
    // quotes straight through — "SHOW ME THE MONEY!" on a German box passes
    // every gate. Script compatibility says a line CAN be read in a locale,
    // never that it IS in that locale.
    locale = "de";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await mount();
    await act(async () => { await Promise.resolve(); });

    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    await waitFor(() => expect(bubbleText(container)).not.toBe(""));

    const seen: string[] = [bubbleText(container)];
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { vi.advanceTimersByTime(5000); });
      seen.push(bubbleText(container));
    }

    expect(seen.filter(Boolean).length).toBeGreaterThan(0);
    for (const text of seen.filter(Boolean)) {
      expect(GERMAN_POWER, `"${text}" is not one of the German pack's lines`).toContain(text);
    }
  });

  it("does not seed, fetch or speak until the UI knows its language", async () => {
    // Every I18nProvider starts at a PROVISIONAL "en" and only learns the real
    // locale when its preferences fetch resolves. Acting on that value seeded
    // a Bulgarian box from the full ENGLISH pack (`en` is the one pack bundled
    // statically, so `packForSync("en")` always hits) and fired
    // `GET ?locale=en`, which kicks off a ~3-minute on-device generation for a
    // language the box will never render — leaving the model busy when the
    // real locale's request arrives moments later.
    localeResolved = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await mount();
    await act(async () => { await Promise.resolve(); });

    expect(seedSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // And the gate is closed too: only script-neutral lines may render while
    // the language is unknown, so the frenzy easter egg stays silent.
    act(() => { window.dispatchEvent(new Event("clawbox-new-order")); });
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { vi.advanceTimersByTime(5000); });
      seen.push(bubbleText(container));
    }
    for (const text of seen.filter(Boolean)) {
      expect(classifyScript(text), `"${text}" is not language-free`).toBe("neutral");
    }
  });

  it("ships a language-free neutral pack for that first tick", () => {
    for (const phrase of neutral.sass) {
      expect(classifyScript(phrase)).toBe("neutral");
    }
  });
});
