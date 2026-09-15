"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Keep a scrolling transcript on its newest line while the reader is there.
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
 * transcript is at (or within `threshold` of) its bottom it follows every
 * growth — a direct child resizing, or nodes and text being added — and the
 * moment the reader scrolls up to read, nothing moves it until they scroll
 * back down. A scroll a caller forces (a send) lands at the bottom and so
 * re-pins by the same rule.
 */

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
export const STICK_THRESHOLD_PX = 80;

export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  /** Whether the container is on screen; the observers are attached when it is. */
  enabled: boolean,
  threshold: number = STICK_THRESHOLD_PX,
): void {
  // Starts pinned: a transcript that opens is read from its newest line.
  const pinned = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return;
    let disposed = false;
    let scheduled = false;

    const onScroll = () => {
      pinned.current = isNearBottom(el, threshold);
    };

    // One scroll per frame however many observers fired in it — a streaming
    // turn changes text on every token.
    const follow = () => {
      if (!pinned.current || scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        if (disposed || !pinned.current) return;
        el.scrollTop = el.scrollHeight;
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    };

    el.addEventListener("scroll", onScroll, { passive: true });

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

    // Nodes and text added anywhere inside: a new card, a streamed token.
    // Children added here are observed for size from now on.
    const mutations = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          observeChildren();
          follow();
        })
      : null;
    mutations?.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      disposed = true;
      el.removeEventListener("scroll", onScroll);
      resize?.disconnect();
      observed.clear();
      mutations?.disconnect();
    };
  }, [containerRef, enabled, threshold]);
}
