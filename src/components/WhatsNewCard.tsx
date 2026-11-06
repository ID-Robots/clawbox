"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useT } from "@/lib/i18n";
import {
  displayVersion,
  hasPlanCta,
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_HIGHLIGHTS as HIGHLIGHTS,
  WHATS_NEW_PLANS_URL,
  type WhatsNewState,
} from "@/lib/whats-new";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import { isEditable, keysAreOurs, trapTab } from "@/lib/modal-keys";
import WhatsNewLightbox from "@/components/WhatsNewLightbox";

interface WhatsNewCardProps {
  state: WhatsNewState;
  /** The owner closed the card. The caller records the dismissal. */
  onDismiss: () => void;
  /**
   * The owner is using the card: a slide was turned, a key pressed or the card
   * touched. The desktop stops the clock that would otherwise hide it.
   */
  onEngage?: () => void;
}

/** How far a finger has to travel sideways to turn a slide, in CSS pixels. */
const SWIPE_PX = 40;

/**
 * "What's new in 4.3": a dialog over the desktop, shown after a box lands on
 * 4.3 until the owner dismisses it (TASK-1059, TASK-1195).
 *
 * A carousel, one highlight per slide: a screenshot of the feature, its title
 * and a line or two about it. The owner pages through with Back and Next, the
 * dots, the arrow keys or a swipe. The last slide carries the docs link and
 * the plan section, which names only what the box's plan does not cover yet.
 * A Max box sees no plan section. A Pro box sees only the edition switch. The
 * Hermes edition is told about switching back to OpenClaw, not about
 * switching to Hermes.
 *
 * It fits any screen without scrolling the page: the dialog is never taller
 * than the viewport, the screenshot's height is a share of it, and on a
 * screen too short even for that the slide scrolls inside the dialog while the
 * header and the buttons stay put.
 */
