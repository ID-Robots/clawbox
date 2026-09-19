/**
 * The Terminal's settings (src/lib/terminal-settings.ts): what a stored value
 * is made into, the themes and faces on offer, and the store — read once from
 * the owner's preferences, written back a moment after a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_FONTS,
  TERMINAL_FONT_IDS,
  TERMINAL_SETTINGS_KEY,
  TERMINAL_THEMES,
  TERMINAL_THEME_IDS,
  getTerminalSettings,
  loadTerminalSettings,
  normalizeTerminalSettings,
  resetTerminalSettingsStoreForTests,
  terminalFontFor,
  terminalThemeFor,
  updateTerminalSettings,
} from "@/lib/terminal-settings";
import { WINDOW_CHROME } from "@/lib/window-chrome";
import { validatePreference } from "@/lib/preference-schema";

describe("normalizeTerminalSettings", () => {
  it("gives the defaults for nothing, junk and an array", () => {
    for (const raw of [undefined, null, "dark", 42, [], {}]) {
      expect(normalizeTerminalSettings(raw)).toEqual(DEFAULT_TERMINAL_SETTINGS);
    }
  });

  it("keeps every valid value", () => {
    const chosen = {
      theme: "dracula",
      font: "fira-code",
      fontSize: 16,
      lineHeight: 1.2,
      cursorStyle: "bar",
      cursorBlink: false,
      scrollback: 25000,
      copyOnSelect: true,
      bell: "off",
      shell: "/usr/bin/zsh",
      cwd: "~/projects",
    };
    expect(normalizeTerminalSettings(chosen)).toEqual(chosen);
  });

  it("drops unknown values one by one and clamps numbers", () => {
    const out = normalizeTerminalSettings({
      theme: "matrix",
      font: "comic-sans",
      fontSize: 200,
      lineHeight: 0.2,
      cursorStyle: "beam",
      cursorBlink: "yes",
      scrollback: 10_000_000,
      bell: "audible",
    });
    expect(out.theme).toBe("clawbox-dark");
    expect(out.font).toBe("jetbrains-mono");
    expect(out.fontSize).toBe(24);
    expect(out.lineHeight).toBe(1);
    expect(out.cursorStyle).toBe("block");
    expect(out.cursorBlink).toBe(true);
    expect(out.scrollback).toBe(50000);
    expect(out.bell).toBe("visual");
    expect(normalizeTerminalSettings({ fontSize: "11" }).fontSize).toBe(11);
    expect(normalizeTerminalSettings({ fontSize: 2 }).fontSize).toBe(9);
  });

  it("keeps the line height on the slider's grid", () => {
    expect(normalizeTerminalSettings({ lineHeight: 1.1000000000000001 }).lineHeight).toBe(1.1);
    expect(normalizeTerminalSettings({ lineHeight: 1.23 }).lineHeight).toBe(1.25);
  });

  it("refuses a shell that is not an absolute path, and control characters in the folder", () => {
    expect(normalizeTerminalSettings({ shell: "zsh" }).shell).toBe("");
    expect(normalizeTerminalSettings({ shell: "/bin/sh; rm -rf ~" }).shell).toBe("");
    expect(normalizeTerminalSettings({ shell: "/usr/../bin/sh" }).shell).toBe("");
    expect(normalizeTerminalSettings({ cwd: "~/a\nb" }).cwd).toBe("");
    expect(normalizeTerminalSettings({ cwd: "  ~/work  " }).cwd).toBe("~/work");
  });

  it("is a value the preferences route stores", () => {
    const stored = normalizeTerminalSettings({ theme: "nord", cwd: "~/x", shell: "/bin/sh" });
    expect(validatePreference(TERMINAL_SETTINGS_KEY, stored)).toEqual({ ok: true });
  });
});

describe("themes and faces", () => {
  it("offers ClawBox dark (the default) and light, and four classic schemes", () => {
    expect(TERMINAL_THEME_IDS.slice(0, 2)).toEqual(["clawbox-dark", "clawbox-light"]);
    expect(TERMINAL_THEME_IDS.length).toBe(6);
    expect(DEFAULT_TERMINAL_SETTINGS.theme).toBe("clawbox-dark");
  });

  it("draws the ClawBox themes on the desktop window's own ground", () => {
    expect(TERMINAL_THEMES["clawbox-dark"].colors.background).toBe(WINDOW_CHROME.dark.ground);
    expect(TERMINAL_THEMES["clawbox-light"].colors.background).toBe(WINDOW_CHROME.light.ground);
    expect(TERMINAL_THEMES["clawbox-dark"].tone).toBe("dark");
    expect(TERMINAL_THEMES["clawbox-light"].tone).toBe("light");
  });

  it("gives every theme all sixteen ANSI colours as hex", () => {
    const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    const names = [...ansi, ...ansi.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)];
    for (const id of TERMINAL_THEME_IDS) {
      const colors = TERMINAL_THEMES[id].colors as unknown as Record<string, string>;
      for (const name of names) expect(colors[name], `${id}.${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("offers the bundled faces and the device's own monospace, each ending in the symbol and emoji faces", () => {
    expect(TERMINAL_FONT_IDS).toEqual(["jetbrains-mono", "fira-code", "ibm-plex-mono", "system"]);
    for (const id of TERMINAL_FONT_IDS) {
      const family = TERMINAL_FONTS[id].family;
      expect(family).toContain('"Symbols Nerd Font Mono"');
      expect(family).toContain('"Noto Color Emoji"');
      expect(family.trim().endsWith("monospace")).toBe(true);
    }
    expect(TERMINAL_FONTS.system.face).toBeNull();
    expect(TERMINAL_FONTS.system.family.startsWith("ui-monospace, monospace")).toBe(true);
  });

  it("falls back for an id it does not know", () => {
    expect(terminalThemeFor("nope" as never).id).toBe("clawbox-dark");
    expect(terminalFontFor("nope" as never).id).toBe("jetbrains-mono");
  });
});

describe("the settings store", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalSettingsStoreForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetTerminalSettingsStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the stored settings once per page", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ [TERMINAL_SETTINGS_KEY]: { theme: "nord", fontSize: 15 } })));
    const [a, b] = await Promise.all([loadTerminalSettings(), loadTerminalSettings()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/setup-api/preferences?keys=${TERMINAL_SETTINGS_KEY}`);
    expect(a).toBe(b);
    expect(getTerminalSettings().theme).toBe("nord");
    expect(getTerminalSettings().fontSize).toBe(15);
  });

  it("keeps the defaults when the read fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await loadTerminalSettings();
    expect(getTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS);
  });

  it("writes a change back to the preferences a moment later, once for a burst", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    updateTerminalSettings({ fontSize: 14 });
    updateTerminalSettings({ fontSize: 15 });
    updateTerminalSettings({ theme: "clawbox-light" });
    expect(getTerminalSettings().fontSize).toBe(15);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/setup-api/preferences");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body[TERMINAL_SETTINGS_KEY]).toMatchObject({ fontSize: 15, theme: "clawbox-light" });
  });

  it("lets a change made before the stored value arrived win over it", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const loading = loadTerminalSettings();
    updateTerminalSettings({ fontSize: 18 });
    answer(new Response(JSON.stringify({ [TERMINAL_SETTINGS_KEY]: { fontSize: 11 } })));
    await loading;
    expect(getTerminalSettings().fontSize).toBe(18);
  });
});
