/**
 * Where a dragged surface lands when it is dropped against a screen edge.
 *
 * Shared because there are now TWO draggable surfaces on the desktop — the
 * app windows in `ChromeWindow` and the mascot chat in `ChatPopup` — and
 * "similar to regular windows" is the whole requirement for the second one.
 * A second copy of these zones is a copy that drifts: the threshold, the
 * shelf's real height and the strip the docked chat reserves all have to be
 * the same answer for both, or a chat snapped to the right half would sit at a
 * different edge than a window snapped to the same half.
 */

import { kioskBarInset } from "./kiosk-bar-inset";
import { hasNeighbour, mainScreen, screenAt, screenForRect, getDeskScreens, deskScreens, type DeskRect, type DeskScreen } from "./desktop-screens";

export type SnapZone =
  | "left" | "right" | "top"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | null;

/** Pixels from an edge that count as "dropped against it". */
export const SNAP_THRESHOLD = 12;

/**
 * The margin the desktop's floating surfaces keep from the screen edges and
 * from each other: the DOCKED chat's own margin, and the room a window opened
 * or centred beside it keeps from the panel (`fitWindowSize`,
 * `getInitialPosition`).
 *
 * One number, and it lives here, because the surfaces are measured against
 * each other: `page.tsx` adds this gap to the panel's width to build the strip
 * windows reserve, so the strip ends one gap short of the chat while the chat
 * keeps the same one on its far side. Kept apart they drifted — the window sat
 * 10px inside the desktop and the chat 12px, which is exactly the lopsidedness
 * that is visible when both are on screen.
 *
 * A window that fills the desktop takes NO gap: a SNAPPED window is flush by
 * design (`getSnapRect`), and since 2026-09-30 a MAXIMIZED window is too — it
 * used to sit this gap inside the desktop on every side, with its corners, and
 * the owner asked for the small paddings around the windows to go.
 */
export const DESKTOP_GAP = 6;

/**
 * The desktop's stacking order, in ONE place.
 *
 * Every floating surface on the desktop is `position: fixed`, so what covers
 * what is decided by numbers that were spread across five components — and
 * they had drifted apart. The app launcher is a MODAL (it has a full-screen
 * backdrop), but at 9999 it opened underneath the chat at 10010: nine of its
 * twelve app tiles were unclickable whenever the chat was open or docked, and
 * a click on one landed in the chat's composer instead.
 *
 * The ladder lives here beside `DESKTOP_GAP` for the same reason that number
 * does — two copies compared only by eye drift — and it is written down whole,
 * including the layers that were already right, so the next surface has
 * somewhere to be placed rather than a neighbour to copy.
 */
export const DESKTOP_LAYERS = {
  /** App windows; the desktop counts up from here as they are focused. */
  window: 100,
  shelf: 10_000,
  /** The crab/pet, which stands ON the shelf. */
  mascot: 10_001,
  /** The mascot chat — ChatPopup's own value, recorded so others can be placed against it. */
  chat: 10_010,
  /** Modal surfaces that must cover the chat: the app launcher, the system tray. */
  overlay: 10_020,
  /** Top-right notice cards, the upload toast, the file-drop overlay. */
  notice: 99_998,
  /** Context menus, the snap preview, the toast surface. */
  menu: 99_999,
  /** Confirmations that own the screen. */
  modal: 999_999,
} as const;

const SHELF_HEIGHT = 56;

/** The window title bar (`h-9`) — the strip that must stay reachable. */
export const TITLE_BAR_HEIGHT = 36;

/** A window is never squeezed below this, not even to fit a small desktop. */
export const MIN_WINDOW_WIDTH = 300;
export const MIN_WINDOW_HEIGHT = 200;

/**
 * The shelf's real height, safe-area inset included.
 *
 * ChromeShelf is `calc(56px + env(safe-area-inset-bottom))`; a flat 56 made a
 * maximized window overlap the bar — and the mascot standing on it. The inset
 * is a device property that cannot be read from JS, so the live element is
 * measured (it already marks itself `data-mascot-ground` for the mascot) and
 * 56 stays the fallback for a surface that has no shelf mounted.
 */
