"use client";

/**
 * The Terminal's settings: what they are, what they default to, the themes and
 * faces they choose between, and the one store every terminal on the page
 * reads them from.
 *
 * They persist through the desktop's preferences (`/setup-api/preferences`,
 * one JSON value under `ui_terminal_settings`), so they follow the owner to
 * every browser that opens this box rather than living in one tab's storage.
 * A change made in one Terminal window reaches every other one at once — each
 * subscribes to the same module-level store.
 */

import { useSyncExternalStore } from "react";
import { WINDOW_CHROME, type WindowTone } from "@/lib/window-chrome";

export const TERMINAL_SETTINGS_KEY = "ui_terminal_settings";

export const TERMINAL_THEME_IDS = [
  "clawbox-dark",
  "clawbox-light",
  "solarized-dark",
  "solarized-light",
  "dracula",
  "nord",
] as const;
export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number];

export const TERMINAL_FONT_IDS = ["jetbrains-mono", "fira-code", "ibm-plex-mono", "system"] as const;
export type TerminalFontId = (typeof TERMINAL_FONT_IDS)[number];

export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

export const TERMINAL_BELLS = ["off", "visual"] as const;
export type TerminalBell = (typeof TERMINAL_BELLS)[number];

/** The scrollback lengths offered. Every tab is an xterm buffer on an 8 GB board, so the top is bounded. */
export const TERMINAL_SCROLLBACK_CHOICES = [1000, 5000, 10000, 25000, 50000] as const;

export const TERMINAL_FONT_SIZE = { min: 9, max: 24 } as const;
export const TERMINAL_LINE_HEIGHT = { min: 1, max: 1.6, step: 0.05 } as const;

export interface TerminalSettings {
  theme: TerminalThemeId;
  font: TerminalFontId;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  bell: TerminalBell;
  /** An absolute path from the box's /etc/shells, or "" for the box's default (bash). */
  shell: string;
  /** Where a new shell starts: "" is the home folder; `~/x` and absolute paths are the server's to check. */
  cwd: string;
}

export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = Object.freeze({
  theme: "clawbox-dark",
  font: "jetbrains-mono",
  fontSize: 13,
  // 1.0: a full-screen TUI draws its vertical borders one glyph per row, and
  // leading between rows turns every `│` column into a dotted one wherever the
  // font rather than the renderer draws it (the DOM fallback). The owner can
  // open the rows up in Settings.
  lineHeight: 1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  bell: "visual",
  shell: "",
  cwd: "",
});

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// No control characters in either path: they reach a query string and a
// spawn() on the other side, and a preference value refuses them anyway.
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHELL_PATH = /^\/[A-Za-z0-9._+/-]{1,254}$/;

/**
 * Whatever was stored — an older shape, a hand edit through the agent's
 * `preferences_set`, nothing at all — made into settings the terminal can use:
 * unknown values fall back to the default one by one, numbers are clamped.
 */
export function normalizeTerminalSettings(raw: unknown): TerminalSettings {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_TERMINAL_SETTINGS;
  const shell = typeof src.shell === "string" && SHELL_PATH.test(src.shell) && !src.shell.includes("..") ? src.shell : "";
  const cwd = typeof src.cwd === "string" && src.cwd.length <= 1024 && !CONTROL.test(src.cwd) ? src.cwd.trim() : "";
  const lineHeight = clamp(src.lineHeight, TERMINAL_LINE_HEIGHT.min, TERMINAL_LINE_HEIGHT.max, d.lineHeight);
  return {
    theme: pick(src.theme, TERMINAL_THEME_IDS, d.theme),
    font: pick(src.font, TERMINAL_FONT_IDS, d.font),
    fontSize: Math.round(clamp(src.fontSize, TERMINAL_FONT_SIZE.min, TERMINAL_FONT_SIZE.max, d.fontSize)),
    // Kept on the slider's grid, so 1.1 stays 1.1 rather than 1.1000000000000001.
    lineHeight: Number((Math.round(lineHeight / TERMINAL_LINE_HEIGHT.step) * TERMINAL_LINE_HEIGHT.step).toFixed(2)),
    cursorStyle: pick(src.cursorStyle, TERMINAL_CURSOR_STYLES, d.cursorStyle),
    cursorBlink: typeof src.cursorBlink === "boolean" ? src.cursorBlink : d.cursorBlink,
    scrollback: Math.round(clamp(src.scrollback, 100, TERMINAL_SCROLLBACK_CHOICES[TERMINAL_SCROLLBACK_CHOICES.length - 1], d.scrollback)),
    copyOnSelect: typeof src.copyOnSelect === "boolean" ? src.copyOnSelect : d.copyOnSelect,
    bell: pick(src.bell, TERMINAL_BELLS, d.bell),
    shell,
    cwd,
  };
}

