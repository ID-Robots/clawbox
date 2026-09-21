/**
 * Chat-first on a phone.
 *
 * The box is used from a phone far more often than from a big screen, and on a
 * phone the thing people open it for is the assistant — frequently by voice,
 * hands busy. The desktop grid underneath is still one tap away (the chat's
 * "Desktop" button, the Android back gesture), but the page LANDS in the chat.
 *
 * Two independent signals, either of which is enough:
 *
 *  - a phone-sized viewport — the same `< 768px` the desktop already uses to
 *    switch every surface to its phone layout (`isMobile` in page.tsx,
 *    ChromeShelf), so the two can never disagree about what a phone is;
 *  - a launch from the installed home-screen app (`display-mode: standalone`
 *    and its siblings) on a TOUCH device, which covers a tablet whose viewport
 *    is wider than the phone breakpoint. A desktop browser's installed app has a
 *    fine pointer and keeps the desktop exactly as it was.
 *
 * Pure and window-free at its core so the routing decision is testable without
 * a DOM; `readChatFirstEnvironment` is the one place that touches `window`.
 */

/** Below this viewport width the desktop draws its phone layout. */
export const PHONE_MAX_WIDTH = 768;

export interface ChatFirstEnvironment {
  /** `window.innerWidth`. */
  width: number;
  /** Launched as an installed app (standalone, fullscreen or minimal-ui). */
  standalone: boolean;
  /** The primary pointer is coarse — a finger rather than a mouse. */
  coarsePointer: boolean;
}

export function isPhoneViewport(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < PHONE_MAX_WIDTH;
}

export function shouldOpenChatFirst(env: ChatFirstEnvironment): boolean {
  if (isPhoneViewport(env.width)) return true;
  return env.standalone && env.coarsePointer;
}

/** The display modes a home-screen launch can report, per the manifest's `display` / `display_override`. */
const INSTALLED_DISPLAY_MODES = ["standalone", "fullscreen", "minimal-ui"] as const;

type MatchMediaWindow = Pick<Window, "innerWidth"> & {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: Navigator & { standalone?: boolean };
};

function mediaMatches(win: MatchMediaWindow, query: string): boolean {
  try {
    return typeof win.matchMedia === "function" && win.matchMedia(query).matches === true;
  } catch {
    return false;
  }
}

export function readChatFirstEnvironment(win: MatchMediaWindow): ChatFirstEnvironment {
  const standalone =
    INSTALLED_DISPLAY_MODES.some((mode) => mediaMatches(win, `(display-mode: ${mode})`)) ||
    // iOS Safari's home-screen launch predates the display-mode query.
    win.navigator?.standalone === true;
  return {
    width: win.innerWidth,
    standalone,
    coarsePointer: mediaMatches(win, "(pointer: coarse)"),
  };
}