export function shelfHeight(): number {
  if (typeof document === "undefined") return SHELF_HEIGHT;
  const el = document.querySelector("[data-mascot-ground]") as HTMLElement | null;
  const h = el?.getBoundingClientRect().height ?? 0;
  return h > 0 ? h : SHELF_HEIGHT;
}

/**
 * The top of the desktop: 0, or the height of the kiosk bar the laptop's
 * kiosk extension draws over the page while other tabs are open
 * (`kiosk-bar-inset.ts`). Everything that lays a surface against the top edge
 * starts here, or the title bar it puts there is under the bar and cannot be
 * grabbed.
 */
export function desktopTop(): number {
  return kioskBarInset();
}

/**
 * The part of a screen windows may fill. The MAIN screen (the only one there
 * is without a monitor layout) starts under the kiosk bar, stops above the
 * shelf and, beside a docked chat, short of the strip the chat takes
 * (`rInset`); another monitor of a multi-monitor desktop is all window space.
 */
export function workArea(screen: DeskScreen, rInset = 0): DeskRect {
  if (!screen.main) return { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
  const top = desktopTop();
  return {
    x: screen.x,
    y: screen.y + top,
    width: screen.width - rInset,
    height: screen.height - shelfHeight() - top,
  };
}

/** Where a maximized window on the screen under `at` stands (the main screen's work area without `at`). */
export function maximizedRect(rInset = 0, at?: { x: number; y: number }): DeskRect {
  return workArea(at ? screenAt(at.x, at.y) : mainScreen(), rInset);
}

export function getSnapZone(clientX: number, clientY: number, rInset = 0): SnapZone {
  // The screen under the cursor; with one screen, the viewport.
  const screen = screenAt(clientX, clientY);
  const area = workArea(screen, rInset);
  // An edge shared with the next monitor is not an edge the cursor can rest
  // against — it crosses it on the way over — so it snaps nothing. Only where
  // the zone IS the monitor's edge, and only beside the cursor: next to a
  // docked chat the right-hand zone is the chat's side, inside the monitor
  // and shared with nothing (the one-screen desktop snaps there too), and a
  // tall monitor's edge below a shorter neighbour borders nothing at all.
  const at = { x: clientX, y: clientY };
  const shared = (side: "left" | "right" | "top" | "bottom", isMonitorEdge: boolean) => isMonitorEdge && hasNeighbour(screen, side, at);
  const nearLeft = clientX <= area.x + SNAP_THRESHOLD && !shared("left", area.x <= screen.x);
  const nearRight = clientX >= area.x + area.width - SNAP_THRESHOLD && !shared("right", area.x + area.width >= screen.x + screen.width);
  // Measured from the desktop's top, not the screen's: with the kiosk bar up
  // the screen's top 12px are the bar, which a drag can cross but which is
  // not where a window is being dropped against the desktop's top edge.
  const nearTop = clientY <= area.y + SNAP_THRESHOLD && !shared("top", area.y <= screen.y);
  const nearBottom = clientY >= area.y + area.height - SNAP_THRESHOLD && !shared("bottom", area.y + area.height >= screen.y + screen.height);

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  if (nearTop) return "top";
  return null;
}

/** Where a drag would snap: the zone, and a point on the monitor it would be laid on. */
export interface SnapTarget {
  zone: Exclude<SnapZone, null>;
  at: { x: number; y: number };
}

/**
 * What a drag over this point would snap to, for the preview plate — which
 * has to be laid on the monitor the DROP would use (`getSnapRect` with the
 * drop point); laid without a point it sat on the main monitor while the
 * window landed on another. `prev` is handed back while the zone and the
 * monitor are the same, so a drag along an edge re-renders the plate only
 * when it would move.
 */
export function snapTargetAt(clientX: number, clientY: number, rInset = 0, prev: SnapTarget | null = null): SnapTarget | null {
  const zone = getSnapZone(clientX, clientY, rInset);
  if (!zone) return null;
  if (prev && prev.zone === zone && screenAt(prev.at.x, prev.at.y).id === screenAt(clientX, clientY).id) return prev;
  return { zone, at: { x: clientX, y: clientY } };
}

/**
 * Pull a window back onto the visible desktop.
 *
 * Only the top edge was ever clamped (`Math.max(0, …)` in the drag handler), so
 * a window could be dragged, restored from `desktop_open_windows` or laid out
 * on a smaller screen with its title bar past every edge — and the title bar is
 * the only handle it has. Dropped under the shelf it was unreachable for good:
 * minimize/restore put it back where it was, and so did the next reload, since
 * the raw geometry is what gets persisted. Dropped off the right it kept its
 * minimize, maximize and close buttons, which live at that end, outside the
 * viewport.
 *
 * So: the title bar stays above the shelf, and the window's right edge stays on
 * the SCREEN. Deliberately the screen and not the desktop-minus-the-docked-chat
 * — a docked chat only narrows the desktop, and windows keep their own size and
 * place beside it (a window wider than the strip that is left would otherwise
 * jump to the left edge the moment the chat was docked). What the chat does own
 * is where a SNAPPED window is laid, which is `getSnapRect`'s answer.
 */
export function clampWindowPosition(
  rect: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  if (typeof window === "undefined") return { x: rect.x, y: rect.y };
  if (getDeskScreens()) {
    // Over a row of monitors: anywhere along the row, and on the monitor the
    // window is mostly on, under its top and with the title bar above its
    // bottom (the shelf's top on the main one) — a taller neighbour's bottom
    // is not this monitor's.
    const all = deskScreens();
    const left = Math.min(...all.map((s) => s.x));
    const right = Math.max(...all.map((s) => s.x + s.width));
    const spareRow = right - rect.width;
    const x = Math.min(Math.max(rect.x, Math.min(left, spareRow)), Math.max(left, spareRow));
    const area = workArea(screenForRect({ ...rect, x }));
    const y = Math.min(Math.max(rect.y, area.y), Math.max(area.y, area.y + area.height - TITLE_BAR_HEIGHT));
    return { x, y };
  }
  const spare = window.innerWidth - rect.width;
  const top = desktopTop();
  const availH = window.innerHeight - shelfHeight();
  // A window that FITS may sit anywhere in [0, spare]; one too wide for the
  // screen may stay where it is on the left but is never pushed further right.
  const x = Math.min(Math.max(rect.x, Math.min(0, spare)), Math.max(0, spare));
  // Below the kiosk bar (0 without one) and with the title bar above the shelf.
  const y = Math.min(Math.max(rect.y, top), Math.max(top, availH - TITLE_BAR_HEIGHT));
  return { x, y };
}

/**
 * Shrink a window that cannot fit on this desktop.
 *
 * A window restored at 881px tall onto an 844px desktop hides its own bottom
 * edge under the shelf: the resize handle that would fix it is down there too,
 * so the only way out is to resize from the top first. Used where geometry
 * arrives from OUTSIDE the window — a saved size, a restored workspace, a
 * viewport that shrank — never from a resize the owner is performing, and never
 * against the strip a docked chat reserves: that narrows the desktop, it does
 * not resize the windows on it.
 *
 * The one exception is a window being OPENED beside the chat (`rInset`, the
 * strip the panel takes): it has no size of its own yet, and centred at its
 * default width in the 576px left of an 858px panel it landed with its right
 * 534px — minimize, maximize and close among them — under the chat, reachable
 * only by dragging it out by the sliver of title bar still showing or by
 * undocking the chat. Such a window may be as wide as a maximized one beside
 * the chat: DESKTOP_GAP short of the panel and of the left edge.
 */
export function fitWindowSize(
  size: { width: number; height: number },
  rInset = 0,
  at?: { x: number; y: number },
): { width: number; height: number } {
  if (typeof window === "undefined") return { width: size.width, height: size.height };
  // The screen the window is on (`at`), else the main one — the viewport with
  // one screen, which is what this always measured.
  const area = workArea(at ? screenAt(at.x, at.y) : mainScreen(), rInset);
  const availW = rInset > 0 ? area.width - DESKTOP_GAP * 2 : area.width;
  const availH = area.height;
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(size.width, availW)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(size.height, availH)),
  };
}

