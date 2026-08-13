"use client";

import type { ReactNode } from "react";

interface SettingsRowBase {
  label: ReactNode;
  /** Supporting text under the label. Its presence is what makes the row 56px. */
  description?: ReactNode;
  /** Right-aligned secondary text — the current value of the setting. */
  value?: ReactNode;
  /** Control or affordance at the end of the row: switch, chevron, button. */
  trailing?: ReactNode;
  className?: string;
}

export interface SettingsRowProps extends SettingsRowBase {
  /** Supplying this makes the row a real `<button>`. */
  onClick?: () => void;
  disabled?: boolean;
  /**
   * Overrides the button's accessible name. OPT-IN ONLY — left unset (the
   * normal case) the row names itself from its content, which is what today's
   * markup does and what the e2e suite's substring locators match.
   */
  ariaLabel?: string;
}

/**
 * The row — Mobbin's rhythm on Material 3's metrics.
 *
 * 56px with a description (M3's two-line list item), 48px without. The old
 * pane painted interaction as ad-hoc `bg-white/[0.04]`; an overlay like that
 * ignores whatever palette is under it. A state layer is `on-surface` at 8%
 * (hover) / 12% (pressed) composited over the container, so it re-tints itself
 * for free when the Hermes block re-points `--set-on-surface`.
 *
 * An interactive row is a real `<button>`. Never a bare `<div onClick>`: the
 * e2e suite drives this file entirely by role plus visible text, so a clickable
 * div is invisible to it and to a keyboard.
 */
export default function SettingsRow({
  label,
  description,
  value,
  trailing,
  onClick,
  disabled = false,
  ariaLabel,
  className = "",
}: SettingsRowProps) {
  const minHeight = description ? 56 : 48;

  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] text-left">
        <span className="w-full text-[14px] font-normal leading-[1.3] text-[var(--set-on-surface)]">
          {label}
        </span>
        {description && (
          <span className="w-full text-[12px] font-normal leading-[1.4] text-[var(--set-on-surface-variant)]">
            {description}
          </span>
        )}
      </span>
      {value !== undefined && value !== null && (
        <span className="shrink-0 text-right text-[14px] font-normal text-[var(--set-on-surface-variant)]">
          {value}
        </span>
      )}
      {trailing}
    </>
  );

  const shared =
    "flex w-full items-center justify-between gap-[16px] px-[16px] py-[12px] text-left";

  if (!onClick) {
    return (
      <div className={`${shared} ${className}`} style={{ minHeight }}>
        {body}
      </div>
    );
  }

  // `aria-label` is applied ONLY when the caller asks for it. It used to be
  // synthesised from `label` whenever a `description` was present, and
  // `aria-label` overrides name-from-content — so a row rendered as
  // `label="Language" description="…" value="English"` announced "Language"
  // and silently dropped "English" from its name. That is a name REMOVAL, and
  // e2e drives this file by role + visible text with no data-testid to fall
  // back on (`getByRole("button", { name: /English/ })` reads the accessible
  // name, not the DOM text). Name-from-content already yields
  // "Language English", which is what today's hand-written markup produces.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ minHeight }}
      className={`${shared} cursor-pointer border-none bg-transparent transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
    >
      {body}
    </button>
  );
}
