"use client";

import type { ReactNode } from "react";

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
      className={`flex overflow-hidden rounded-[20px] ${className}`}
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
              minHeight: 40,
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
