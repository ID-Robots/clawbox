"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A question mark beside a label, with the long explanation behind it.
 *
 * The Coding Agent's settings had grown three- and four-line paragraphs under
 * every switch — accurate, and so much text that the controls were hard to find
 * among them. The prose is not wrong, it is just not wanted until it is: this
 * keeps the row to a label and puts the paragraph one tap away.
 *
 * Click, not hover: the desktop is used on a touch screen through the tunnel as
 * often as with a mouse, and a hover-only tooltip is invisible to a finger.
 * Escape and a click outside close it, like every other popover on the box.
 */
/** Kept in step with the w-64 below — the measurement has to know the width. */
const TIP_WIDTH_PX = 256;

export default function HelpTip({ text, label, testId }: {
  text: string;
  /** What the tip explains, for screen readers. */
  label: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Which edge the bubble hangs from. The rightmost column's tip ran past the
   *  window and gave the whole panel a horizontal scrollbar. */
  const [align, setAlign] = useState<"left" | "right">("left");
  const root = useRef<HTMLSpanElement | null>(null);

  // Measured against the panel it lives in, not the viewport: this is a desktop
  // window the owner resizes, so "fits on screen" is the wrong question — it has
  // to fit in the WINDOW. Falls back to the viewport when no bounds are marked.
  useLayoutEffect(() => {
    if (!open) return;
    const mark = root.current;
    if (!mark) return;
    const bounds = mark.closest("[data-help-bounds]")?.getBoundingClientRect();
    const right = bounds ? bounds.right : window.innerWidth;
    const rect = mark.getBoundingClientRect();
    setAlign(rect.left + TIP_WIDTH_PX > right - 12 ? "right" : "left");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = root.current;
      const target = event.target as Node | null;
      if (node && target && !node.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="relative inline-flex" ref={root}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label={label}
        data-testid={testId}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-white/15 text-[10px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-white/30 transition-colors"
      >
        ?
      </button>
      {open && (
        // Anchored to the mark and clamped to a readable measure. z-20 clears
        // the switches it sits between.
        <span
          role="tooltip"
          data-testid={testId ? `${testId}-text` : undefined}
          className={`absolute top-6 z-30 w-64 max-w-[min(16rem,80vw)] rounded-xl border border-white/10 bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)] shadow-lg shadow-black/40 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
