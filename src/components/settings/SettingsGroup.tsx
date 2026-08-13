"use client";

import { Children, Fragment, isValidElement, type ReactNode } from "react";

export interface SettingsGroupProps {
  children: ReactNode;
  /** Extra classes for the caller's own layout needs. Never colour. */
  className?: string;
  /**
   * Suppress the inset dividers. Use when the group holds one non-row child
   * (a grid of wallpaper tiles, a chart) rather than a list of rows.
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
 * Dividers between rows are real elements rather than `border-b`, because the
 * spec insets them 16px from the left and drops the one after the last row —
 * both awkward to express as a border, both trivial as an interleaved node.
 */
export default function SettingsGroup({
  children,
  className = "",
  divided = true,
}: SettingsGroupProps) {
  // `Children.toArray` already drops null / undefined / booleans, which is what
  // keeps `{cond && <SettingsRow …/>}` from drawing a divider for a row that is
  // not there. Empty strings survive it, so they go here.
  const rows = Children.toArray(children).filter((child) => child !== "");

  return (
    <div
      className={`rounded-[16px] bg-[var(--set-surface-container)] py-[4px] ${className}`}
    >
      {divided
        ? rows.map((row, i) => (
            <Fragment key={isValidElement(row) && row.key != null ? row.key : i}>
              {i > 0 && (
                <div
                  aria-hidden="true"
                  className="ml-[16px] h-px bg-[var(--set-outline-variant)]"
                />
              )}
              {row}
            </Fragment>
          ))
        : rows}
    </div>
  );
}