/**
 * `fitWindowSize` for a window that already has a PLACE (`rect`): its height
 * is fitted to the monitor it is on (judged like `screenForRect`), its width
 * — over a row of monitors — to the whole row. A window may be stretched
 * across the seam on purpose, and `clampWindowPosition` leaves it there; fitted
 * to the one monitor its centre is on, it was cut back to that monitor's width
 * the moment the chat docked or a monitor changed. With one screen this is
 * `fitWindowSize(size)`.
 */
export function fitPlacedWindow(rect: DeskRect): { width: number; height: number } {
  const fitted = fitWindowSize(rect, 0, { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 18) });
  if (typeof window === "undefined" || !getDeskScreens()) return fitted;
  const all = deskScreens();
  const rowWidth = Math.max(...all.map((s) => s.x + s.width)) - Math.min(...all.map((s) => s.x));
  return { width: Math.max(MIN_WINDOW_WIDTH, Math.min(rect.width, rowWidth)), height: fitted.height };
}

/** The narrowest the docked chat panel is ever drawn. */
export const MIN_DOCKED_CHAT_WIDTH = 340;

/**
 * The widest the docked chat may be dragged: 60% of the screen it docks on —
 * the MAIN monitor over a row of monitors, the viewport (and the old cap)
 * with one screen. Measured against the whole row the cap was wider than the
 * main monitor: the panel could cover all of it, leaving windows a work area
 * of nothing, or hang across the seam onto the next one.
 */
