"use client";

export interface SettingsSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * The switch's accessible name. Required — a switch with no name is
   * unreachable for the e2e suite, which finds these by
   * `getByRole("switch", { name })` and has no `data-testid` to fall back on.
   */
  label: string;
  id?: string;
  className?: string;
}

/** Track 52×32, handle 24 selected / 16 unselected — the M3 metrics. */
const TRACK_W = 52;
const TRACK_H = 32;
const HIT = 44;

/**
 * The M3 switch, not a generic pill.
 *
 * The handle ANIMATES ITS SIZE — 16px off, 24px on. That size change is the
 * whole affordance: it is what makes the control read as "off" at a glance
 * rather than "on, but grey". Off takes the container-highest track with an
 * outline; on takes primary, because a switch commits an action.
 *
 * This is a NEW primitive, not a replacement for the four toggle dialects that
 * ship today. Those have coupled geometry and per-site behaviour; swapping one
 * for this is a per-section decision, not a sweep.
 */
export default function SettingsSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  id,
  className = "",
}: SettingsSwitchProps) {
  const handleSize = checked ? 24 : 16;
  const handleLeft = checked ? TRACK_W - 4 - 24 : 8;

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{ width: HIT, height: HIT }}
      className={`relative flex shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)] disabled:cursor-default disabled:opacity-40 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`relative block rounded-full transition-colors duration-200 ${
          checked
            ? "bg-[var(--set-primary)]"
            : "bg-[var(--set-surface-container-highest)]"
        }`}
        style={{
          width: TRACK_W,
          height: TRACK_H,
          boxShadow: checked ? "none" : "inset 0 0 0 2px var(--set-outline)",
        }}
      >
        {/* Positioned with `top`, not `translate`: nothing in the Settings pane
            may carry a transform, because a transform creates a containing
            block and the factory-reset / hostname-reboot overlays are
            `position: fixed` portals that get clipped by one. */}
        <span
          className={`absolute block rounded-full transition-all duration-200 ${
            checked ? "bg-[var(--set-on-primary)]" : "bg-[var(--set-outline)]"
          }`}
          style={{
            width: handleSize,
            height: handleSize,
            left: handleLeft,
            top: (TRACK_H - handleSize) / 2,
          }}
        />
      </span>
    </button>
  );
}
