import { describe, expect, it } from "vitest";
import { noticeLayerZIndex, PHONE_WINDOW_LAYER, type NoticeLayerOrder } from "@/lib/notice-layer";
import { DESKTOP_GAP, DESKTOP_LAYERS, MIN_DOCKED_CHAT_WIDTH } from "@/lib/window-snap";

/**
 * TASK-2129: the top-right notice column stands in the corner for good and
 * takes turns with the chat and the windows in the stacking order, instead of
 * stepping aside. Slots are the desktop's focus counter (`nextZIndex`): the
 * column at 105 with the counter at 106 is the last thing raised.
 */

function order(over: Partial<NoticeLayerOrder> = {}): NoticeLayerOrder {
  return { slot: 105, next: 106, popoutRaised: false, fixedChatSlot: null, phoneWindowSlot: null, ...over };
}

describe("noticeLayerZIndex", () => {
  it("stands over everything but menus and modals while nothing was raised after it", () => {
    expect(noticeLayerZIndex(order())).toBe(DESKTOP_LAYERS.notice);
    // Over a docked chat it was raised after, too: the default when a bubble
    // arrives with the chat already docked.
    expect(noticeLayerZIndex(order({ fixedChatSlot: 104 }))).toBe(DESKTOP_LAYERS.notice);
    expect(DESKTOP_LAYERS.notice).toBeGreaterThan(DESKTOP_LAYERS.chat);
    expect(DESKTOP_LAYERS.notice).toBeGreaterThan(DESKTOP_LAYERS.overlay);
  });

  it("goes under a window or the floating chat pressed after it — and stays over the ones pressed before", () => {
    // Windows at 103 and 104 were focused before the column took 105; the one
    // pressed now took 106.
    const z = noticeLayerZIndex(order({ next: 107 }));
    expect(z).toBe(105);
    expect(z).toBeGreaterThan(104);
    expect(z).toBeLessThan(106);
  });

  it("goes under the docked or full-screen chat once the owner presses it", () => {
    const z = noticeLayerZIndex(order({ next: 107, fixedChatSlot: 106 }));
    expect(z).toBeLessThan(DESKTOP_LAYERS.chat);
  });

  it("stays over a docked chat that was not pressed, when a window was", () => {
    // In the corner a window is under the docked chat anyway: the column must
    // not vanish behind the chat for a press somewhere else.
    const z = noticeLayerZIndex(order({ next: 107, fixedChatSlot: 104 }));
    expect(z).toBeGreaterThan(DESKTOP_LAYERS.chat);
    // …and no higher than a pop-out could stand.
    expect(z).toBeLessThanOrEqual(DESKTOP_LAYERS.popout);
  });

  it("goes under a pop-out pressed after it", () => {
    expect(noticeLayerZIndex(order({ popoutRaised: true }))).toBeLessThan(DESKTOP_LAYERS.popout);
    expect(noticeLayerZIndex(order({ popoutRaised: true, fixedChatSlot: 104 }))).toBeLessThanOrEqual(DESKTOP_LAYERS.popout);
  });

  it("on a phone, goes under the one window when it was tapped after, and stays over it otherwise", () => {
    expect(noticeLayerZIndex(order({ next: 107, phoneWindowSlot: 106 }))).toBe(PHONE_WINDOW_LAYER - 1);
    // The chat was tapped (and closed again): the window from before stays under.
    expect(noticeLayerZIndex(order({ next: 107, phoneWindowSlot: 101 }))).toBe(PHONE_WINDOW_LAYER + 1);
    // Whichever, the full-screen chat tapped after the column covers it.
    expect(noticeLayerZIndex(order({ next: 107, fixedChatSlot: 106, phoneWindowSlot: 101 }))).toBeLessThan(DESKTOP_LAYERS.chat);
    // A counter that has run past 200 cannot lift it over the phone's window.
    expect(noticeLayerZIndex(order({ slot: 400, next: 402, phoneWindowSlot: 401 }))).toBe(PHONE_WINDOW_LAYER - 1);
  });
});

describe("the corner the column stands in", () => {
  // What page.tsx draws: `w-[320px]`, NOTICE_MARGIN 16 from the top and right.
  const COLUMN = { width: 320, margin: 16 };

  it("lies inside the docked chat's strip at its narrowest", () => {
    // Why a window pressed with the chat docked does not send the column
    // under the chat: in that corner nothing but the chat can be seen.
    const vw = 1440;
    const chatLeft = vw - DESKTOP_GAP - MIN_DOCKED_CHAT_WIDTH;
    expect(vw - COLUMN.margin - COLUMN.width).toBeGreaterThanOrEqual(chatLeft);
    expect(vw - COLUMN.margin).toBeLessThanOrEqual(vw - DESKTOP_GAP);
    expect(COLUMN.margin).toBeGreaterThanOrEqual(DESKTOP_GAP);
  });
});
