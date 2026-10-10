"use client";

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TOAST_EVENT } from "@/components/ToastHost";
import { captureScreen, currentCaptureScale } from "@/components/screenshot/capture";
import { CaptureError, IGNORE_ATTRIBUTE } from "@/components/screenshot/dom-capture";
import { useT } from "@/lib/i18n";
import { type Point, type Rect, clampRect, formatSize, isUsableRegion, rectFromPoints } from "@/lib/screenshot/geometry";
import {
  type CaptureRequest,
  type OverlayOwner,
  CAPTURE_REQUEST_EVENT,
  openInScreenshot,
  primaryOverlayId,
  registerOverlay,
  subscribeOverlays,
} from "@/lib/screenshot/session";
import { captureShortcut, createShortcutState, isCaptureShortcutKey } from "@/lib/screenshot/shortcuts";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

/**
 * The Screenshot app's presence on the desktop (TASK-1475): its capture keys,
 * the region selector and the countdown. Mounted once with the desktop, so a
 * capture can be taken with the app's window closed — the window opens itself
 * on the result.
 *
 *   Print Screen          the whole screen
 *   Shift + Print Screen  a region
 *   Alt + Shift + S       a region, where Print Screen never reaches the page
 *
 * Everything this component draws carries `data-screenshot-ignore`, which the
 * built-in renderer skips, and is unmounted before the picture is taken, which
 * is what keeps it out of the browser's own capture.
 */

type Phase =
  | { name: "idle" }
  | { name: "selecting"; request: CaptureRequest }
  | { name: "countdown"; request: CaptureRequest; region: Rect | null; left: number }
  | { name: "capturing"; request: CaptureRequest; region: Rect | null; read: boolean };

const IDLE: Phase = { name: "idle" };
/** Above every desktop layer, the confirmations included: a selection must be able to cover them. */
const OVERLAY_Z = DESKTOP_LAYERS.modal + 10;
const IGNORE = { [IGNORE_ATTRIBUTE]: "" };

function viewportSize() {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  };
}

/** The app window under a point, ignoring this overlay — what a click (rather than a drag) selects. */
function windowRectAt(x: number, y: number): Rect | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest(`[${IGNORE_ATTRIBUTE}]`)) continue;
    const win = el.closest("[data-window-id]");
    if (!win) return null;
    const box = win.getBoundingClientRect();
    const rect = clampRect({ x: box.left, y: box.top, width: box.width, height: box.height }, viewportSize());
    return isUsableRegion(rect) ? rect : null;
  }
  return null;
}

