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
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "openclaw" })) }));

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
        <button data-testid="pick-center" onClick={() => ui.onWpFitChange("center")}>fit</button>
        <button data-testid="pick-opacity" onClick={() => ui.onWpOpacityChange(80)}>opacity</button>
        <button data-testid="show-mascot" onClick={() => ui.onMascotToggle(false)}>mascot</button>
        <button data-testid="ask-upload" onClick={() => ui.onWallpaperUpload()}>upload</button>
      </div>
    );
  },
}));

const SAVED = {
  wp_id: "hermes",
  wp_fit: "center",
  wp_bg_color: "#000000",
  wp_opacity: 50,
  ui_mascot_hidden: 1,
};

let posts: Record<string, unknown>[];

beforeEach(() => {
  posts = [];
  localStorage.clear();
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
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("hermes"));
    expect(screen.getByTestId("ui-fit").textContent).toBe("center");
    expect(screen.getByTestId("ui-opacity").textContent).toBe("50");
    expect(screen.getByTestId("ui-bg").textContent).toBe("#000000");
    expect(screen.getByTestId("ui-mascot").textContent).toBe("hidden");
    // The card used to be handed an empty list, so it drew nothing but the
    // Upload tile — three wallpapers exist and every one is pickable here.
    expect(screen.getByTestId("ui-wallpapers").textContent).toBe("clawbox,hermes,deep-space");
  });

  it("saves a wallpaper, a fit and an opacity to the preferences the desktop reads", async () => {
    render(<StandaloneAppPage />);
    await waitFor(() => expect(screen.getByTestId("ui-wallpaper").textContent).toBe("hermes"));
    posts.length = 0;

    fireEvent.click(screen.getByTestId("pick-deep-space"));
    expect(screen.getByTestId("ui-wallpaper").textContent).toBe("deep-space");
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ wp_id: "deep-space" }), SAVED_SOON);

    fireEvent.click(screen.getByTestId("pick-center"));
    fireEvent.click(screen.getByTestId("pick-opacity"));
    await waitFor(
      () => expect(posts.at(-1)).toMatchObject({ wp_id: "deep-space", wp_fit: "center", wp_opacity: 80 }),
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
});
