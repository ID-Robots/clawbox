// The picker is the only place a pet gets chosen, and the choice has to LAND —
// in Hermes' own config.yaml, not in a ClawBox-side store that would drift the
// moment someone ran `hermes pets select` in the terminal.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@/tests/helpers/test-utils";
import PetPicker from "@/components/PetPicker";

// Keys pass through as themselves, except the one that carries a placeholder —
// the byline is interpolated in the component, so the test needs the real
// English string to prove the author's name actually lands on the tile.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (k: string) => (k === "settings.mascot.petBy" ? "by {author}" : k),
    locale: "en",
    localeResolved: true,
  }),
}));

const CURATED = [
  { slug: "boba", displayName: "Boba", kind: "creature", submittedBy: "railly", curated: true, installed: false },
  { slug: "nukey", displayName: "Nukey", kind: "object", submittedBy: "railly", curated: true, installed: true },
];

/** The pack ClawBox ships, exactly as `/setup-api/pets?gallery=1` reports it. */
const BUILTIN = {
  slug: "vibrant-clawd",
  displayName: "ClawBox crab",
  kind: "creature",
  submittedBy: "ID-Robots",
  curated: true,
  builtin: true,
  installed: true,
};

function galleryPayload(over: Record<string, unknown> = {}) {
  return {
    supported: true,
    edition: "hermes",
    enabled: true,
    activeSlug: "nukey",
    galleryUrl: "https://petdex.dev",
    pets: CURATED,
    ...over,
  };
}

/**
 * What a crab box (openclaw, dual) really answers on a box with nothing picked:
 * `enabled: false`, and `activeSlug` already naming the brand body, because the
 * route resolves the crab THROUGH the bundled pet.
 */
function crabPayload(over: Record<string, unknown> = {}) {
  return galleryPayload({
    edition: "openclaw",
    placeholder: "crab",
    enabled: false,
    activeSlug: "vibrant-clawd",
    pets: [BUILTIN, ...CURATED],
    ...over,
  });
}

let selectCalls: unknown[] = [];
let selectOk = true;

function stubFetch(gallery: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).startsWith("/setup-api/pets/select")) {
        selectCalls.push(JSON.parse(String(init?.body)));
        return Promise.resolve({ ok: selectOk, json: () => Promise.resolve({ ok: selectOk }) } as Response);
      }
      if (String(url).startsWith("/setup-api/pets")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(gallery) } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

