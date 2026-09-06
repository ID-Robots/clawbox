// @vitest-environment jsdom
/**
 * Appearance on `/app/settings` — the page that IS Settings for a phone.
 *
 * The route used to hand `SettingsApp` a table of hard-coded defaults and
 * seven `() => {}` handlers, so the card showed no wallpapers, 100% opacity
 * and the mascot on whatever the device actually held, and every control on it
 * did nothing. What is pinned here: the card shows THIS box's saved
 * appearance, a change made on it reaches the same preferences the desktop
 * writes, and nothing is written before the box has answered.
 *
 * SettingsApp is stubbed down to the `ui` prop, the way
 * standalone-app-settings-section.test.tsx stubs it down to the section: the
 * real card is pinned in settings-app.test.tsx and mounting every panel here
 * would test the wrong thing slowly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import StandaloneAppPage from "@/app/app/[id]/page";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "settings" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
// Hoisted so a case can decide what the probe answers — including answering
// without an `active`, which is what a failed probe looks like to this route.
const harnessMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ active?: string; edition?: string; editionKnown?: boolean }> => ({
    active: "openclaw",
    edition: "openclaw",
    editionKnown: true,
  })),
);
vi.mock("@/lib/client-harness", () => ({ fetchHarness: harnessMock }));

interface StubUi {
  wallpaperId: string;
  wpFit: string;
  wpBgColor: string;
  wpOpacity: number;
  mascotHidden: boolean;
  wallpapers: { id: string; name: string }[];
  customWallpapers: string[];
  onWallpaperChange: (id: string) => void;
  onWpFitChange: (fit: "fill" | "fit" | "center") => void;
  onWpOpacityChange: (opacity: number) => void;
  onMascotToggle: (hidden: boolean) => void;
  onWallpaperUpload: () => void;
  onCustomWallpaperDelete: (idx: number) => void;
}

vi.mock("@/components/SettingsApp", () => ({
  default: function SettingsStub({ ui }: { ui: StubUi }) {
    return (
      <div>
        <span data-testid="ui-wallpaper">{ui.wallpaperId}</span>
        <span data-testid="ui-fit">{ui.wpFit}</span>
        <span data-testid="ui-opacity">{ui.wpOpacity}</span>
        <span data-testid="ui-bg">{ui.wpBgColor}</span>
        <span data-testid="ui-mascot">{ui.mascotHidden ? "hidden" : "shown"}</span>
        <span data-testid="ui-wallpapers">{ui.wallpapers.map((w) => w.id).join(",")}</span>
        <span data-testid="ui-custom">{ui.customWallpapers.length}</span>
        <button data-testid="pick-deep-space" onClick={() => ui.onWallpaperChange("deep-space")}>wp</button>
        <button data-testid="pick-clawbox" onClick={() => ui.onWallpaperChange("clawbox")}>brand</button>
        <button data-testid="pick-center" onClick={() => ui.onWpFitChange("center")}>fit</button>
        <button data-testid="pick-opacity" onClick={() => ui.onWpOpacityChange(80)}>opacity</button>
        <button data-testid="show-mascot" onClick={() => ui.onMascotToggle(false)}>mascot</button>
        <button data-testid="ask-upload" onClick={() => ui.onWallpaperUpload()}>upload</button>
        <button data-testid="pick-custom-1" onClick={() => ui.onWallpaperChange("custom-1")}>pick 2nd upload</button>
        <button data-testid="pick-custom-0" onClick={() => ui.onWallpaperChange("custom-0")}>pick 1st upload</button>
        <button data-testid="delete-custom-0" onClick={() => ui.onCustomWallpaperDelete(0)}>delete 1st upload</button>
      </div>
    );
  },
}));

const SAVED = {
  wp_id: "deep-space",
  wp_fit: "center",
  wp_bg_color: "#000000",
  wp_opacity: 50,
  ui_mascot_hidden: 1,
};

let posts: Record<string, unknown>[];

beforeEach(() => {
  posts = [];
  localStorage.clear();
  harnessMock.mockResolvedValue({ active: "openclaw", edition: "openclaw", editionKnown: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url.includes("keys=wp_id")) return { ok: true, json: async () => SAVED };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The write is debounced by 500 ms, like the desktop's. */
const SAVED_SOON = { timeout: 4000 };

