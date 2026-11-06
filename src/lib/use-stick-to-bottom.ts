"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Keep a scrolling transcript on its newest line while the reader is there —
 * and ONLY while they are there.
 *
 * The chat scrolled to the bottom only when `messages`, the streaming text or
 * the queued sends changed. Half of what a turn draws changes none of them:
 * the tool pills, the coding-agent card (re-polled every few seconds while a
 * run works, its screenshot arriving after its first paint), the clarify,
 * email and approval cards, the image banner, the status line, and any picture
 * that loads after the message holding it was laid out. Each of those grew the
 * transcript below the fold, and the owner saw a chat that had stopped at the
 * top of a card whose bottom half was out of sight.
 *
 * So the reader's POSITION decides, not which state changed: while the
 * transcript is pinned to its bottom it follows every growth — a direct child
 * resizing, or nodes and text being added — and the moment the reader scrolls
 * up to read, nothing moves it until they are back at the bottom.
 *
 * This hook is the ONLY thing that scrolls the transcript (TASK-2222). Both
 * chats also used to `scrollIntoView` their end sentinel two frames after
 * every change of the streaming text, whatever the reader was doing: while a
 * reply streamed (a chunk every few tens of milliseconds) a reader who
 * scrolled up was put back at the bottom a moment later, so the chat looked
 * frozen. And "pinned" was a distance (within 80 px of the bottom), re-read on
 * every scroll event — a wheel tick, a trackpad or a finger moves the first
 * few pixels in several frames, and the next chunk's follow landed before the
 * reader was 80 px away: it snapped them back AND cancelled the browser's
 * smooth scroll in flight. So:
 *
 *  - an upward scroll the reader makes lets go at once, however small;
 *  - while the reader's hands are on it (a wheel or key scroll still
 *    animating, a finger down, the scrollbar held) nothing is written to the
 *    scroll position at all;
 *  - it follows again once the reader is back at the very bottom (or moves
 *    down to within `threshold` of it), or when the caller says so — a send,
 *    a conversation opened or switched to — through the callback it returns.
 */

/** How close to the bottom a reader moving DOWN is caught and followed again, in CSS pixels. */
export const STICK_THRESHOLD_PX = 80;
/** "At the very bottom": what is left once the browser rounds a fractional scroll position. */
export const AT_BOTTOM_PX = 2;
/** How long a wheel or key scroll counts as the reader's, after its last event. */
export const HANDS_ON_MS = 300;

export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** The keys that scroll a focused scroller. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Follow the transcript in `containerRef` while the reader is at its bottom.
 * Returns `scrollToBottom`, stable for the component's life: it pins the
 * transcript and lands it on its newest line — for the owner's own send and
 * for a conversation that opens, never for something the bot wrote.
 */