beforeEach(() => {
  selectCalls = [];
  selectOk = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PetPicker", () => {
  it("renders nothing for a server that predates pets or cannot be reached", async () => {
    stubFetch({ supported: false, edition: "openclaw", enabled: false, pets: [] });
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
    expect(container.textContent).toBe("");
  });

  it("on OpenClaw with no bundled pack falls back to the still crab tile", async () => {
    stubFetch(galleryPayload({ edition: "openclaw", placeholder: "crab", enabled: false, activeSlug: "" }));
    const { container, getByTestId } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const none = getByTestId("pet-tile-none");
    expect(none.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy();
    expect(none.textContent).toContain("settings.mascot.petCrab");
    expect(none.textContent).not.toContain("settings.mascot.petNone");
  });

  it("on Hermes the first tile is 'none' — the egg, never the crab", async () => {
    stubFetch(galleryPayload({ placeholder: "egg" }));
    const { getByTestId } = render(<PetPicker />);
    await waitFor(() => expect(getByTestId("pet-tile-none")).toBeTruthy());
    const none = getByTestId("pet-tile-none");
    expect(none.querySelector("img")).toBeNull();
    expect(none.textContent).toContain("settings.mascot.petNone");
  });

  it("shows a tile per pet plus a 'no pet' tile on Hermes", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
  });

  it("credits every pet to its author — Petdex art keeps its byline", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.textContent).toContain("railly"));
    // And says where the art comes from, without mirroring the gallery.
    expect(container.querySelector('a[href="https://petdex.dev"]')).toBeTruthy();
  });

  it("previews from the device's own thumbnail route, never the Petdex CDN", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toMatch(/^\/setup-api\/pets\/thumb\?slug=/);
    }
  });

  it("marks the active pet as selected", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const selected = container.querySelectorAll(".ring-orange-400");
    expect(selected.length).toBe(1);
    expect((selected[0] as HTMLElement).textContent).toContain("Nukey");
  });

  it("persists a pick through the select route", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const boba = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Boba"))!;
    fireEvent.click(boba);
    await waitFor(() => expect(selectCalls).toEqual([{ slug: "boba" }]));
  });

  it("turns the pet off with a null slug", async () => {
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    fireEvent.click(container.querySelectorAll("button")[0]);
    await waitFor(() => expect(selectCalls).toEqual([{ slug: null }]));
  });

  it("tells the mascot to re-read after a successful pick", async () => {
    stubFetch(galleryPayload());
    const heard = vi.fn();
    window.addEventListener("clawbox-pet-changed", heard);
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const boba = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Boba"))!;
    fireEvent.click(boba);
    await waitFor(() => expect(heard).toHaveBeenCalled());
    window.removeEventListener("clawbox-pet-changed", heard);
  });

  it("surfaces a download failure without breaking the panel", async () => {
    selectOk = false;
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const boba = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("Boba"))!;
    fireEvent.click(boba);
    await waitFor(() => expect(container.textContent).toContain("settings.mascot.petInstallFailed"));
    expect(container.querySelectorAll("button").length).toBe(3);
  });

  it("keeps the name tile when a preview cannot be produced", async () => {
    // Offline, or a slug taken down since — the thumbnail route 404s and the
    // tile is still pickable rather than blank.
    stubFetch(galleryPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    const img = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(img);
    expect(img.style.visibility).toBe("hidden");
    expect(container.textContent).toContain("Boba");
  });

  // ── The crab tile IS the bundled pet (owner, 2026-09-18) ──
  //
  // There used to be two tiles for one body: a still-PNG "ClawBox crab" and a
  // "Vibrant Clawd" beside it. They are the same crab, so there is one tile.

  it("draws the first tile on a crab box from the bundled pet's own sheet", async () => {
    stubFetch(crabPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const first = container.querySelectorAll("button")[0];
    expect(first.querySelector("img")?.getAttribute("src")).toBe(
      "/setup-api/pets/thumb?slug=vibrant-clawd",
    );
    expect(first.textContent).toContain("settings.mascot.petCrab");
  });

  it("never offers the brand pet a second time on a crab box", async () => {
    stubFetch(crabPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    expect(container.querySelectorAll('img[src*="vibrant-clawd"]').length).toBe(1);
    // The gallery row's own name never reaches the screen: the tile wears the
    // localised crab name instead.
    expect(container.textContent).not.toContain("ClawBox crab");
  });

  it("selects the crab tile when nothing is picked", async () => {
    stubFetch(crabPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const selected = container.querySelectorAll(".ring-orange-400");
    expect(selected.length).toBe(1);
    expect(selected[0]).toBe(container.querySelectorAll("button")[0]);
  });

  it("selects the same crab tile when the brand slug is the explicit pick", async () => {
    stubFetch(crabPayload({ enabled: true, activeSlug: "vibrant-clawd" }));
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const selected = container.querySelectorAll(".ring-orange-400");
    expect(selected.length).toBe(1);
    expect(selected[0]).toBe(container.querySelectorAll("button")[0]);
  });

  it("picking the crab tile is still 'no pet'", async () => {
    stubFetch(crabPayload());
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    fireEvent.click(container.querySelectorAll("button")[0]);
    await waitFor(() => expect(selectCalls).toEqual([{ slug: null }]));
  });

  it("falls back to the still crab, and STILL one tile, when the pack is missing", async () => {
    stubFetch(crabPayload({ pets: [{ ...BUILTIN, installed: false }, ...CURATED] }));
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(3));
    const first = container.querySelectorAll("button")[0];
    expect(first.querySelector('img[src="/clawbox-crab.png"]')).toBeTruthy();
    expect(container.querySelectorAll('img[src*="vibrant-clawd"]').length).toBe(0);
  });

  it("leaves a Hermes box alone: the egg first, the bundled pet an ordinary tile", async () => {
    stubFetch(galleryPayload({ placeholder: "egg", pets: [BUILTIN, ...CURATED] }));
    const { container, getByTestId } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelectorAll("button").length).toBe(4));
    const none = getByTestId("pet-tile-none");
    expect(none).toBe(container.querySelectorAll("button")[0]);
    expect(none.querySelector("img")).toBeNull();
    expect(none.textContent).toContain("settings.mascot.petNone");
    expect(container.textContent).toContain("ClawBox crab");
    expect(container.textContent).toContain("settings.mascot.petBuiltin");
  });
});