describe("/app/settings — Appearance", () => {
  it("shows the appearance this box actually has, and the wallpapers it can choose between", async () => {
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("deep-space"));
    expect(screen.getByTestId("ui-fit").textContent).toBe("center");
    expect(screen.getByTestId("ui-opacity").textContent).toBe("50");
    expect(screen.getByTestId("ui-bg").textContent).toBe("#000000");
    expect(screen.getByTestId("ui-mascot").textContent).toBe("hidden");
    // The card used to be handed an empty list, so it drew nothing but the
    // Upload tile. It is now handed the wallpapers THIS EDITION ships — its own
    // brand and the neutral one — rather than both products' branding
    // (owner ruling 2026-09-06).
    expect(screen.getByTestId("ui-wallpapers").textContent).toBe("clawbox,deep-space");
  });

  it("saves a wallpaper, a fit and an opacity to the preferences the desktop reads", async () => {
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("deep-space"));
    posts.length = 0;

    fireEvent.click(screen.getByTestId("pick-clawbox"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("clawbox");
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ wp_id: "clawbox" }), SAVED_SOON);

    fireEvent.click(screen.getByTestId("pick-center"));
    fireEvent.click(screen.getByTestId("pick-opacity"));
    await waitFor(
      () => expect(posts.at(-1)).toMatchObject({ wp_id: "clawbox", wp_fit: "center", wp_opacity: 80 }),
      SAVED_SOON,
    );
  });

  it("saves the mascot switch on its own key", async () => {
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-mascot").textContent).toBe("hidden"));
    posts.length = 0;

    fireEvent.click(screen.getByTestId("show-mascot"));
    expect(screen.getByTestId("ui-mascot").textContent).toBe("shown");
    await waitFor(
      () => expect(posts.some((body) => Object.keys(body).join() === "ui_mascot_hidden" && body.ui_mascot_hidden === 0)).toBe(true),
      SAVED_SOON,
    );
  });

  it("writes nothing when the box's answer leaves a key out", async () => {
    // The box named a wallpaper and nothing else — an older server, or a read
    // that only half answered. Every other key is still at this page's
    // DEFAULT, and the writer used to be armed inside the fetch's `.finally`,
    // which runs before React commits what the `.then` above it queued: the
    // hydration commit then posted `wp_fit: "fill"` and `wp_opacity: 50` over
    // whatever the box actually holds, the moment /app/settings opened.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes("keys=wp_id")) return { ok: true, json: async () => ({ wp_id: "deep-space" }) };
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("deep-space"));
    // Well past the 500 ms debounce: anything the hydration commit queued has
    // had its chance to land.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts).toEqual([]);

    // …and the card is still live: the owner's own change saves as before.
    fireEvent.click(screen.getByTestId("pick-center"));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ wp_fit: "center" }), SAVED_SOON);
  });

  it("renumbers the wallpaper it is showing when an earlier upload is deleted", async () => {
    // `custom-<n>` is an INDEX into the uploaded list, so deleting the first
    // picture makes the second one `custom-0`. The handler only cleared an
    // exact match, so a selection past the hole was left pointing at its old
    // number — one entry along, or off the end of the list, where the desktop
    // draws no wallpaper at all.
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]));
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-custom").textContent).toBe("2"));

    fireEvent.click(screen.getByTestId("pick-custom-1"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("custom-1");

    fireEvent.click(screen.getByTestId("delete-custom-0"));
    expect(screen.getByTestId("ui-custom").textContent).toBe("1");
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("custom-0");
  });

  it("falls back to a built-in wallpaper when the deleted upload is the one on screen", async () => {
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]));
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-custom").textContent).toBe("2"));

    fireEvent.click(screen.getByTestId("pick-custom-0"));
    fireEvent.click(screen.getByTestId("delete-custom-0"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("clawbox");
  });

  it("shows the fallback for a selection this browser's uploads cannot answer, and leaves the box's own alone", async () => {
    // `wp_id` is box-wide, the pictures are this browser's `localStorage`: a
    // phone that never uploaded anything cannot answer the laptop's
    // `custom-2`. What the card shows is the fallback; what the box holds is
    // untouched, because opening a page is not a choice.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes("keys=wp_id")) return { ok: true, json: async () => ({ ...SAVED, wp_id: "custom-2" }) };
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<StandaloneAppPage />);
    // `wp_fit` proves the box's answer LANDED — "clawbox" is also this page's
    // initial state, so asserting it alone would pass before the fetch.
    await waitFor(() => expect(screen.getByTestId("ui-fit").textContent).toBe("center"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("clawbox");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts.some((body) => "wp_id" in body)).toBe(false);
  });

  it("does not renumber a selection that is not an index into this browser's list", async () => {
    // The phone is the surface most likely to be holding a `wp_id` it did not
    // choose. Two pictures of its own, the laptop's `custom-5` from the box:
    // deleting one of ITS two must not shift that id down a slot and write it
    // back — this handler is a second copy of the desktop's, and this is the
    // case that catches the two drifting apart.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes("keys=wp_id")) return { ok: true, json: async () => ({ ...SAVED, wp_id: "custom-5" }) };
        return { ok: true, json: async () => ({}) };
      }),
    );
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]));

    render(<StandaloneAppPage />);
    // `wp_fit` proves the box's answer landed, as above.
    await waitFor(() => expect(screen.getByTestId("ui-fit").textContent).toBe("center"));
    expect(screen.getByTestId("ui-custom").textContent).toBe("2");
    posts.length = 0;

    fireEvent.click(screen.getByTestId("delete-custom-0"));
    // This browser's own list did shrink — the delete is not being refused.
    expect(screen.getByTestId("ui-custom").textContent).toBe("1");
    // Rendered locally, persisted nowhere: the card shows the fallback and the
    // box keeps the selection it holds. Well past the 500 ms debounce.
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("clawbox");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts.some((body) => "wp_id" in body)).toBe(false);
  });

  it("does not move the selection when the shortened list cannot be stored", async () => {
    // Site data blocked, or a locked-down profile. The list is what the next
    // load paints and `wp_id` is a position into it — moving the id over a
    // list that never shrank leaves a DIFFERENT picture on screen after a
    // reload, with nothing said. So the delete does not happen at all.
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]));
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-custom").textContent).toBe("2"));

    fireEvent.click(screen.getByTestId("pick-custom-1"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("custom-1");

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      fireEvent.click(screen.getByTestId("delete-custom-0"));
    } finally {
      setItem.mockRestore();
    }

    expect(screen.getByTestId("ui-custom").textContent).toBe("2");
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("custom-1");
    expect(JSON.parse(localStorage.getItem("clawbox-custom-wallpapers") || "[]")).toHaveLength(2);
  });

  it("writes no edition fallback when the probe never said which edition this is", async () => {
    // This route answers `d?.active || "unknown"` on a failed probe, and
    // "unknown" reads as OpenClaw wherever it is turned into a wallpaper. So
    // deleting the picture in use on a Hermes box whose probe failed persisted
    // "clawbox" box-wide — permanently, from a delete that had nothing to do
    // with the edition. The guess is fine to PAINT and not fine to WRITE.
    harnessMock.mockResolvedValue({});
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA"]));
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-custom").textContent).toBe("1"));

    fireEvent.click(screen.getByTestId("pick-custom-0"));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ wp_id: "custom-0" }), SAVED_SOON);
    posts.length = 0;

    // The delete is not blocked — a local operation must not wait on a probe.
    fireEvent.click(screen.getByTestId("delete-custom-0"));
    expect(screen.getByTestId("ui-custom").textContent).toBe("0");
    // Painted locally, and painted NEUTRAL: with no edition there is no brand
    // to fall back to, and picking one would put the other product's artwork on
    // the customer's screen.
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("deep-space");
    // …and not written. Well past the 500 ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts.some((body) => "wp_id" in body)).toBe(false);
  });

  it("offers the wallpapers this browser already uploaded, and asks the file input for a new one", async () => {
    localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(["data:image/png;base64,AAAA"]));
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-custom").textContent).toBe("1"));

    // The Upload tile clicks the page's own hidden file input.
    const input = screen.getByTestId("standalone-wallpaper-upload") as HTMLInputElement;
    const clicked = vi.fn();
    input.addEventListener("click", clicked);
    fireEvent.click(screen.getByTestId("ask-upload"));
    expect(clicked).toHaveBeenCalled();
  });

  it("offers the HERMES branding and no ClawBox one on a Hermes box", async () => {
    // The built-in list is edition-scoped (owner ruling 2026-09-06). This route
    // is the phone's Settings, so it must scope it the same way the desktop
    // does — one source of truth, not a second copy that drifts.
    harnessMock.mockResolvedValue({ active: "hermes", edition: "hermes", editionKnown: true });
    render(<StandaloneAppPage />);
    // `wp_fit` proves the box's answer landed, as elsewhere in this file.
    await waitFor(() => expect(screen.getByTestId("ui-fit").textContent).toBe("center"));
    expect(screen.getByTestId("ui-wallpapers").textContent).toBe("hermes,deep-space");
  });

  it("offers only the neutral wallpaper while no edition could be read", async () => {
    // An unreadable lock reads as OpenClaw in `readEditionSource`, and the
    // route reports that as a guess. Neither brand may be offered on a guess:
    // one of the two answers is another product's artwork.
    harnessMock.mockResolvedValue({ active: "openclaw", edition: "openclaw", editionKnown: false });
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-fit").textContent).toBe("center"));
    expect(screen.getByTestId("ui-wallpapers").textContent).toBe("deep-space");
  });

  it("heals a stored other-edition brand for the card, and leaves the box's value alone", async () => {
    // A `wp_id` naming the art this edition no longer ships — a box re-imaged
    // onto the other edition, or a choice made before the ruling. The card
    // shows this edition's own brand; the stored value is not rewritten, for
    // the same reason an unanswerable `custom-<n>` is not (#728).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes("keys=wp_id")) return { ok: true, json: async () => ({ ...SAVED, wp_id: "hermes" }) };
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("clawbox"));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts.some((body) => "wp_id" in body)).toBe(false);
  });
});
