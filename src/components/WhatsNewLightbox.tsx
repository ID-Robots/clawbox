"use client";

import { useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { keysAreOurs, trapTab } from "@/lib/modal-keys";
import { WHATS_NEW_HIGHLIGHTS as HIGHLIGHTS } from "@/lib/whats-new";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

interface WhatsNewLightboxProps {
  /** The highlight whose screenshot is shown — the card's slide, which follows it. */
  index: number;
  /** One screenshot back (-1) or on (1). The card turns its slide with it. */
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
}

/** How far a finger has to travel sideways to turn to the next screenshot, in CSS pixels. */
const SWIPE_PX = 40;

/**
 * A What's new screenshot, full screen: the feature's picture at full
 * resolution (`fullImage`), fitted to the screen and never drawn larger than
 * it is, on a dark backdrop.
 *
 * ✕, Escape, or a click or tap anywhere but on a button closes it. ◀ ▶, the
 * arrow keys and a swipe move to the previous or next feature's screenshot,
 * and the card's slide moves with it, so closing lands on the feature last
 * looked at.
 *
 * Portalled to the body, over the card's own dialog: inside it, the dialog's
 * transform would make a `fixed` box hang off the dialog instead of the
 * screen. One step above the card's layer, and so still under the notice
 * layer, where a power approval prompt is drawn.
 */
export default function WhatsNewLightbox({ index, onStep, onClose }: WhatsNewLightboxProps) {
  const { t } = useT();
  const total = HIGHLIGHTS.length;
  const item = HIGHLIGHTS[index];
  const title = t(item.title);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | null>(null);
  // A swipe that turned the picture must not also count as the tap that closes it.
  const swiped = useRef(false);

  const stepRef = useRef(onStep);
  const closeRef = useRef(onClose);
  useEffect(() => {
    stepRef.current = onStep;
    closeRef.current = onClose;
  }, [onStep, onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes the view (and only the view: the card stays), the arrows
  // turn, Tab stays inside. The card's own handler stands aside while this is
  // up, and a surface stacked over this one keeps its keys.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const root = rootRef.current;
      if (!root || !keysAreOurs(root, root)) return;
      if (event.key === "Tab") {
        trapTab(event, root);
        return;
      }
      if (event.key === "Escape") closeRef.current();
      else if (event.key === "ArrowRight") stepRef.current(1);
      else if (event.key === "ArrowLeft") stepRef.current(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The neighbours' full pictures are fetched while this one is looked at.
  useEffect(() => {
    if (typeof Image === "undefined") return;
    for (const neighbour of [HIGHLIGHTS[index - 1], HIGHLIGHTS[index + 1]]) {
      if (!neighbour) continue;
      const img = new Image();
      img.src = neighbour.fullImage;
    }
  }, [index]);

  const onTouchStart = (event: ReactTouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
    swiped.current = false;
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    if (end - start <= -SWIPE_PX) { swiped.current = true; onStep(1); }
    else if (end - start >= SWIPE_PX) { swiped.current = true; onStep(-1); }
  };
  // Anywhere but a button: the picture, its caption or the dark around it.
  const onClick = (event: ReactMouseEvent) => {
    if (swiped.current) { swiped.current = false; return; }
    if ((event.target as HTMLElement).closest("button")) return;
    onClose();
  };

  const control =
    "flex items-center justify-center rounded-full border-none bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20 cursor-pointer disabled:cursor-default disabled:opacity-0";

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("whatsNew.fullscreenLabel", { title })}
      // `main-screen-scrim`: in monitor mode, on the main monitor (globals.css).
      className="main-screen-scrim fixed inset-0 flex items-center justify-center bg-black/90 px-2 py-14 sm:px-16 animate-in fade-in duration-150"
      style={{ zIndex: DESKTOP_LAYERS.overlay + 1 }}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      data-testid="whats-new-lightbox"
      data-slide={index}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label={t("whatsNew.closeFullscreen")}
        className={`${control} absolute right-3 top-3 h-10 w-10`}
        style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden="true">close</span>
      </button>

      {/* Sized in % of the scrim, which is the main monitor in monitor mode:
          a viewport unit there is the whole row of monitors. */}
      <div className="flex h-full max-w-full flex-col items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed asset from public/, drawn at its own size */}
        <img
          key={item.fullImage}
          src={item.fullImage}
          alt={title}
          decoding="async"
          draggable={false}
          className="block h-auto w-auto min-h-0 max-w-full max-h-[calc(100%-4.25rem)] sm:max-h-[calc(100%-2.25rem)] rounded-lg object-contain shadow-2xl select-none"
          data-testid="whats-new-lightbox-image"
        />
        {/* On a phone ◀ ▶ sit under the picture, either side of the caption:
            at its sides they covered its edges. From `sm` up there is room
            for them at the sides of the screen. */}
        <div className="mt-3 flex w-full items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={index === 0}
            aria-label={t("whatsNew.previousScreenshot")}
            className={`${control} h-11 w-11 shrink-0 sm:absolute sm:left-3 sm:top-1/2 sm:-translate-y-1/2`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 28 }} aria-hidden="true">chevron_left</span>
          </button>
          <p className="m-0 min-w-0 text-center text-sm text-white/85">
            {title}
            <span className="text-white/45"> · {t("whatsNew.slideLabel", { current: index + 1, total })}</span>
          </p>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={index === total - 1}
            aria-label={t("whatsNew.nextScreenshot")}
            className={`${control} h-11 w-11 shrink-0 sm:absolute sm:right-3 sm:top-1/2 sm:-translate-y-1/2`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 28 }} aria-hidden="true">chevron_right</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
