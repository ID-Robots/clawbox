// The mascot refresh button on a NON-English box.
//
// Separate file because `useT` is mocked per-module and the main SettingsApp
// suite pins the locale to English. Generation only runs for the locales in
// GENERATION_LOCALES, so on every other language the button must be visibly
// unavailable and say why — not silently do nothing, and not offer a three
// minute model run that the server is going to refuse anyway.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "bg", name: "Български" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string) => key,
    locale: "bg",
    setLocale: vi.fn(),
  }),
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

const defaultUi: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

describe("SettingsApp mascot phrase refresh (non-English locale)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables the button and explains that generation is English-only", async () => {
    render(<SettingsApp ui={defaultUi} />);

    const button = await screen.findByRole("button", { name: /settings\.mascotRefresh$/ });
    expect(button).toBeDisabled();
    expect(screen.getByText("settings.mascotRefreshEnglishOnly")).toBeInTheDocument();
  });

  it("never POSTs to the regenerate endpoint from a disabled locale", async () => {
    render(<SettingsApp ui={defaultUi} />);
    await screen.findByRole("button", { name: /settings\.mascotRefresh$/ });

    const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls.some(([url]) => String(url).includes("mascot-lines/regenerate"))).toBe(false);
  });
});
