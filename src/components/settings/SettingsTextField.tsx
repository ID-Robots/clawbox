"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface SettingsTextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  /** Rendered before the input, inside the filled plate. */
  leading?: ReactNode;
  /** Rendered after the input, inside the filled plate — reveal eyes, units. */
  trailing?: ReactNode;
  /**
   * Helper or error text under the field. Wired to the input with
   * `aria-describedby`, so it is part of what the field announces.
   */
  helper?: ReactNode;
  /**
   * Paints the bottom indicator and the helper with the error role, AND sets
   * `aria-invalid` plus a polite live region on the helper. Colour alone is
   * not an error state (1.4.1) and a red line no screen reader mentions is not
   * error identification (3.3.1) — the pane's existing password-mismatch hint
   * announces via `role="alert" aria-live="polite"` today, and a field routed
   * through this primitive has to keep announcing.
   */
  invalid?: boolean;
  className?: string;
  inputClassName?: string;
}

/**
 * The M3 FILLED text field.
 *
 * A filled plate on `surface-container-highest` with a bottom indicator, not a
 * box outline — the pane's problem was that everything was outlined, so every
 * element carried the same weight. The indicator is 1px `outline` at rest and
 * 2px `primary` on focus.
 *
 * Both indicators are absolutely positioned rather than being a real
 * `border-bottom`, so focus does not change the element's box and the field
 * cannot shift the row by a pixel when it gains focus.
 *
 * `leading` / `trailing` are FLEX SIBLINGS of the input, not absolutely
 * positioned decorations. Today's fields park icons on top of the input and
 * compensate with `pl-10` / `pr-12`, which couples the icon to the padding and
 * overlaps the value the moment either changes.
 *
 * THIS PRIMITIVE DOES NOT NAME ITSELF. It has no `label` prop by design — the
 * fields it is aimed at are already named by a sibling `<label htmlFor>` or by
 * an `aria-label` in the section body. Every call site must therefore pass one
 * or the other; the props spread accepts `aria-label` / `aria-labelledby` /
 * `id` straight through. A field with neither ships unnamed with no
 * compile-time signal, so check it when migrating a section.
 */
export default function SettingsTextField({
  leading,
  trailing,
  helper,
  invalid = false,
  className = "",
  inputClassName = "",
  "aria-describedby": describedBy,
  ...inputProps
}: SettingsTextFieldProps) {
  // `useId` rather than a counter: the pane renders on the server too, and a
  // counter would hand the client a different id and blow up hydration.
  const helperId = `${useId()}-helper`;
  // Caller's own `aria-describedby` is MERGED, never replaced — a field may
  // already point at a hint elsewhere in the section.
  const described =
    [describedBy, helper ? helperId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={`flex flex-col gap-[4px] ${className}`}>
      <div className="relative flex items-center gap-[8px] rounded-t-[4px] bg-[var(--set-surface-container-highest)] px-[16px]">
        {leading && (
          <span className="flex shrink-0 items-center text-[var(--set-on-surface-variant)]">
            {leading}
          </span>
        )}
        <input
          {...inputProps}
          aria-invalid={invalid || undefined}
          aria-describedby={described}
          className={`peer min-w-0 flex-1 border-none bg-transparent py-[12px] text-[14px] text-[var(--set-on-surface)] outline-none placeholder:text-[var(--set-on-surface-variant)] disabled:opacity-40 ${inputClassName}`}
        />
        {trailing && (
          <span className="flex shrink-0 items-center text-[var(--set-on-surface-variant)]">
            {trailing}
          </span>
        )}
        {/* resting indicator */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-px ${
            invalid ? "bg-[var(--set-error)]" : "bg-[var(--set-outline)]"
          }`}
        />
        {/* focus indicator — drawn over the resting one, never replacing it */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] opacity-0 transition-opacity peer-focus:opacity-100 ${
            invalid ? "bg-[var(--set-error)]" : "bg-[var(--set-primary)]"
          }`}
        />
      </div>
      {helper && (
        <span
          id={helperId}
          // Announced, not just reddened. `role="alert"` + polite is the shape
          // the pane's existing password-mismatch hint uses, so a field
          // migrated onto this primitive keeps its announcement instead of
          // degrading to a silent red line.
          role={invalid ? "alert" : undefined}
          aria-live={invalid ? "polite" : undefined}
          className={`px-[16px] text-[12px] ${
            invalid
              ? "text-[var(--set-error)]"
              : "text-[var(--set-on-surface-variant)]"
          }`}
        >
          {helper}
        </span>
      )}
    </div>
  );
}
