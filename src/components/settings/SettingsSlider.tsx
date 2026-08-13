"use client";

import type { ChangeEvent, ReactNode } from "react";

export interface SettingsSliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  /** Accessible name for the range input. */
  label: string;
  id?: string;
  /** The value badge's text. Pass the caller's existing string unchanged. */
  badge?: ReactNode;
  className?: string;
}

/** M3's published gap between the handle and the active track. */
const HANDLE_GAP = 6;

/**
 * The M3 slider.
 *
 * The control stays a native `input[type="range"]` — the e2e suite locates the
 * opacity slider as `settingsWindow.locator('input[type="range"]')` and expects
 * exactly one match in the whole pane, so this must never become a div with
 * pointer handlers, and no second range may be introduced.
 *
 * The native input is transparent and sits on top; the track, the active track
 * and the handle are painted underneath. The handle is M3's current 4×20
 * rounded BAR rather than a circle, drawn by `.settings-slider__input`'s
 * pseudo-elements in globals.css — a range thumb cannot be styled inline.
 *
 * (The visual spec writes the handle-to-track gap as 20px; 20 is the handle's
 * HEIGHT, and M3's gap is 6dp. A 20px gap reads as a broken track at these
 * widths, so the published 6 is used.)
 */
export default function SettingsSlider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled = false,
  label,
  id,
  badge,
  className = "",
}: SettingsSliderProps) {
  const span = max - min || 1;
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100));

  return (
    <div className={`flex items-center gap-[16px] ${className}`}>
      <div className="relative flex h-[44px] min-w-0 flex-1 items-center">
        {/* inactive track */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 h-[4px] rounded-full bg-[var(--set-surface-container-highest)]"
        />
        {/* active track, stopping short of the handle */}
        <div
          aria-hidden="true"
          className="absolute left-0 h-[4px] rounded-full bg-[var(--set-primary)]"
          style={{ width: `max(0px, calc(${pct}% - ${HANDLE_GAP}px))` }}
        />
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-label={label}
          className="settings-slider__input relative w-full cursor-pointer bg-transparent disabled:cursor-default disabled:opacity-40"
        />
      </div>
      {badge !== undefined && badge !== null && (
        <span className="shrink-0 rounded-[8px] bg-[var(--set-secondary-container)] px-[8px] py-[4px] text-[12px] font-medium text-[var(--set-on-secondary-container)]">
          {badge}
        </span>
      )}
    </div>
  );
}