export default function WhatsNewCard({ state, onDismiss, onEngage }: WhatsNewCardProps) {
  const { t } = useT();
  const version = displayVersion(state.version);
  const showPlan = hasPlanCta(state.cta);
  const total = HIGHLIGHTS.length;
  const [index, setIndex] = useState(0);
  // Which way the last turn went, so the new slide comes in from that side.
  const [direction, setDirection] = useState<1 | -1>(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // The slide's screenshot, full screen (WhatsNewLightbox). Mirrored in a ref
  // for the window's key handler, which stands aside while it is up.
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | null>(null);
  const last = index === total - 1;
  const item = HIGHLIGHTS[index];

  // Read through refs by the window's key handler, which is attached once.
  const engageRef = useRef(onEngage);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    engageRef.current = onEngage;
    dismissRef.current = onDismiss;
  }, [onEngage, onDismiss]);

  const clamp = useCallback((i: number) => Math.max(0, Math.min(total - 1, i)), [total]);
  /** One slide back (-1) or on (1); nothing past either end. */
  const step = useCallback((by: 1 | -1) => {
    engageRef.current?.();
    setDirection(by);
    setIndex((current) => clamp(current + by));
  }, [clamp]);
  const goTo = useCallback((target: number) => {
    engageRef.current?.();
    setDirection(target >= index ? 1 : -1);
    setIndex(clamp(target));
  }, [clamp, index]);
  const back = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);

  // A dialog takes the focus while it is up and gives it back when it goes, so
  // the arrow keys and Tab start here rather than behind the backdrop.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus({ preventScroll: true });
    };
  }, []);

  // The arrow keys turn the slides and Escape closes, from anywhere on the
  // page: the dialog covers it all, so it hears them first (capture) and the
  // desktop behind it does not hear them at all. A key typed into a field is
  // left alone, so a composer that grabbed the focus keeps its cursor keys.
  // Tab is kept inside the dialog. None of it while a surface drawn OVER the
  // dialog has the keys — a power approval prompt, the screenshot overlay:
  // its Escape is not a dismissal of this card, and its Tab is its own.
  // Attached in a layout effect, before the dialog is first painted: a key
  // pressed the moment it shows (a passive effect can run later than that)
  // was lost.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (fullscreenRef.current) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const dialog = dialogRef.current;
      const backdrop = backdropRef.current;
      if (!dialog || !backdrop || !keysAreOurs(dialog, backdrop)) return;
      if (event.key === "Tab") {
        trapTab(event, dialog);
        return;
      }
      if (isEditable(event.target)) return;
      if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "Escape") dismissRef.current();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step]);

  // The next slide's screenshot is fetched while this one is read, so turning
  // to it never shows an empty frame.
  useEffect(() => {
    const following = HIGHLIGHTS[index + 1];
    if (!following || typeof Image === "undefined") return;
    const img = new Image();
    img.src = following.image;
  }, [index]);

  const openFullscreen = () => {
    engageRef.current?.();
    fullscreenRef.current = true;
    setFullscreen(true);
  };
  const closeFullscreen = useCallback(() => {
    fullscreenRef.current = false;
    setFullscreen(false);
  }, []);
  // Back from the full-screen view, the focus returns to the expand button —
  // of the slide now on screen, which the view may have turned.
  const wasFullscreen = useRef(false);
  useEffect(() => {
    if (fullscreen) { wasFullscreen.current = true; return; }
    if (!wasFullscreen.current) return;
    wasFullscreen.current = false;
    expandButtonRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  const onTouchStart = (event: ReactTouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    if (end - start <= -SWIPE_PX) next();
    else if (end - start >= SWIPE_PX) back();
  };
  // Anything done inside the dialog counts as using it, keys included — even
  // the ones the window's handler leaves alone (Tab, Enter on a button).
  const engage = () => engageRef.current?.();

  return (
    // `main-screen-scrim`: in monitor mode the dialog centres on the main
    // monitor, not on the seam between two (globals.css).
    <div
      ref={backdropRef}
      className="main-screen-scrim fixed inset-0 flex items-center justify-center bg-black/60 p-3 sm:p-6 overscroll-contain animate-in fade-in duration-200"
      style={{
        zIndex: DESKTOP_LAYERS.overlay,
        paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
      }}
      data-testid="whats-new-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        tabIndex={-1}
        onPointerDown={engage}
        onKeyDown={engage}
        className="flex w-full max-w-[34rem] max-h-full flex-col overflow-hidden rounded-2xl border border-orange-400/25 bg-[var(--bg-elevated)] shadow-2xl outline-none animate-in zoom-in-95 fade-in duration-200"
        data-testid="whats-new-card"
      >
        <div className="flex shrink-0 items-start gap-3 px-4 pt-3.5 pb-2.5 sm:px-5">
          <div className="w-9 h-9 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shrink-0">
            <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 20 }} aria-hidden="true">
              auto_awesome
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="whats-new-title" className="text-base font-semibold text-white m-0 leading-tight">
              {t("whatsNew.title")}
            </h2>
            {version && (
              <p className="text-xs text-white/60 mt-0.5 mb-0">{t("whatsNew.subtitle", { version })}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="w-8 h-8 flex items-center justify-center rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
            aria-label={t("whatsNew.dismiss")}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }} aria-hidden="true">close</span>
          </button>
        </div>

        <section
          aria-roledescription="carousel"
          aria-label={t("whatsNew.highlightsLabel")}
          className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-5"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          data-testid="whats-new-slides"
        >
          <div aria-live="polite">
            <div
              key={index}
              role="group"
              aria-roledescription="slide"
              aria-label={t("whatsNew.slideLabel", { current: index + 1, total })}
              className={`animate-in fade-in duration-300 motion-reduce:animate-none ${direction === 1 ? "slide-in-from-right-4" : "slide-in-from-left-4"}`}
              data-testid="whats-new-slide"
              data-slide={index}
            >
              {/* The frame keeps its shape while the picture loads, and its
                  height is a share of the viewport, so a short screen gets a
                  smaller picture rather than a dialog that runs off it. */}
              <div className="relative mx-auto w-full max-h-[34dvh] aspect-[16/10] overflow-hidden rounded-xl border border-white/10 bg-black/40">
                {/* A click on the picture opens it full screen too; the
                    button is the keyboard's and the screen reader's way. */}
                {/* eslint-disable-next-line @next/next/no-img-element -- a fixed asset from public/, drawn at its own size */}
                <img
                  src={item.image}
                  alt=""
                  width={1024}
                  height={640}
                  decoding="async"
                  draggable={false}
                  onClick={openFullscreen}
                  className="block h-full w-full cursor-zoom-in object-cover object-center select-none"
                  data-testid="whats-new-image"
                />
                <button
                  ref={expandButtonRef}
                  type="button"
                  onClick={openFullscreen}
                  aria-label={t("whatsNew.openFullscreen")}
                  aria-haspopup="dialog"
                  className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/75 hover:text-white cursor-pointer"
                  data-testid="whats-new-expand"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">open_in_full</span>
                </button>
              </div>
              <h3 className="mt-3.5 mb-0 text-center text-[15px] font-semibold leading-snug text-white">
                {t(item.title)}
              </h3>
              <p className="mx-auto mt-1 mb-0 max-w-[30rem] text-center text-[13px] leading-5 text-white/65 min-h-10">
                {t(item.summary)}
              </p>

              {last && (
                <>
                  {showPlan && (
                    <div className="mt-3 rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/10 px-3 py-2" data-testid="whats-new-plan">
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fuchsia-100">
                        <span className="material-symbols-rounded text-fuchsia-300" style={{ fontSize: 15 }} aria-hidden="true">
                          workspace_premium
                        </span>
                        {t("whatsNew.planTitle")}
                      </div>
                      <ul className="list-none m-0 mt-1 p-0 space-y-0.5 text-[12px] leading-snug text-fuchsia-50/85">
                        {state.cta.paidFeatures && <li>{t("whatsNew.planPaidFeatures")}</li>}
                        {state.cta.editionSwitch === "hermes" && <li>{t("whatsNew.planSwitchToHermes")}</li>}
                        {state.cta.editionSwitch === "openclaw" && <li>{t("whatsNew.planSwitchToOpenclaw")}</li>}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2.5 text-center">
                    <a
                      href={WHATS_NEW_DOCS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-orange-300 hover:text-orange-200 no-underline"
                    >
                      {t("whatsNew.readMore")}
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        <div className="shrink-0 px-4 pt-2 pb-3.5 sm:px-5">
          <div className="flex items-center justify-center gap-0.5 pb-2">
            {HIGHLIGHTS.map((highlight, i) => (
              <button
                key={highlight.title}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t("whatsNew.goToSlide", { number: i + 1 })}
                aria-current={i === index ? "step" : undefined}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-transparent border-none cursor-pointer p-0"
                data-testid="whats-new-dot"
              >
                <span
                  aria-hidden="true"
                  className={`block h-2 rounded-full transition-all duration-200 ${i === index ? "w-5 bg-orange-500" : "w-2 bg-white/25 hover:bg-white/45"}`}
                />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={back}
              disabled={index === 0}
              className={`inline-flex items-center gap-0.5 px-2.5 py-1.5 rounded-md bg-transparent hover:bg-white/10 text-white/70 hover:text-white text-[13px] font-medium transition-colors cursor-pointer border-none${index === 0 ? " invisible" : ""}`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_left</span>
              {t("whatsNew.back")}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {!last && (
                <button
                  type="button"
                  onClick={next}
                  className="inline-flex items-center gap-0.5 pl-4 pr-2.5 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-[13px] font-semibold transition-colors cursor-pointer border-none"
                >
                  {t("whatsNew.next")}
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>
                </button>
              )}
              {last && showPlan && (
                <a
                  href={WHATS_NEW_PLANS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 px-3.5 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-[13px] font-semibold transition-colors no-underline"
                >
                  {t("whatsNew.seePlans")}
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
                </a>
              )}
              {last && (
                <button
                  type="button"
                  onClick={onDismiss}
                  className={`px-4 py-1.5 rounded-md text-[13px] transition-colors cursor-pointer border-none ${showPlan ? "bg-white/5 hover:bg-white/10 text-white/75 font-medium" : "bg-orange-500 hover:bg-orange-600 text-white font-semibold"}`}
                >
                  {t("whatsNew.gotIt")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {fullscreen && <WhatsNewLightbox index={index} onStep={step} onClose={closeFullscreen} />}
    </div>
  );
}
