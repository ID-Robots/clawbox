"use client";

import type { ReactNode } from "react";

import { TOUCH_TARGET } from "./tokens";

export interface SettingsSegmentedOption {
  value: string;
  label: ReactNode;
  /** Extra classes for one segment — the fit-mode labels need `capitalize`. */
  labelClassName?: string;
}

export interface SettingsSegmentedProps {
  options: SettingsSegmentedOption[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The M3 segmented button — ONE outlined container, not a row of chips.
 *
 * The selected segment takes `secondary-container` plus a leading check, for
 * the same reason the nav does: primary is the ACTION colour and must not be
 * spent on a selection state.
 *
 * The check glyph is `aria-hidden`. Material Symbols renders from a ligature,
 * so without it the button's accessible name would become "check Fit" and the
 * e2e suite matches these by name.
 */
export default function SettingsSegmented({
  options,
  value,
  onChange,
  disabled = false,
  className = "",
}: SettingsSegmentedProps) {
  return (
    <div
      role="group"
      // 22px = SHAPE.full for a 44px-tall bar, i.e. a true pill. The visual
      // spec's §4 writes 20px and its §5 says the scale is 4/8/12/16/28 with
      // "nothing off-scale" — 20 satisfies neither. It was the pill radius for
      // the 40px height §4 assumed; at the 44px minimum target below, half the
      // height is 22, and a pill is a pill at any height. Recorded here rather
      // than added to `SHAPE`, which is a scale of fixed steps, not of halves.
      className={`flex overflow-hidden rounded-[22px] ${className}`}
      style={{ boxShadow: "inset 0 0 0 1px var(--set-outline)" }}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              // TOUCH_TARGET, not the 40 M3 draws at desktop density: the same
              // markup renders in the mobile tree, and the fit-mode control
              // this is aimed at is one the e2e suite clicks by name.
              minHeight: TOUCH_TARGET,
              boxShadow: i > 0 ? "inset 1px 0 0 0 var(--set-outline)" : undefined,
            }}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-[8px] border-none px-[12px] text-[14px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)] disabled:cursor-default disabled:opacity-40 ${
              selected
                ? "bg-[var(--set-secondary-container)] text-[var(--set-on-secondary-container)]"
                : "bg-transparent text-[var(--set-on-surface-variant)] hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)]"
            }`}
          >
            {selected && (
              <span
                aria-hidden="true"
                className="material-symbols-rounded shrink-0"
                style={{ fontSize: 18 }}
              >
                check
              </span>
            )}
            <span className={`truncate ${option.labelClassName ?? ""}`}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
