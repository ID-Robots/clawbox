"use client";

import type { ReactNode } from "react";

export interface SettingsGroupHeaderProps {
  /** The Material Symbols ligature name, e.g. `palette`. */
  icon?: string;
  children: ReactNode;
  className?: string;
}

/**
 * The group header — `YOUR NAME`, `WALLPAPER`, `DISPLAY`.
 *
 * The text and the icon are the ones that ship today and must not change; only
 * the treatment does. It sits ABOVE its group rather than inside the surface,
 * which is what lets the group be a clean uninterrupted tonal plate.
 *
 * The icon is deliberately NOT `aria-hidden`. Material Symbols renders from a
 * ligature, so the node's text is the glyph name, and today's markup already
 * exposes it. Hiding it here would silently change accessible names in a file
 * whose e2e suite has no `data-testid` to fall back on.
 */
export default function SettingsGroupHeader({
  icon,
  children,
  className = "",
}: SettingsGroupHeaderProps) {
  return (
    <div
      className={`flex items-center gap-[8px] px-[16px] pt-[12px] pb-[4px] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--set-on-surface-variant)] ${className}`}
    >
      {icon && (
        <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }}>
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
