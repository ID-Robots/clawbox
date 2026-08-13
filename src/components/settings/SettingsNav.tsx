"use client";

import type { ReactNode } from "react";

export interface SettingsNavItem {
  id: string;
  /** Material Symbols ligature name. */
  icon: string;
  label: ReactNode;
  /** Visually hidden text that stays part of the accessible name (rail). */
  srOnly?: ReactNode;
  /** Visible supporting line under the label (list). */
  subtitle?: ReactNode;
}

export interface SettingsNavProps {
  items: SettingsNavItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  /** `rail` is the desktop sidebar; `list` is the mobile grouped list. */
  variant?: "rail" | "list";
  className?: string;
}

/**
 * The section nav, in both trees.
 *
 * The eight items, their order and their labels are frozen — this component
 * only changes how they look.
 *
 * The active item used to be a coral-tinted pill with a coral icon. In M3 a
 * selected navigation item takes SECONDARY-CONTAINER, never the primary
 * accent, because primary is reserved for actions. That is not pedantry here:
 * the product invariant is "coral means ACTION, cyan means DONE", and a coral
 * nav pill spends the action colour on wayfinding. The glyph stays; the coral
 * fill goes.
 *
 * Icons are deliberately not `aria-hidden`. Material Symbols draws from a
 * ligature, so the span's text is the glyph name and today's nav already puts
 * it in the accessible name; the e2e suite matches these buttons by name with
 * no `data-testid` to fall back on, so quietly improving the name is a risk
 * with no compile-time signal.
 */
export default function SettingsNav({
  items,
  activeId,
  onSelect,
  variant = "rail",
  className = "",
}: SettingsNavProps) {
  if (variant === "list") {
    return (
      <nav
        className={`overflow-hidden rounded-[16px] bg-[var(--set-surface-container)] py-[4px] ${className}`}
      >
        {items.map((item, i) => (
          <div key={item.id}>
            {i > 0 && (
              <div
                aria-hidden="true"
                className="ml-[16px] h-px bg-[var(--set-outline-variant)]"
              />
            )}
            <button
              onClick={() => onSelect(item.id)}
              className="flex w-full cursor-pointer items-center gap-[16px] border-none bg-transparent px-[16px] py-[12px] text-left transition-colors hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)]"
              style={{ minHeight: item.subtitle ? 56 : 48 }}
            >
              <span
                className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]"
                style={{ fontSize: 24 }}
              >
                {item.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate text-[14px] font-normal leading-[1.3] text-[var(--set-on-surface)]">
                  {item.label}
                </span>
                {item.subtitle && (
                  <span className="truncate text-[12px] font-normal leading-[1.4] text-[var(--set-on-surface-variant)]">
                    {item.subtitle}
                  </span>
                )}
              </span>
              <span
                className="material-symbols-rounded shrink-0 text-[var(--set-on-surface-variant)]"
                style={{ fontSize: 20 }}
              >
                chevron_right
              </span>
            </button>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav className={`flex flex-col gap-[2px] ${className}`}>
      {items.map((item) => {
        const active = activeId === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-current={active ? "page" : undefined}
            style={{ height: 44 }}
            className={`flex w-full cursor-pointer items-center gap-[12px] rounded-[12px] border-none px-[12px] text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--set-primary)] ${
              active
                ? "bg-[var(--set-secondary-container)] text-[var(--set-on-secondary-container)]"
                : "bg-transparent text-[var(--set-on-surface-variant)] hover:bg-[var(--set-state-hover)] active:bg-[var(--set-state-pressed)]"
            }`}
          >
            <span
              className="material-symbols-rounded shrink-0"
              style={{
                fontSize: 20,
                color: active
                  ? "var(--set-on-secondary-container)"
                  : "var(--set-on-surface-variant)",
              }}
            >
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
              {item.label}
            </span>
            {item.srOnly && <span className="sr-only">{item.srOnly}</span>}
          </button>
        );
      })}
    </nav>
  );
}
