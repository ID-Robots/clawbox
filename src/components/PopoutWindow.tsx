"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ChromeWindow from "./ChromeWindow";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

/**
 * A pop-out WINDOW: what an app or the chat opens beside itself — a run's
 * whole goal, the Create planner — drawn as a real desktop window rather than
 * a modal over a dimmed screen (the owner's ask, 2026-11-01: "draggable and
 * resizable and opening like a normal desktop window").
 *
 * It IS the desktop's window: ChromeWindow, the same title bar, drag, eight
 * resize handles, snap zones, double-click and button maximize, and the size
 * the owner last left it at (saved per `appId`). Two things differ from an
 * app window, because the desktop's window list does not own it:
 *
 * - no Minimize — there is no shelf entry to bring it back from;
 * - its own layer (`DESKTOP_LAYERS.popout`), in front of the app windows and
 *   the chat it was opened from, counted among the pop-outs alone: the one
 *   pressed last is in front and is the active one.
 *
 * Non-modal: the desktop behind stays live. Escape still closes the FRONT
 * pop-out — when focus is inside it, or nowhere at all — the one keyboard path
 * a dialog had that a window should keep. It is listened for on the document,
 * in the commit that opens the window, and stopped there: the chat listens on
 * `window`, and one Escape must not take the pop-out AND the conversation it
 * was opened from (the old Create card's CI flake, 2026-09-07). Focus goes
 * back to where it was when the window opened. A key the content has already
 * handled (`preventDefault`, e.g. a menu inside closing itself) is left alone.
 * On a phone it opens maximized, the way every window is drawn there.
 */

/** The pop-outs open now, back to front. */
let stack: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => stack;

function raise(id: string) {
  if (stack[stack.length - 1] === id) return;
  stack = [...stack.filter((s) => s !== id), id];
  emit();
}

function drop(id: string) {
  if (!stack.includes(id)) return;
  stack = stack.filter((s) => s !== id);
  emit();
}

/** The layer cap: pop-outs never climb into the overlays (launcher, tray). */
const MAX_POPOUT_Z = DESKTOP_LAYERS.overlay - 1;

/** Below the desktop's phone breakpoint (page.tsx draws apps full-screen there). */
function isPhoneWidth(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

export interface PopoutWindowProps {
  /** The title bar's text. */
  title: string;
  /** Keys the remembered size, and the window's `chrome-window-<appId>` test id. */
  appId: string;
  defaultWidth?: number;
  defaultHeight?: number;
  onClose: () => void;
  children: ReactNode;
}

export default function PopoutWindow({ title, appId, defaultWidth = 760, defaultHeight = 560, onClose, children }: PopoutWindowProps) {
  const id = useId();
  const order = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [phone] = useState(isPhoneWidth);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  // Where focus was when the window opened — read before anything inside
  // takes it — so an Escape can put it back.
  const [opener] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));

  // Opened in front, in the commit that draws it; forgotten on close.
  useLayoutEffect(() => {
    raise(id);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (stack[stack.length - 1] !== id) return;
      const target = e.target as Node | null;
      const nowhere = !target || target === document.body || target === document.documentElement || (target as unknown) === document;
      if (!nowhere && !contentRef.current?.contains(target)) return;
      e.stopPropagation();
      onCloseRef.current();
      if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) opener.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      drop(id);
    };
  }, [id, opener]);

  const index = order.indexOf(id);
  const zIndex = Math.min(DESKTOP_LAYERS.popout + Math.max(0, index), MAX_POPOUT_Z);
  const isActive = index !== -1 && index === order.length - 1;
  const focus = useCallback(() => raise(id), [id]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <ChromeWindow
      title={title}
      appId={appId}
      defaultWidth={defaultWidth}
      defaultHeight={defaultHeight}
      isActive={isActive}
      zIndex={zIndex}
      onClose={onClose}
      onFocus={focus}
      initialMaximized={phone}
    >
      <div ref={contentRef} className="h-full" onPointerDownCapture={focus}>
        {children}
      </div>
    </ChromeWindow>,
    document.body,
  );
}
