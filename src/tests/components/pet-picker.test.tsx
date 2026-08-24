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
  it("renders nothing on OpenClaw", async () => {
    stubFetch({ supported: false, edition: "openclaw", enabled: false, pets: [] });
    const { container } = render(<PetPicker />);
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
    expect(container.textContent).toBe("");
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
});