export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  /** Whether the container is on screen; the observers are attached when it is. */
  enabled: boolean,
  threshold: number = STICK_THRESHOLD_PX,
): () => void {
  // Starts pinned: a transcript that opens is read from its newest line.
  const pinned = useRef(true);
  // The attached effect's follow, so `scrollToBottom` can schedule it; null
  // while the transcript is off screen (it is followed when it comes back).
  const followRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback(() => {
    pinned.current = true;
    followRef.current?.();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return;
    let disposed = false;
    let scheduled = false;
    let frame: number | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // The reader's hands: a wheel or key scroll until `handsOnUntil`, a
    // finger down, the scrollbar (or the transcript's own box) held.
    let handsOnUntil = 0;
    let touching = false;
    let holding = false;
    let lastTop = el.scrollTop;

    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const handsOn = () => touching || holding || now() < handsOnUntil;

    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < lastTop;
      lastTop = top;
      // At the very bottom — the reader came back, a follow landed, or the
      // content shrank and the browser clamped the position there: follow.
      if (isNearBottom(el, AT_BOTTOM_PX)) pinned.current = true;
      // Anywhere else, up is the reader leaving: let go, however few pixels.
      else if (movedUp) pinned.current = false;
      // Down, by the reader's own hand, to within the threshold: caught.
      else if (handsOn() && isNearBottom(el, threshold)) pinned.current = true;
    };

    const write = () => {
      // One layout read per write, and the write itself: nothing to thrash.
      el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop;
    };

    const run = () => {
      scheduled = false;
      frame = null;
      if (disposed) return;
      // A transcript that fits has no position to keep: a short new
      // conversation (or one just cleared) is followed from its first line.
      if (!pinned.current && el.scrollHeight - el.clientHeight <= AT_BOTTOM_PX) pinned.current = true;
      if (!pinned.current) return;
      if (handsOn()) {
        // Mid-gesture: writing now would cancel the reader's own scroll. A
        // touch or a held scrollbar follows on release; a wheel or a key once
        // its last event has had time to land.
        if (!touching && !holding && retry === null) {
          retry = setTimeout(() => { retry = null; follow(); }, Math.max(0, handsOnUntil - now()) + 16);
        }
        return;
      }
      write();
    };

    // At most one scroll per frame however many observers fired in it — a
    // streaming turn changes text on every chunk.
    const follow = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        const id = requestAnimationFrame(run);
        // A frame that already ran (a synchronous stand-in) has nothing to cancel.
        if (scheduled) frame = id;
      } else {
        setTimeout(run, 0);
      }
    };
    followRef.current = follow;

    const onWheel = () => { handsOnUntil = now() + HANDS_ON_MS; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) handsOnUntil = now() + HANDS_ON_MS;
    };
    const onTouchStart = () => { touching = true; };
    const onTouchEnd = (event: TouchEvent) => {
      touching = event.touches.length > 0;
      // A drag up has already let go of the bottom by its scroll events, and
      // the fling after it only takes the reader further up; a tap left them
      // where they were, at the bottom, with what grew meanwhile to catch up on.
      if (!touching) follow();
    };
    // A press on the transcript's own box rather than on a bubble in it: the
    // scrollbar, which belongs to the element.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) holding = true;
    };
    const onPointerUp = () => {
      if (!holding) return;
      holding = false;
      follow();
    };
    // A press or a touch whose end this page never hears (the window lost
    // focus in the middle of it) must not hold the transcript still for good.
    const onWindowBlur = () => {
      if (!touching && !holding) return;
      touching = false;
      holding = false;
      follow();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);

    // The container itself (the panel resized) and every direct child (a card
    // that grew in place, a picture that finished loading).
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    // What is observed right now, so a child that LEAVES is let go of. A
    // transcript is replaced wholesale on a session switch and on Clear, and an
    // observer that only ever added would keep every removed bubble and its
    // subtree reachable until the chat closed.
    const observed = new Set<Element>();
    const observeChildren = () => {
      if (!resize) return;
      const children = new Set<Element>(Array.from(el.children));
      for (const child of observed) {
        if (children.has(child)) continue;
        resize.unobserve(child);
        observed.delete(child);
      }
      for (const child of children) {
        if (observed.has(child)) continue;
        resize.observe(child);
        observed.add(child);
      }
    };
    resize?.observe(el);
    observeChildren();

    // Nodes and text added anywhere inside: a new card, a streamed chunk.
    // Children added here are observed for size from now on. Only the child
    // LIST of the transcript itself needs re-reading; anything deeper is
    // followed and never re-scanned.
    const mutations = typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
          if (records.some((r) => r.target === el && r.type === "childList")) observeChildren();
          follow();
        })
      : null;
    mutations?.observe(el, { childList: true, subtree: true, characterData: true });

    // Back on screen (or first shown) pinned: land on the newest line.
    if (pinned.current) follow();

    return () => {
      disposed = true;
      followRef.current = null;
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      if (retry !== null) clearTimeout(retry);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      resize?.disconnect();
      observed.clear();
      mutations?.disconnect();
    };
  }, [containerRef, enabled, threshold]);

  return scrollToBottom;
}