/** Two frames: one for React to take the overlay off the page, one for the browser to paint without it. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 400);
  });
}

function ScreenshotOverlay({ owner = "desktop" }: { owner?: OverlayOwner }) {
  const { t } = useT();
  const tRef = useRef(t);
  tRef.current = t;

  const [phase, setPhaseState] = useState<Phase>(IDLE);
  const phaseRef = useRef<Phase>(IDLE);
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const [drag, setDrag] = useState<{ start: Point; current: Point } | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);

  // Registered for as long as it is mounted, ACTING only while it is the one
  // in charge. Two can be mounted for a moment — a restored Screenshot window
  // brings its own before the desktop's has appeared — and both listening
  // would take one Print Screen twice.
  const registration = useRef<number | null>(null);
  useEffect(() => {
    const entry = registerOverlay(owner);
    registration.current = entry.id;
    return () => {
      registration.current = null;
      entry.release();
    };
  }, [owner]);
  const active = useSyncExternalStore(
    subscribeOverlays,
    () => registration.current !== null && primaryOverlayId() === registration.current,
    () => false,
  );

  // The Screenshot window steps aside for the WHOLE capture — the selection
  // and the countdown too, or it would be sitting on what the owner wants to
  // pick — and comes back the moment the page has been read.
  const hiddenRef = useRef<{ el: HTMLElement; previous: string } | null>(null);
  const hide = useCallback((el: HTMLElement | null | undefined) => {
    if (!el || !el.isConnected || hiddenRef.current) return;
    hiddenRef.current = { el, previous: el.style.visibility };
    el.style.visibility = "hidden";
  }, []);
  const unhide = useCallback(() => {
    const hidden = hiddenRef.current;
    if (!hidden) return;
    hiddenRef.current = null;
    hidden.el.style.visibility = hidden.previous;
  }, []);
  useEffect(() => unhide, [unhide]);

  const shoot = useCallback(
    async (request: CaptureRequest, region: Rect | null) => {
      setPhase({ name: "capturing", request, region, read: false });
      const restore = () => {
        unhide();
        const now = phaseRef.current;
        if (now.name === "capturing" && !now.read) setPhase({ ...now, read: true });
      };
      try {
        hide(request.hide);
        await settle();
        const shot = await captureScreen({
          engine: request.engine,
          region,
          blockedLabel: tRef.current("screenshot.notCaptured"),
          onRead: restore,
        });
        openInScreenshot({
          kind: "capture",
          bitmap: shot.bitmap,
          engine: shot.engine,
          skipped: shot.skipped,
          regionApplied: shot.regionApplied,
        });
      } catch (err) {
        const code = err instanceof CaptureError ? err.code : "render";
        const key =
          code === "denied"
            ? "screenshot.captureCancelled"
            : code === "unsupported"
              ? "screenshot.captureUnsupported"
              : "screenshot.captureFailed";
        console.error("[screenshot] capture failed:", err instanceof Error ? err.message : err);
        window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message: tRef.current(key) } }));
      } finally {
        unhide();
        setPhase(IDLE);
      }
    },
    [hide, setPhase, unhide],
  );

  const proceed = useCallback(
    (request: CaptureRequest, region: Rect | null) => {
      setDrag(null);
      setHover(null);
      if (request.delay > 0) setPhase({ name: "countdown", request, region, left: Math.round(request.delay) });
      else void shoot(request, region);
    },
    [setPhase, shoot],
  );

  const begin = useCallback(
    (request: CaptureRequest) => {
      if (phaseRef.current.name !== "idle") return;
      hide(request.hide);
      if (request.mode === "region") {
        setDrag(null);
        setHover(null);
        setPhase({ name: "selecting", request });
      } else {
        proceed(request, null);
      }
    },
    [hide, proceed, setPhase],
  );

  const cancel = useCallback(() => {
    const now = phaseRef.current;
    if (now.name !== "selecting" && now.name !== "countdown") return;
    setDrag(null);
    setHover(null);
    unhide();
    setPhase(IDLE);
  }, [setPhase, unhide]);

  // The app's buttons ask through an event; so could anything else on the page.
  useEffect(() => {
    if (!active) return;
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<CaptureRequest>).detail;
      if (!detail || (detail.mode !== "full" && detail.mode !== "region")) return;
      begin({
        mode: detail.mode,
        delay: Number.isFinite(detail.delay) ? Math.min(Math.max(detail.delay, 0), 10) : 0,
        engine: detail.engine === "display" ? "display" : "dom",
        hide: detail.hide ?? null,
      });
    };
    window.addEventListener(CAPTURE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(CAPTURE_REQUEST_EVENT, onRequest);
  }, [active, begin]);

  // The desktop-wide keys. In the capture phase on `window`, so they are seen
  // before the terminal or the remote desktop — which would otherwise send
  // them on to a shell — gets a look.
  useEffect(() => {
    if (!active) return;
    const state = createShortcutState();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.type === "keydown") {
        const now = phaseRef.current.name;
        if (now === "selecting" || now === "countdown") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        return;
      }
      if (!isCaptureShortcutKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const mode = captureShortcut(event, state);
      if (mode) begin({ mode, delay: 0, engine: "dom", hide: null });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      // No longer the one in charge (or going away): whatever it was in the middle of asking is dropped.
      cancel();
    };
  }, [active, begin, cancel]);

  // The countdown: one tick a second, then the picture.
  useEffect(() => {
    if (phase.name !== "countdown") return;
    if (phase.left <= 0) {
      void shoot(phase.request, phase.region);
      return;
    }
    const timer = setTimeout(() => {
      const now = phaseRef.current;
      if (now.name === "countdown") setPhase({ ...now, left: now.left - 1 });
    }, 1000);
    return () => clearTimeout(timer);
  }, [phase, setPhase, shoot]);

  if (!active || phase.name === "idle") return null;

  if (phase.name === "capturing") {
    // Nothing on screen while the page is being read. Once it has been, the
    // built-in renderer still has a second of work to do — say so.
    if (!phase.read || phase.request.engine !== "dom") return null;
    return (
      <div
        {...IGNORE}
        className="pointer-events-none fixed left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[var(--bg-elevated)] px-4 py-2 text-sm text-white shadow-lg"
        style={{ zIndex: OVERLAY_Z }}
        role="status"
      >
        <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 18 }}>progress_activity</span>
        {t("screenshot.capturing")}
      </div>
    );
  }

  if (phase.name === "countdown") {
    const { region } = phase;
    return (
      <>
        {region && (
          <div
            {...IGNORE}
            className="pointer-events-none fixed rounded-sm border-2 border-dashed border-[var(--coral-bright)]"
            style={{ zIndex: OVERLAY_Z, left: region.x, top: region.y, width: region.width, height: region.height }}
          />
        )}
        <div
          {...IGNORE}
          className="fixed left-1/2 top-4 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-[var(--bg-elevated)] py-1.5 pl-2 pr-1.5 text-sm text-white shadow-lg"
          style={{ zIndex: OVERLAY_Z }}
          role="timer"
          aria-live="polite"
          data-testid="screenshot-countdown"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--coral-bright)] text-base font-semibold tabular-nums text-white">
            {phase.left}
          </span>
          <span>{t("screenshot.countdown", { seconds: phase.left })}</span>
          <button
            type="button"
            onClick={cancel}
            className="cursor-pointer rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
          >
            {t("screenshot.cancel")}
          </button>
        </div>
      </>
    );
  }

  // Selecting a region.
  const request = phase.request;
  const viewport = viewportSize();
  const dragRect = drag ? clampRect(rectFromPoints(drag.start, drag.current), viewport) : null;
  const dragging = !!dragRect && (dragRect.width > 0 || dragRect.height > 0);
  const focus = dragging ? dragRect : hover;
  const scale = request.engine === "display" ? window.devicePixelRatio || 1 : currentCaptureScale();
  const labelBelow = !!dragRect && dragRect.y + dragRect.height + 34 <= viewport.height;

  return (
    <div
      {...IGNORE}
      data-testid="screenshot-region-overlay"
      className="fixed inset-0 select-none"
      style={{ zIndex: OVERLAY_Z, touchAction: "none", cursor: "crosshair" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const point = { x: e.clientX, y: e.clientY };
        setHover(null);
        setDrag({ start: point, current: point });
      }}
      onPointerMove={(e) => {
        if (drag) {
          setDrag({ start: drag.start, current: { x: e.clientX, y: e.clientY } });
        } else if (e.pointerType === "mouse") {
          const next = windowRectAt(e.clientX, e.clientY);
          setHover((prev) =>
            prev && next && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height
              ? prev
              : next,
          );
        }
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const rect = clampRect(rectFromPoints(drag.start, { x: e.clientX, y: e.clientY }), viewport);
        setDrag(null);
        if (isUsableRegion(rect)) {
          proceed(request, rect);
          return;
        }
        // A press without a drag: the window under it, if there is one.
        const picked = windowRectAt(e.clientX, e.clientY);
        if (picked) proceed(request, picked);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {focus ? (
        <div
          className={`pointer-events-none fixed ${dragging ? "border border-white" : "border-2 border-[var(--coral-bright)]"}`}
          style={{
            left: focus.x,
            top: focus.y,
            width: focus.width,
            height: focus.height,
            // The dimming IS the shadow: everything but the selection goes dark.
            boxShadow: "0 0 0 200vmax rgba(0, 0, 0, 0.5)",
          }}
        />
      ) : (
        <div className="pointer-events-none fixed inset-0 bg-black/50" />
      )}

      {dragging && dragRect && (
        <div
          className="pointer-events-none fixed rounded-md bg-black/80 px-2 py-1 font-mono text-xs tabular-nums text-white shadow"
          data-testid="screenshot-region-size"
          style={{
            left: Math.min(Math.max(dragRect.x, 4), Math.max(4, viewport.width - 110)),
            top: labelBelow ? dragRect.y + dragRect.height + 6 : Math.max(4, dragRect.y + dragRect.height - 30),
          }}
        >
          {formatSize(dragRect, scale)}
        </div>
      )}

      <div
        className="pointer-events-none fixed left-1/2 top-4 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/15 bg-[var(--bg-elevated)] py-1.5 pl-4 pr-1.5 text-sm text-white shadow-lg"
        role="status"
      >
        <span className="min-w-0">{t("screenshot.regionHint")}</span>
        <button
          type="button"
          onClick={cancel}
          className="pointer-events-auto shrink-0 cursor-pointer rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
          style={{ cursor: "pointer" }}
        >
          {t("screenshot.cancel")}
        </button>
      </div>
    </div>
  );
}

export default memo(ScreenshotOverlay);
