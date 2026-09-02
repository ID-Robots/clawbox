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
import { render, waitFor, cleanup, fireEvent } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";
import PetSprite, { PET_BODY_PX } from "@/components/PetSprite";
import { invalidatePetStatus } from "@/lib/pet-client";
import { CODEX_STATE_ROWS, LEGACY_STATE_ROWS } from "@/lib/pet-state-map";
import type { PetRowMetrics } from "@/lib/pet-sheet-metrics";
import { CURATED_PETS } from "@/lib/pet-curated";

/** A row with `frames` real frames, each drawn `bottom` px above the cell floor. */
function row(frames: number, bottom: number, head = 148): PetRowMetrics {
  return { frames, bottom: new Array(frames).fill(bottom), head, left: 20, right: 20 };
}

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

/** A fresh Hermes box: pets supported, none picked — the state that wears the egg. */
const FRESH_HERMES = { supported: true, edition: "hermes", enabled: false, active: null };

/** The shape every installed Petdex sheet really has: `waving` (row 3) draws
 *  four frames, `jumping` (row 4) five, and every row insets its art. */
const MEASURED_PET = {
  ...CODEX_PET,
  rowMetrics: [
    row(6, 30), row(6, 12), row(6, 12), row(4, 8), row(5, 20),
    row(6, 30), row(6, 30), row(6, 12), row(6, 30),
  ],
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

  it("wears the egg, and never the crab, on a Hermes box with no pet picked yet", async () => {
    // A fresh Hermes device installs no pet (the first one is a ~2.2 MB
    // download). The crab is not a stand-in for it — it is ClawBox's own brand
    // and is not worn on someone else's harness — so the empty state is an egg,
    // which says "pick one" where a blank shelf said "something is broken".
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-mascot="egg"]')).toBeTruthy());
    expect(container.querySelector("[data-pet]")).toBeNull();
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
    // And specifically NOT the egg. The fail-open answers `supported: false`,
    // which is the same answer OpenClaw gives — an OpenClaw desktop that lost
    // the route for a moment must not sprout a Hermes egg.
    expect(container.querySelector('[data-mascot="egg"]')).toBeNull();
    // Nor the cube: the fallback is the crab on its own, like OpenClaw's.
    expect(container.querySelector('img[src="/clawbox-box.png"]')).toBeNull();
  });

  it("renders no ClawBox cube beside either body", async () => {
    // The little isometric ClawBox used to sit on the OpenClaw desktop as the
    // crab's prop — a 40px cube parked just above the taskbar that the crab
    // kicked and climbed. The owner wants the crab on its own, and a Hermes
    // pet never carried it, so no body renders the cube.
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const crab = render(<Mascot />);
    await waitFor(() => expect(crab.container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    expect(crab.container.querySelector('img[src="/clawbox-box.png"]')).toBeNull();

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

  it("hangs the bubble off the pet's visible head, not its cell", async () => {
    // Off the CELL, the same 26px gap read as 29px for a pet that fills its
    // cell and 56px for one drawn low in it (cash-cuy, mid-facepalm).
    const removeShelf = installShelf();
    try {
      stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: MEASURED_PET });
      const { container } = render(<Mascot />);
      const hit = await waitFor(() => {
        const el = container.querySelector("[data-mascot-hit]") as HTMLElement | null;
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      // A tap makes the mascot talk; the neutral pack is emoji-only, so the
      // language gate always lets it through whatever the locale.
      fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(hit, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      const bubble = await waitFor(() => {
        const el = container.querySelector('[data-speech="1"]')?.parentElement as HTMLElement | null;
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      // The idle row draws 148 source px of art -> 74 CSS px above the ground
      // line, plus the 26px gap. Nothing here is measured off the 104px cell.
      expect(bubble.style.bottom).toBe("100px");
    } finally {
      removeShelf();
    }
  });

  it("paints a pet below the window layer and the crab above the shelf", async () => {
    // Windows start at z 100 (page.tsx). At 10001 the pet painted over window
    // content — over the Settings sidebar, and over its own dock.
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const withPet = render(<Mascot />);
    await waitFor(() => expect(withPet.container.querySelector('[data-pet="boba"]')).toBeTruthy());
    const petShell = withPet.container.querySelector('[data-mascot="pet"]') as HTMLElement;
    expect(Number(petShell.style.zIndex)).toBeLessThan(100);
    // Only the drawn art is grabbable; the transparent rest of the box is not,
    // so a desktop icon standing behind it keeps its clicks.
    expect(petShell.style.pointerEvents).toBe("none");
    expect(withPet.container.querySelector("[data-mascot-hit]")).toBeTruthy();

    cleanup();
    invalidatePetStatus();
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const crab = render(<Mascot />);
    await waitFor(() => expect(crab.container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    const crabShell = crab.container.querySelector('[data-mascot="crab"]') as HTMLElement;
    expect(crabShell.style.zIndex).toBe("10001");
    expect(crabShell.style.pointerEvents).toBe("auto");
  });

  it("keeps one vertical convention: bottom is the ground line, always", async () => {
    // The old render swapped `bottom` between 0 and the ground depending on a
    // `physicsActive` flag the imperative loop also wrote to, and the two
    // disagreed — the mascot settled 56px sunk into the taskbar.
    const removeShelf = installShelf();
    try {
      stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
      const { container } = render(<Mascot />);
      await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
      const shell = await waitFor(() => {
        const el = container.querySelector('[data-mascot="pet"]') as HTMLElement;
        expect(el.style.bottom).toBe("100px");
        return el;
      });
      // ...and the height it is NOT carrying is in the transform, where the
      // physics loop writes it too.
      expect(shell.style.transform).toContain("translateY(0.00px)");
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
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-mascot="egg"]')).toBeTruthy());

    invalidatePetStatus();
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    window.dispatchEvent(new Event("clawbox-pet-changed"));
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
    // The egg is a placeholder for exactly one thing, and that thing arrived.
    expect(container.querySelector('[data-mascot="egg"]')).toBeNull();
  });

  // ── The fresh-box egg ──
  //
  // Hermes + pets supported + nothing picked. It is a placeholder, not a
  // mascot: no speech, no ClawBox prop, no roaming, and one job — get the
  // owner into Settings → Appearance.
  it("stands the egg on the bottom bar's top edge, not the desktop floor", async () => {
    const removeShelf = installShelf();
    try {
      stubPetsRoute(FRESH_HERMES);
      const { container } = render(<Mascot />);
      // Same ground line the pet uses: innerHeight 800 − the bar's top 700.
      await waitFor(() => {
        const egg = container.querySelector('[data-mascot="egg"]') as HTMLElement | null;
        expect(egg?.style.bottom).toBe("100px");
      });
    } finally {
      removeShelf();
    }
  });

  it("draws the egg from the bundled sheet, never from the Petdex CDN", async () => {
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-egg-sprite]")).toBeTruthy());
    const sprite = container.querySelector("[data-egg-sprite]") as HTMLElement;
    expect(sprite.style.backgroundImage).toContain("/pet-egg-sheet.png");
    const styled = Array.from(container.querySelectorAll("[style]"))
      .map((el) => el.getAttribute("style") ?? "")
      .join(" ");
    expect(styled).not.toContain("petdex");
  });

  it("never shows a cracked shell — the pet is not hatching yet", async () => {
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-egg-sprite]")).toBeTruthy());
    // Frames 9-11 are the crack and the burst. At 56px a cell, any offset at
    // or beyond -504px is one of them, and a cracking egg on a box where
    // nothing is hatching would be a lie about the device's state.
    const css = Array.from(container.querySelectorAll("style"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    const offsets = Array.from(css.matchAll(/background-position-y:(-?\d+)px/g)).map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) {
      expect(Math.abs(offset) / 56).toBeLessThanOrEqual(5);
    }
  });

  it("hatches a random curated pet on click — the picker no longer opens", async () => {
    let active: unknown = null;
    const selected: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/setup-api/pets/select")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string };
          selected.push(body.slug ?? "");
          active = { ...CODEX_PET, slug: body.slug, displayName: body.slug };
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, active }) } as Response);
        }
        if (u.startsWith("/setup-api/pets")) {
          const payload = active
            ? { supported: true, edition: "hermes", enabled: true, active }
            : FRESH_HERMES;
          return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
      }),
    );
    const rand = vi.spyOn(Math, "random").mockReturnValue(0);
    const opened: string[] = [];
    const onOpenApp = (e: Event) => opened.push((e as CustomEvent).detail?.appId);
    window.addEventListener("clawbox:open-app", onOpenApp);
    try {
      const { container } = render(<Mascot />);
      await waitFor(() => expect(container.querySelector("[data-egg-hatch]")).toBeTruthy());
      fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
      // The pick persists through the SAME route the Settings picker uses.
      await waitFor(() => expect(selected).toEqual([CURATED_PETS[0].slug]));
      // The burst steps into the crack frames the idle loop must never reach.
      await waitFor(
        () => {
          const sprite = container.querySelector("[data-egg-sprite]") as HTMLElement;
          expect(["-504px", "-560px", "-616px"]).toContain(sprite.style.backgroundPositionY);
        },
        { timeout: 2000 },
      );
      // The chosen pet takes the shelf, and the egg is gone.
      await waitFor(
        () => expect(container.querySelector(`[data-pet="${CURATED_PETS[0].slug}"]`)).toBeTruthy(),
        { timeout: 3000 },
      );
      expect(container.querySelector('[data-mascot="egg"]')).toBeNull();
      // Hatching REPLACED the picker shortcut; Settings did not open.
      expect(opened).toEqual([]);
    } finally {
      window.removeEventListener("clawbox:open-app", onOpenApp);
      rand.mockRestore();
    }
  });

  it("draws from the whole curated list — the top of the range lands the last pet, never 'none'", async () => {
    const selected: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/setup-api/pets/select")) {
          selected.push((JSON.parse(String(init?.body ?? "{}")) as { slug?: string }).slug ?? "");
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response);
        }
        if (u.startsWith("/setup-api/pets")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(FRESH_HERMES) } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
      }),
    );
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      const { container } = render(<Mascot />);
      await waitFor(() => expect(container.querySelector("[data-egg-hatch]")).toBeTruthy());
      fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
      await waitFor(() => expect(selected).toEqual([CURATED_PETS[CURATED_PETS.length - 1].slug]));
      // Every outcome is a real curated pet; "no pet" is not in the pool.
      expect(CURATED_PETS.some((p) => p.slug === selected[0])).toBe(true);
      expect(selected[0]).not.toBe("");
    } finally {
      rand.mockRestore();
    }
  });

  it("falls back to a plain fade swap under prefers-reduced-motion", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    let active: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/setup-api/pets/select")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string };
          active = { ...CODEX_PET, slug: body.slug, displayName: body.slug };
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, active }) } as Response);
        }
        if (u.startsWith("/setup-api/pets")) {
          const payload = active
            ? { supported: true, edition: "hermes", enabled: true, active }
            : FRESH_HERMES;
          return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
      }),
    );
    const rand = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const { container } = render(<Mascot />);
      await waitFor(() => expect(container.querySelector("[data-egg-hatch]")).toBeTruthy());
      fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
      // No crack frames: the egg fades instead of stepping the hatch cells.
      await waitFor(() => {
        expect(container.querySelector('[data-mascot="egg"]')?.getAttribute("data-egg-phase")).toBe("fading");
      });
      const sprite = container.querySelector("[data-egg-sprite]") as HTMLElement;
      expect(sprite.style.backgroundPositionY).toBe("0px");
      await waitFor(
        () => expect(container.querySelector(`[data-pet="${CURATED_PETS[0].slug}"]`)).toBeTruthy(),
        { timeout: 2000 },
      );
    } finally {
      rand.mockRestore();
    }
  });

  it("puts the egg back and says why when the install fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url);
        if (u.startsWith("/setup-api/pets/select")) {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: "x" }) } as Response);
        }
        if (u.startsWith("/setup-api/pets")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(FRESH_HERMES) } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${u}`));
      }),
    );
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-egg-hatch]")).toBeTruthy());
    fireEvent.click(container.querySelector("[data-egg-hatch]") as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[data-mascot="egg"]')?.getAttribute("data-egg-phase")).toBe("idle");
      expect(container.querySelector("[data-egg-hint]")?.textContent).toBe("settings.mascot.petInstallFailed");
    });
  });

  it("labels the egg from the locale, and shows the hint on hover", async () => {
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector("[data-egg-hatch]")).toBeTruthy());
    const button = container.querySelector("[data-egg-hatch]") as HTMLElement;
    // The i18n mock answers with the key, so this asserts the key is the one
    // the parity test guards rather than a hardcoded English string.
    expect(button.getAttribute("aria-label")).toBe("settings.mascot.eggHatch");

    expect(container.querySelector("[data-egg-hint]")).toBeNull();
    fireEvent.mouseEnter(button);
    await waitFor(() => expect(container.querySelector("[data-egg-hint]")?.textContent).toBe("settings.mascot.eggHatch"));
    fireEvent.mouseLeave(button);
    await waitFor(() => expect(container.querySelector("[data-egg-hint]")).toBeNull());
  });

  it("gives the egg no speech bubble and no ClawBox prop", async () => {
    stubPetsRoute(FRESH_HERMES);
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-mascot="egg"]')).toBeTruthy());
    // The prop is the CRAB's, and an egg has nothing to say until it is one.
    // The speech bubble, the drag hit box and the physics all live inside the
    // mascot shell, so asserting the shell itself never renders covers the lot.
    expect(container.querySelector('img[src="/clawbox-box.png"]')).toBeNull();
    expect(container.querySelector('[data-mascot="crab"]')).toBeNull();
    expect(container.querySelector('[data-mascot="pet"]')).toBeNull();
    expect(container.querySelector("[data-mascot-hit]")).toBeNull();
  });

  it("keeps the egg off OpenClaw entirely", async () => {
    stubPetsRoute({ supported: false, edition: "openclaw", enabled: false, active: null });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy());
    expect(container.querySelector('[data-mascot="egg"]')).toBeNull();
  });

  it("keeps the egg away once a pet is active", async () => {
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());
    expect(container.querySelector('[data-mascot="egg"]')).toBeNull();
  });

  it("brings the egg back if the active pet goes away", async () => {
    stubPetsRoute({ supported: true, edition: "hermes", enabled: true, active: CODEX_PET });
    const { container } = render(<Mascot />);
    await waitFor(() => expect(container.querySelector('[data-pet="boba"]')).toBeTruthy());

    invalidatePetStatus();
    stubPetsRoute(FRESH_HERMES);
    window.dispatchEvent(new Event("clawbox-pet-changed"));
    await waitFor(() => expect(container.querySelector('[data-mascot="egg"]')).toBeTruthy());
    expect(container.querySelector("[data-pet]")).toBeNull();
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
    expect(style).toContain("1100ms");
    expect(style).toContain("pixelated");
  });

  it("scales the 208px cell by exactly a half, so the frames step on integers", async () => {
    // 112/208 = 0.538461…: `round(6 * 103.3846) / 6` drifted a quarter pixel by
    // the last frame, and a fractional step under `image-rendering: pixelated`
    // re-rounded which source rows survived — a foot line that jittered.
    expect(PET_BODY_PX / 208).toBe(0.5);
    expect(Number.isInteger((PET_BODY_PX * 192) / 208)).toBe(true);
  });

  it("steps only the frames a row really draws, never a blank cell", async () => {
    // Every installed sheet leaves r3c4, r3c5 and r4c5 empty. Stepped as six,
    // the pet rendered NOTHING for 2/6 of the waving loop and 1/6 of jumping.
    const waving = render(<PetSprite pet={MEASURED_PET} state="dance" facing="right" />);
    const el = waving.container.querySelector("[data-pet]") as HTMLElement;
    expect(el.dataset.petRow).toBe(String(CODEX_STATE_ROWS.indexOf("waving")));
    expect(el.dataset.petFrames).toBe("4");
    // Four frames at the sheet's own frame rate, not four stretched over six.
    expect(css(el)).toContain(`${Math.round((1100 * 4) / 6)}ms`);
    // The last drawn column, and no further.
    const keyframes = waving.container.querySelector("style")?.textContent ?? "";
    expect(keyframes).toContain(`background-position-x:${-3 * ((PET_BODY_PX * 192) / 208)}px`);
    expect(keyframes).not.toContain(`background-position-x:${-4 * ((PET_BODY_PX * 192) / 208)}px`);
  });

  it("puts each frame's own feet on the ground line", async () => {
    // The cell is aligned to the bar; the ART is inset above the cell floor by
    // a different amount per row, so aligning the cell floated every pet.
    const jumping = render(<PetSprite pet={MEASURED_PET} state="jump" facing="right" />);
    const el = jumping.container.querySelector("[data-pet]") as HTMLElement;
    const keyframes = jumping.container.querySelector("style")?.textContent ?? "";
    // row 4 insets its art 20 source px; at a half scale that is 10 CSS px of
    // downward shift, carried by the SAME animation that selects the frame.
    expect(keyframes).toContain("bottom:-10px");
    expect(css(el)).toContain("bottom: -10px");
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

  it("keeps the un-measured cell geometry for a descriptor with no metrics", async () => {
    // An older device (or a hand-built descriptor) simply has none. That costs
    // a pet its foot alignment; it must not cost it its existence.
    const el = sprite();
    expect(el.dataset.petFrames).toBe("6");
    expect(css(el)).toContain("bottom: 0px");
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
