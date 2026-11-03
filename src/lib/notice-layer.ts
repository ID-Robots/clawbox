import { DESKTOP_LAYERS } from "@/lib/window-snap";

/**
 * Where the desktop's top-right notice column — the update card, a finished
 * run, a Telegram pairing, a background task, the toasts — stands in the
 * stacking order (TASK-2129).
 *
 * The column never moves: it is pinned to the top-right corner, and the chat
 * docked there, floating there or full-screen on a phone overlaps it. What
 * decides which of the two is seen is the desktop's own focus model — the
 * counter app windows and the floating chat already draw their layers from
 * (`nextZIndex` in page.tsx). The column takes a slot from that counter when a
 * bubble arrives or the owner presses or hovers one; the chat, a window or a
 * pop-out the owner presses afterwards takes a later slot and stands in front
 * of it, until the column is raised again.
 *
 * The counter alone orders the column against what draws from it — app
 * windows and the floating chat. Three surfaces stand on fixed layers instead,
 * and are ordered here by the slot they were last pressed at:
 *
 * - the chat when it holds the corner — docked to the right, or full-screen
 *   on a phone — at `DESKTOP_LAYERS.chat`, above every window;
 * - the phone's one window, at `PHONE_WINDOW_LAYER`;
 * - pop-out windows, in their own band from `DESKTOP_LAYERS.popout`.
 */

/** The phone's one window (`mobile-app-window` in page.tsx): above the whole window band. */
export const PHONE_WINDOW_LAYER = 200;

export interface NoticeLayerOrder {
  /** The slot the column took in the focus counter when it was last raised. */
  slot: number;
  /** The counter's next free slot: whatever was raised since the column holds a slot above `slot`. */
  next: number;
  /** A pop-out window was opened or pressed since the column was last raised. */
  popoutRaised: boolean;
  /**
   * The chat while it holds a FIXED layer over the corner — docked, or
   * full-screen on a phone — as the slot it was last pressed (or opened) at;
   * null while it is closed or floating, when its counter slot orders it.
   */
  fixedChatSlot: number | null;
  /** On a phone, the counter slot of the one window drawn; null on a desktop or with no window up. */
  phoneWindowSlot: number | null;
}

export function noticeLayerZIndex(order: NoticeLayerOrder): number {
  const raisedSince = order.popoutRaised || order.slot < order.next - 1;
  // Nothing has been raised since: above everything but menus and modals —
  // the docked chat, the pop-outs, the launcher.
  if (!raisedSince) return DESKTOP_LAYERS.notice;
  // A docked or full-screen chat the owner has NOT pressed since: the column
  // stays in front of it. What was raised since is a window — and in the
  // corner a window is under that chat — or a pop-out, whose band starts at
  // this value and wins the tie by coming later in the document (a portal on
  // `body`).
  if (order.fixedChatSlot !== null && order.fixedChatSlot < order.slot) return DESKTOP_LAYERS.chat + 1;
  // A phone draws one window, on a fixed layer: the column goes under it when
  // it was raised after the column, and stays over it otherwise.
  if (order.phoneWindowSlot !== null) {
    return order.phoneWindowSlot > order.slot ? PHONE_WINDOW_LAYER - 1 : PHONE_WINDOW_LAYER + 1;
  }
  // Its own slot: above every window raised before it, under every one since.
  return order.slot;
}
