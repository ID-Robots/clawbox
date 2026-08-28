"use client";

import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, SyntheticEvent } from "react";

export * from "@/lib/window-chrome";

/** A press on a control never starts a drag (the chat's stopHeaderDrag). */
const stop = (e: SyntheticEvent) => e.stopPropagation();

type StripButtonProps = {
  /** Required: the accessible name AND the tooltip. */
  label: string;
  /** A latched state (the chat's docked button): coral ink on a coral tint. */
  on?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className" | "children" | "aria-label" | "title">;

/** One of the strip's small stroked buttons — the chat's open/dock/close controls. */
export function StripButton({ label, on, onClick, className, children, ...rest }: StripButtonProps) {
  return (
    <button
      type="button"
      className={`win-strip-btn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      data-on={on ? "true" : undefined}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** The strip's glyphs, every one a stroked 24-grid path drawn in currentColor. */
export const StripIcon = Object.freeze({
  minimize: (
    <svg width={14} height={14} strokeWidth={2.5} {...svgProps}>
      <path d="M5 12h14" />
    </svg>
  ),
  maximize: (
    <svg width={14} height={14} strokeWidth={2} {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  ),
  restore: (
    <svg width={14} height={14} strokeWidth={2} {...svgProps}>
      <rect x="3" y="8" width="13" height="13" rx="2" />
      <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" />
    </svg>
  ),
  /** The chat's close, character for character. */
  close: (
    <svg width={16} height={16} strokeWidth={2.5} {...svgProps}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  /** The chat's dock/undock (phase 2). */
  dock: (
    <svg width={14} height={14} strokeWidth={2} {...svgProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  ),
  /** The chat's open-full and the mobile header's "Switch app". */
  openFull: (
    <svg width={14} height={14} strokeWidth={2.5} {...svgProps}>
      <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
    </svg>
  ),
  /** The chat's open-in-new (phase 2). */
  openExternal: (
    <svg width={14} height={14} strokeWidth={2.5} {...svgProps}>
      <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5" />
    </svg>
  ),
  /** The mobile header's back chevron. */
  back: (
    <svg width={18} height={18} strokeWidth={2.5} {...svgProps}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
});

/** The chat's in-flight ring. Not used by ChromeWindow yet — it exists for phase 2. */
export function StripSpinner() {
  return (
    <div style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} aria-hidden="true">
      <div
        style={{
          width: 12,
          height: 12,
          border: "2px solid rgba(249,115,22,0.3)",
          borderTopColor: "#f97316",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
    </div>
  );
}
