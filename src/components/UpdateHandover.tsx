"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTr } from "@/lib/i18n-floor";
import { UPDATING_PAGE } from "@/lib/update-constants";

/** How long the loader is up at least: long enough to read as a hand-over, not a flicker. */
export const HANDOVER_MIN_MS = 600;
/**
 * And at most, whatever the click's own request is doing. A request that never
 * answers must not hold a screen with no way off it: /updating follows a run
 * the box has, and goes back to the desktop at once when there is none.
 */
export const HANDOVER_MAX_MS = 10_000;

/** Nothing ever changes: the store only tells a hydrating render from a live one. */
const subscribeToNothing = () => () => undefined;

/**
 * The moment between Update and /updating (TASK-2146).
 *
 * A live run is /updating's to show. The System Update app used to draw it in
 * its own pane — inside Settings, or its window — for the few seconds before
 * the desktop's notice poll saw the update lock and moved the owner on, so the
 * same "Updating your device · Connecting…" appeared twice: in the window, then
 * full screen. The app now draws this instead: the whole screen, on /updating's
 * own ground, with the ClawBox mark and a spinner, then the page itself.
 *
 * `ready`: the click's request has answered and the box took the run — or
 * nothing was clicked here, because the run was already going when the app
 * opened. A run the box refused at the door is said in the app, so the loader
 * never leaves for a page that would have nothing to show; one it stops after
 * taking it (a refused harness downgrade) is said on /updating, with the
 * override, like any run that stops there.
 *
 * A portal onto document.body, not a box in the pane: a desktop window is
 * transformed, which pins a `fixed` child to the window instead of the screen.
 */
export default function UpdateHandover({ ready }: { ready: boolean }) {
  const tr = useTr();
  const [held, setHeld] = useState(false);
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    // `replace`: the page this leaves is one the middleware sends straight
    // back to /updating while the lock is held, so it is not kept in history.
    window.location.replace(UPDATING_PAGE);
  }, []);

  // Both clocks run from the moment the loader appears, whatever the request does.
  useEffect(() => {
    const min = window.setTimeout(() => setHeld(true), HANDOVER_MIN_MS);
    const max = window.setTimeout(leave, HANDOVER_MAX_MS);
    return () => {
      window.clearTimeout(min);
      window.clearTimeout(max);
    };
  }, [leave]);

  useEffect(() => {
    if (held && ready) leave();
  }, [held, ready, leave]);

  // Only ever mounted after an interaction or an answer, never from server
  // HTML; ReconnectStage explains why a portal still asks.
  const live = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  if (!live) return null;

  return createPortal(
    <div
      // /updating's ground (its page paints --bg-deep edge to edge), so the
      // page that replaces this one lands on the same colour. The scrim class
      // centres the mark on the main monitor of a row of them.
      className="main-screen-scrim fixed inset-0 flex items-center justify-center bg-[var(--bg-deep,#111827)]"
      style={{ zIndex: 2147483647 }}
      role="status"
      aria-live="polite"
      data-testid="update-handover"
    >
      <div className="flex flex-col items-center gap-7">
        <div className="flex items-center gap-3" aria-hidden="true" data-testid="update-handover-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- the box's own crab from public/, already cached by the desktop */}
          <img src="/clawbox-icon.png" alt="" width={56} height={56} loading="eager" draggable={false} className="h-14 w-14 object-contain" onError={(event) => { event.currentTarget.style.display = "none"; }} />
          <span className="font-display text-[28px] font-bold tracking-[-0.01em] text-[#f97316]">ClawBox</span>
        </div>
        <span className="h-7 w-7 rounded-full border-[3px] border-[var(--coral-bright)] border-t-transparent motion-safe:animate-spin" aria-hidden="true" />
        <span className="sr-only">{tr("update.heroUpdating", "Updating your device")}</span>
      </div>
    </div>,
    document.body,
  );
}
