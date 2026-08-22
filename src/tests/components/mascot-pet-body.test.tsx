// Which body the mascot wears is an EDITION decision, and getting it wrong is
// visible on every desktop:
//
//   - OpenClaw is the largest install base and must be untouched: the crab, the
//     crab's CSS animations, and no pet code at all.
//   - Hermes wears the Hermes pet. It must never flash the crab while the pet
//     status is still in flight, and it must not fall back to the crab when
//     nothing is installed — the crab is ClawBox's own brand, not a placeholder
//     for a device running someone else's harness.

import { type ComponentProps } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";
import PetSprite, { PET_BODY_PX } from "@/components/PetSprite";
import { invalidatePetStatus } from "@/lib/pet-client";
import { CODEX_STATE_ROWS, LEGACY_STATE_ROWS } from "@/lib/pet-state-map";

vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale: "en", localeResolved: true }) }));
vi.mock("@/lib/client-kv", () => ({
  get: () => null,
  getJSON: () => null,
  set: vi.fn(),
  setJSON: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/mascot-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mascot-client")>("@/lib/mascot-client");
  const { neutral } = await import("@/lib/mascot-packs/neutral");
  return {
    ...actual,
    fetchUserName: () => Promise.resolve(null),
    initialPhraseSet: () => neutral,
    fetchPhraseSet: async () => neutral,
  };
});

const CODEX_PET = {
  slug: "boba",
  displayName: "Boba",
  submittedBy: "railly",
  revision: "123:456",
  frameW: 192,
  frameH: 208,
  cols: 8,
  rows: 9,
  framesPerState: 6,
  loopMs: 1100,
};

function stubPetsRoute(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).startsWith("/setup-api/pets")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

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

beforeEach(() => {
  invalidatePetStatus();
  installMatchMedia();
  vi.stubGlobal("requestAnimationFrame", () => 1 as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  invalidatePetStatus();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("edition gating", () => {
  it("keeps the crab, and only the crab, on OpenClaw", async () => {
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    expect(container.querySelector("[data-pet]")).toBeNull();
  });

  it("keeps the crab's own CSS body animation on OpenClaw", async () => {
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    const styled = Array.from(container.querySelectorAll("[style]"))
      .map((el) => el.getAttribute("style") ?? "")
      .join(" ");
    expect(styled).toContain("mascot-");
  });

  it("runs no wrapper keyframe on a pet — it animates by stepping frames", async () => {
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
    const styled = Array.from(container.querySelectorAll("[style]"))
      .map((el) => el.getAttribute("style") ?? "")
      .join(" ");
    // The crab's keyframes transform a whole image; applying one to a
    // spritesheet would wobble the sheet instead of selecting a frame.
    expect(styled).not.toContain("mascot-idle");
    expect(styled).not.toContain("mascot-waddle");
  });

  it("wears the pet and never the crab on Hermes", async () => {
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
    expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeNull();
  });

  it("shows no mascot at all on a Hermes box with no pet picked yet", async () => {
    // A fresh Hermes device installs no pet (the first one is a ~2.2 MB
    // download), and the crab is not a stand-in for it.
    stubPetsRoute({ supported: true, edition: "hermes", enabled: false, active: null });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-pet]")).toBeNull());
    expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeNull();
  });

  it("does not flash the crab while the edition is still unknown", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })),
    );
    const { container } = render(<Mascot />);
    expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeNull();
    resolveFetch({ ok: true, json: () => Promise.resolve({ supported: false, edition: "openclaw", enabled: false, active: null }) });
    await waitFor(() => expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
  });

  it("falls back to the crab when the pets route cannot be reached", async () => {
    // An unreachable route is indistinguishable from "no Hermes", and a device
    // whose mascot vanished on a transient error would look broken.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("boom"))));
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
  });

  it("keeps the ClawBox prop for the crab and takes it away from a pet", async () => {
    // The little ClawBox is the CRAB's: it kicks it, climbs it and drags it
    // about. A Hermes pet is not ClawBox's mascot and does not carry our
    // hardware around, so the prop is not rendered at all for one.
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const crab = render(<Mascot />);
    await waitFor(() => expect(crab.container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    expect(crab.container.querySelector('img[src="/clawbox-box.png"]')).toBeTruthy();

    cleanup();
    invalidatePetStatus();
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const withPet = render(<Mascot />);
    await waitFor(() => expect(withPet.container.querySelector('[data-pet="boba"]')).toBeTruthy());
    expect(withPet.container.querySelector('img[src="/clawbox-box.png"]')).toBeNull();
  });

  // The mascot's resting `bottom` is measured off the element the bottom bar
  // marks with `data-mascot-ground` (ChromeShelf), so a pet keeps standing on
  // the shelf as its safe-area inset or the viewport changes. The crab keeps
  // its 8px desktop shelf and never reads the bar at all.
  function installShelf() {
    const bar = document.createElement("div");
    bar.setAttribute("data-mascot-ground", "");
    bar.getBoundingClientRect = () => ({
      top: 700, bottom: 800, left: 0, right: 1000, width: 1000, height: 100, x: 0, y: 700,
      toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(bar);
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    return () => bar.remove();
  }

  it("leaves the crab on the desktop floor, ignoring the bottom bar", async () => {
    const removeShelf = installShelf();
    try {
      stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
      const { container } = render(<Mascot />);
      await waitFor(() => {
        const shell = container.querySelector('[data-mascot="crab"]') as HTMLElement | null;
        expect(shell?.style.bottom).toBe("8px");
      });
    } finally {
      removeShelf();
    }
  });

  it("stands a pet on the bottom bar's top edge", async () => {
    const removeShelf = installShelf();
    try {
      stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
      const { container } = render(<Mascot />);
      await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
      // 800 (viewport) - 700 (bar top) = the bar's top edge, from the bottom.
      await waitFor(() => {
        const shell = container.querySelector('[data-mascot="pet"]') as HTMLElement | null;
        expect(shell?.style.bottom).toBe("100px");
      });
    } finally {
      removeShelf();
    }
  });

  it("gives a pet a smaller body box than the crab's, and leaves the crab's at 150", async () => {
    // Everything anchored to the body — the speech bubble, the damage numbers,
    // the power-stance particles — is measured off this box, so it is the one
    // number that has to differ between the two mascots. The crab's stays 150
    // exactly: OpenClaw's rendering must not move by a pixel.
    expect(PET_BODY_PX).toBeLessThan(150);

    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const withPet = render(<Mascot />);
    await waitFor(() => expect(withPet.container.querySelector('[data-pet="boba"]')).toBeTruthy());
    const petBody = withPet.container.querySelector('[data-pet]')?.parentElement as HTMLElement;
    expect(petBody.style.width).toBe(`${PET_BODY_PX}px`);
    expect(petBody.style.height).toBe(`${PET_BODY_PX}px`);

    cleanup();
    invalidatePetStatus();
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const crab = render(<Mascot />);
    await waitFor(() => expect(crab.container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    const crabBody = crab.container.querySelector('img[src="/clawbox-crab.png"]')?.parentElement as HTMLElement;
    expect(crabBody.style.width).toBe("150px");
    expect(crabBody.style.height).toBe("150px");
  });

  it("re-reads the pet when Settings announces a pick", async () => {
    stubPetsRoute({ supported: true, edition: "hermes", enabled: false, active: null });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-pet]")).toBeNull());

    invalidatePetStatus();
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    window.dispatchEvent(new Event("clawbox-pet-changed"));
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
  });
});

describe("PetSprite", () => {
  function sprite(props: Partial<ComponentProps<typeof PetSprite>> = {}) {
    const { container } = render(
      <PetSprite pet={CODEX_PET} state="idle" facing="right" {...props} />,
    );
    return container.querySelector("[data-pet]") as HTMLElement;
  }

  // jsdom's CSS engine drops several of the shorthands React writes here
  // (`animation`, `background-size`), so assert on the style ATTRIBUTE — the
  // string the browser actually receives — rather than on the parsed CSSOM.
  const css = (el: HTMLElement) => el.getAttribute("style") ?? "";

  it("points at the device's own sprite route, never at the Petdex CDN", async () => {
    const style = css(sprite());
    expect(style).toContain("/setup-api/pets/sprite?slug=boba");
    // The revision is the cache key: re-installing a pet changes it and busts
    // the year-long immutable cache.
    expect(style).toContain("rev=123%3A456");
    expect(style).not.toContain("petdex");
  });

  it("sizes the sheet from the pet's own grid and steps the frames", async () => {
    const style = css(sprite());
    // Every sheet is normalised to PET_BODY_PX tall per cell, whatever its
    // own grid; 8 cols x 9 rows of that size here.
    expect(style).toContain(`height: ${PET_BODY_PX}px`);
    expect(style).toContain(`background-size: ${8 * (PET_BODY_PX * 192 / 208)}px ${9 * PET_BODY_PX}px`);
    expect(style).toContain("steps(6)");
    expect(style).toContain("1100ms");
    expect(style).toContain("pixelated");
  });

  it("selects the row for the mood", async () => {
    expect(sprite({ state: "idle" }).dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("idle")));
    expect(sprite({ state: "facepalm" }).dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("failed")));
    expect(sprite({ state: "dance" }).dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("waving")));
    expect(sprite({ state: "idle", thinking: true }).dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("review")));
  });

  it("cancels the shell's facing flip when it uses a directional row", async () => {
    // The mascot shell applies scaleX(-1) to face left. A `running-left` row
    // already faces left, so honouring both would mirror the pet the wrong way.
    const left = sprite({ state: "waddle", facing: "left" });
    expect(left.dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("running-left")));
    expect(css(left)).toContain("scaleX(-1)");

    const right = sprite({ state: "waddle", facing: "right" });
    expect(right.dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("running-right")));
    expect(css(right)).toContain("scaleX(1)");
  });

  it("renders a legacy 8-row sheet on its own taxonomy", async () => {
    const legacy = { ...CODEX_PET, slug: "old-pet", cols: 9, rows: 8 };
    const { container } = render(<PetSprite pet={legacy} state="waddle" facing="right" />);
    const el = container.querySelector("[data-pet]") as HTMLElement;
    expect(el.dataset.petRow).toBe(String(LEGACY_STATE_ROWS.indexOf("run")));
    // No directional rows on this shape, and the generic run row faces left by
    // convention — so rightward travel IS mirrored, and the shell adds no flip.
    expect(css(el)).toContain("scaleX(-1)");
    expect(css(el)).toContain(`background-size: ${9 * (PET_BODY_PX * 192 / 208)}px ${8 * PET_BODY_PX}px`);
  });

  it("renders whatever geometry a pet declares", async () => {
    // The curated "sprite-v2" atlases are 8x11. Those extra rows are never
    // indexed (upstream clamps the same way) but the sheet still has to be
    // laid out at its real size or every row lands off by a fraction.
    const v2 = { ...CODEX_PET, slug: "kebo", cols: 8, rows: 11 };
    const { container } = render(<PetSprite pet={v2} state="idle" facing="right" />);
    const el = container.querySelector("[data-pet]") as HTMLElement;
    expect(css(el)).toContain(`background-size: ${8 * (PET_BODY_PX * 192 / 208)}px ${11 * PET_BODY_PX}px`);
    expect(Number(el.dataset.petRow)).toBeLessThan(11);
  });
});
