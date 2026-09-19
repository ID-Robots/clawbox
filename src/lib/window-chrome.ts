"use client";

/**
 * The desktop window's chrome in one place. ChromeWindow draws its frame from
 * these values, and an app that carries the chrome on into its own content —
 * the Terminal's tab strip — reads the same ones instead of choosing a grey of
 * its own. That was the Terminal's look before: a purple-grey strip under the
 * title bar and a canvas a shade off the window around it.
 *
 * The desktop is dark. `light` is the same frame for an app whose content is
 * light (the Terminal on a light theme), so the title bar, the strip and the
 * page under them stay one palette rather than a dark lid on a white box.
 */

import { createContext, useContext } from "react";

export type WindowTone = "dark" | "light";

export interface WindowChromePalette {
  /** The active window's title bar. */
  titleBar: string;
  /** A title bar behind another window. */
  titleBarInactive: string;
  /** A strip the app carries on under the bar (the Terminal's tabs): the bar's own lower edge. */
  strip: string;
  /** The line between chrome and content, and between strips. */
  hairline: string;
  /** The content's ground under an app that draws none of its own. */
  ground: string;
  /** The frame's shadow and outline ring, focused and not. */
  shadow: string;
  shadowInactive: string;
  /** Tailwind classes for the title text and the window-control glyphs. */
  titleClass: string;
  titleInactiveClass: string;
  controlClass: string;
  controlHoverClass: string;
}

export const WINDOW_CHROME: Record<WindowTone, WindowChromePalette> = {
  dark: {
    titleBar: "linear-gradient(180deg, #292d36 0%, #242830 100%)",
    titleBarInactive: "#1f2228",
    strip: "#242830",
    hairline: "rgba(255, 255, 255, 0.06)",
    ground: "#181c22",
    shadow: "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)",
    shadowInactive: "0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.04)",
    titleClass: "text-white/80",
    titleInactiveClass: "text-white/50",
    controlClass: "text-white/60",
    controlHoverClass: "hover:bg-white/10 active:bg-white/20",
  },
  light: {
    titleBar: "linear-gradient(180deg, #f4f5f7 0%, #eceef1 100%)",
    titleBarInactive: "#f1f2f4",
    strip: "#eceef1",
    hairline: "rgba(15, 23, 42, 0.09)",
    ground: "#fafbfc",
    shadow: "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.18)",
    shadowInactive: "0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.12)",
    titleClass: "text-black/75",
    titleInactiveClass: "text-black/45",
    controlClass: "text-black/55",
    controlHoverClass: "hover:bg-black/[0.07] active:bg-black/15",
  },
};

/**
 * What a desktop window offers the app inside it. `actions` is the element in
 * the title bar, beside minimise, that an app may portal its own controls into
 * (the Terminal's settings gear); it is null until the bar has mounted. Outside
 * a desktop window — the standalone /app page — there is no context at all,
 * and the app keeps those controls in its own content.
 */
export interface WindowChrome {
  actions: HTMLElement | null;
  /** Whether the window is the focused one — its bar changes colour, and a strip under it should too. */
  active: boolean;
  tone: WindowTone;
  setTone: (tone: WindowTone) => void;
}

export const WindowChromeContext = createContext<WindowChrome | null>(null);

export function useWindowChrome(): WindowChrome | null {
  return useContext(WindowChromeContext);
}