// ── Themes ─────────────────────────────────────────────────────────────

/** The colours xterm is given — its ITheme, spelled out so this module needs no xterm types. */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface TerminalThemeDef {
  id: TerminalThemeId;
  /** A translation key for the ClawBox themes; the classic schemes go by their own names. */
  labelKey?: string;
  name: string;
  /** Which face of the window chrome sits around it. */
  tone: WindowTone;
  colors: TerminalColors;
}

const DARK_SCROLLBAR = {
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.14)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.24)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.32)",
};
const LIGHT_SCROLLBAR = {
  scrollbarSliderBackground: "rgba(0, 0, 0, 0.16)",
  scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.26)",
  scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.34)",
};

const SOLARIZED_ACCENTS = {
  black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
  blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
  brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
  brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
};

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemeDef> = {
  // GitHub's dark scheme — the one the code editor colours with (`.tok-*` in
  // globals.css) — on the desktop window's own ground, with the desktop's
  // coral cursor. The ground is WINDOW_CHROME's, not a near miss of it.
  "clawbox-dark": {
    id: "clawbox-dark",
    labelKey: "terminal.settings.themeClawboxDark",
    name: "ClawBox Dark",
    tone: "dark",
    colors: {
      background: WINDOW_CHROME.dark.ground,
      foreground: "#e6edf3",
      cursor: "#f97316",
      cursorAccent: WINDOW_CHROME.dark.ground,
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      selectionInactiveBackground: "rgba(255, 255, 255, 0.12)",
      ...DARK_SCROLLBAR,
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
      brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
  },
  // GitHub's light scheme on the light chrome's ground.
  "clawbox-light": {
    id: "clawbox-light",
    labelKey: "terminal.settings.themeClawboxLight",
    name: "ClawBox Light",
    tone: "light",
    colors: {
      background: WINDOW_CHROME.light.ground,
      foreground: "#1f2328",
      cursor: "#ea580c",
      cursorAccent: WINDOW_CHROME.light.ground,
      selectionBackground: "rgba(9, 105, 218, 0.2)",
      selectionInactiveBackground: "rgba(9, 105, 218, 0.12)",
      ...LIGHT_SCROLLBAR,
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
      brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    name: "Solarized Dark",
    tone: "dark",
    colors: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.25)",
      selectionInactiveBackground: "rgba(147, 161, 161, 0.15)",
      ...DARK_SCROLLBAR,
      ...SOLARIZED_ACCENTS,
    },
  },
  "solarized-light": {
    id: "solarized-light",
    name: "Solarized Light",
    tone: "light",
    colors: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(88, 110, 117, 0.2)",
      selectionInactiveBackground: "rgba(88, 110, 117, 0.12)",
      ...LIGHT_SCROLLBAR,
      ...SOLARIZED_ACCENTS,
    },
  },
  dracula: {
    id: "dracula",
    name: "Dracula",
    tone: "dark",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(68, 71, 90, 0.9)",
      selectionInactiveBackground: "rgba(68, 71, 90, 0.6)",
      ...DARK_SCROLLBAR,
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  nord: {
    id: "nord",
    name: "Nord",
    tone: "dark",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "rgba(136, 192, 208, 0.25)",
      selectionInactiveBackground: "rgba(136, 192, 208, 0.15)",
      ...DARK_SCROLLBAR,
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
};

export function terminalThemeFor(id: TerminalThemeId): TerminalThemeDef {
  return TERMINAL_THEMES[id] ?? TERMINAL_THEMES["clawbox-dark"];
}

// ── Faces ──────────────────────────────────────────────────────────────

/**
 * What comes after the chosen face, for the glyphs a text face does not
 * carry: the Nerd Fonts symbols set (shipped) for powerline, devicons and the
 * private-use icons a TUI draws with; the platform's colour font for emoji,
 * which no monospace face has; then the faces the box image has (DejaVu,
 * Liberation) so a phone and the box's own Chromium fall through the same way.
 * Box drawing and block elements are drawn by the WebGL renderer itself, cell
 * exact, and come from the face only on the DOM fallback.
 */
const FONT_TAIL = '"Symbols Nerd Font Mono", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", Menlo, Consolas, monospace';

export interface TerminalFontDef {
  id: TerminalFontId;
  /** The face's own name, or null for the device's monospace. */
  face: string | null;
  /** A translation key where the name is ours to word; a face goes by its own name. */
  labelKey?: string;
  name: string;
  /** Shipped in public/fonts, so it must be loaded before the grid is measured. */
  bundled: boolean;
  family: string;
}

export const TERMINAL_FONTS: Record<TerminalFontId, TerminalFontDef> = {
  "jetbrains-mono": { id: "jetbrains-mono", face: "JetBrains Mono", name: "JetBrains Mono", bundled: true, family: `"JetBrains Mono", ${FONT_TAIL}` },
  "fira-code": { id: "fira-code", face: "Fira Code", name: "Fira Code", bundled: true, family: `"Fira Code", ${FONT_TAIL}` },
  "ibm-plex-mono": { id: "ibm-plex-mono", face: "IBM Plex Mono", name: "IBM Plex Mono", bundled: true, family: `"IBM Plex Mono", ${FONT_TAIL}` },
  // The device's own monospace first; the symbols and emoji after it still
  // cover what it lacks.
  system: { id: "system", face: null, labelKey: "terminal.settings.fontSystem", name: "System monospace", bundled: false, family: `ui-monospace, monospace, ${FONT_TAIL}` },
};

export function terminalFontFor(id: TerminalFontId): TerminalFontDef {
  return TERMINAL_FONTS[id] ?? TERMINAL_FONTS["jetbrains-mono"];
}

// ── The store ──────────────────────────────────────────────────────────

type Listener = () => void;

interface StoreState {
  settings: TerminalSettings;
  loaded: boolean;
  /** The last save was refused or never arrived; the change lives until reload. */
  saveFailed: boolean;
}

let state: StoreState = { settings: { ...DEFAULT_TERMINAL_SETTINGS }, loaded: false, saveFailed: false };
let loadPromise: Promise<TerminalSettings> | null = null;
// Changed before the stored value arrived: the owner's change wins over it.
let changedBeforeLoad = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit(next: Partial<StoreState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The settings as they stand, synchronously. */
export function getTerminalSettings(): TerminalSettings {
  return state.settings;
}

/**
 * Read the stored settings once per page. Every terminal asks; the first one
 * pays for the request, and a failed read leaves the defaults in place.
 */
export function loadTerminalSettings(): Promise<TerminalSettings> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const res = await fetch(`/setup-api/preferences?keys=${TERMINAL_SETTINGS_KEY}`);
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          if (!changedBeforeLoad) emit({ settings: normalizeTerminalSettings(data?.[TERMINAL_SETTINGS_KEY]) });
        }
      } catch {
        // Offline, or no session yet: the defaults stand.
      }
      emit({ loaded: true });
      return state.settings;
    })();
  }
  return loadPromise;
}

const SAVE_DELAY_MS = 400;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const body = JSON.stringify({ [TERMINAL_SETTINGS_KEY]: state.settings });
    fetch("/setup-api/preferences", { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((res) => emit({ saveFailed: !res.ok }))
      .catch(() => emit({ saveFailed: true }));
  }, SAVE_DELAY_MS);
}

/** Change some settings: every terminal redraws at once, the store is written a moment later. */
export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  if (!state.loaded) changedBeforeLoad = true;
  emit({ settings: normalizeTerminalSettings({ ...state.settings, ...patch }) });
  scheduleSave();
}

export function resetTerminalSettings(): void {
  updateTerminalSettings({ ...DEFAULT_TERMINAL_SETTINGS });
}

/** For tests: forget everything this page has read or written. */
export function resetTerminalSettingsStoreForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  loadPromise = null;
  changedBeforeLoad = false;
  state = { settings: { ...DEFAULT_TERMINAL_SETTINGS }, loaded: false, saveFailed: false };
  for (const listener of listeners) listener();
}

const getSnapshot = () => state;
const getServerSnapshot = () => state;

/** The settings, whether they have been read yet, and whether the last save failed. */
export function useTerminalSettings(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
