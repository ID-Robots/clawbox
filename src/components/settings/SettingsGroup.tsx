"use client";

import type { ReactNode } from "react";

export interface SettingsGroupProps {
  children: ReactNode;
  /** Extra classes for the caller's own layout needs. Never colour. */
  className?: string;
  /**
   * Draw the 16px-inset dividers between children. On by default.
   * Pass `divided={false}` when the group holds one non-row child (a grid of
   * wallpaper tiles, a chart) rather than a list of rows.
   */
  divided?: boolean;
}

/**
 * The group — a BORDERLESS tonal surface.
 *
 * This replaces the old `rounded-2xl border border-[var(--border-subtle)]
 * bg-[var(--surface-card)]` card, and it is the single biggest visual change
 * in the redesign. The old pane was outline-based: every group was a bordered
 * box of equal weight, so nothing had hierarchy and the surface never told you
 * how far from the page a thing was. In Material 3 a lighter surface *is* the
 * elevation, so the group reads because of its tone, not because of a line
 * around it. Borders are for outlined variants only.
 *
 * Dividers are drawn in CSS, off the container, as a `::before` on every child
 * after the first. The 16px inset and "no divider after the last row" both fall
 * out of `> * + *` for free, and there is no wrapper element and no key.
 *
 * They are emphatically NOT interleaved React nodes, and `children` is NOT run
 * through `Children.toArray`. `toArray` drops the `false` that plain JSX keeps
 * as a placeholder and then hands every unkeyed child a POSITIONAL key computed
 * after that drop — so the moment a caller writes `{cond && <SettingsRow …/>}`,
 * toggling `cond` renumbers every later child and React unmounts and remounts
 * all of them. In this pane that is not cosmetic: it would blow away the
 * `#ui-user-name` field mid-type, re-fire the WiFi password `autoFocus`, remount
 * the `invisible h-0` LocalAI overlay along with its checklist effects and its
 * 900ms `onConfigured` timer, and wipe the imperative `#copy-code-btn`
 * textContent. Rendering `{children}` straight through keeps React's own
 * positional slots, which is why today's hand-written markup is safe.
 */
export default function SettingsGroup({
  children,
  className = "",
  divided = true,
}: SettingsGroupProps) {
  // `> * + *` also gives the conditional-row case the right answer for free: a
  // child that renders null / false produces no DOM node, so no divider is
  // drawn for a row that is not there.
  const dividers = divided
    ? "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:left-[16px] [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-[var(--set-outline-variant)] [&>*+*]:before:content-['']"
    : "";

  return (
    <div
      className={`rounded-[16px] bg-[var(--set-surface-container)] py-[4px] ${dividers} ${className}`}
    >
      {children}
    </div>
  );
}