export function dockedChatMaxWidth(): number {
  return mainScreen().width * 0.6;
}

/**
 * The width the docked chat is DRAWN at and the desktop reserves for it: the
 * owner's width, held to the main monitor's cap while the desktop is spread
 * over monitors (`spread`). The owner's width itself is never changed by it.
 */
export function dockedChatWidth(width: number, spread: boolean): number {
  if (!spread || width <= 0) return width;
  return Math.min(width, Math.max(MIN_DOCKED_CHAT_WIDTH, Math.floor(dockedChatMaxWidth())));
}

/**
 * Where the floating chat (`rect`, being dragged) may stand: its header below
 * the desktop's top, its right and bottom edges `margin` inside the screen,
 * and the top-left gutter when it is bigger than that. Over a row of monitors
 * the bottom is the bottom of the monitor it is on — the row is as tall as
 * its TALLEST monitor, and the strip under a shorter one is page that no
 * monitor shows, where the composer and the resize edge were out of reach.
 */
export function clampFloatingRect(rect: DeskRect, margin: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x: rect.x, y: rect.y };
  const x = Math.max(margin, Math.min(rect.x, window.innerWidth - rect.width - margin));
  if (!getDeskScreens()) {
    // The gutter starts under the kiosk bar on the laptop (0 elsewhere).
    const top = desktopTop() + margin;
    return { x, y: Math.max(top, Math.min(rect.y, window.innerHeight - rect.height - margin)) };
  }
  const screen = screenForRect({ ...rect, x });
  // Under the kiosk bar on the main monitor; the top of any other one.
  const top = workArea(screen).y + margin;
  return { x, y: Math.max(top, Math.min(rect.y, screen.y + screen.height - rect.height - margin)) };
}

export interface SnapRect { x: number; y: number; width: number; height: number }

/**
 * The rect a zone stands for, on the screen under `at` (the point the window
 * was dropped at, or its own centre) — the main screen without one, which is
 * the viewport with one screen.
 */
export function getSnapRect(zone: SnapZone, rInset = 0, at?: { x: number; y: number }): SnapRect | null {
  if (!zone) return null;
  // The strip between the kiosk bar (0 without one) and the shelf, on the
  // main screen; another monitor of the row is all window space.
  const a = workArea(at ? screenAt(at.x, at.y) : mainScreen(), rInset);
  const { x: l, y: t, width: w, height: h } = a;
  switch (zone) {
    case "left": return { x: l, y: t, width: w / 2, height: h };
    case "right": return { x: l + w / 2, y: t, width: w / 2, height: h };
    case "top": return { x: l, y: t, width: w, height: h };
    case "top-left": return { x: l, y: t, width: w / 2, height: h / 2 };
    case "top-right": return { x: l + w / 2, y: t, width: w / 2, height: h / 2 };
    case "bottom-left": return { x: l, y: t + h / 2, width: w / 2, height: h / 2 };
    case "bottom-right": return { x: l + w / 2, y: t + h / 2, width: w / 2, height: h / 2 };
    default: return null;
  }
}
