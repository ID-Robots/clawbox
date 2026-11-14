"use client";

import { memo, useEffect } from "react";
import { useT } from "@/lib/i18n";
import { INDICATOR_MS, type BoxSwitcherIndicator as Indicator } from "@/lib/use-box-switcher";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

/**
 * The workspace-style indicator of the linked-box switcher (use-box-switcher.ts):
 * a row of numbered dots, one per box, the one asked for lit, and what the
 * key press did in words — "2 · Laptop", "Opening Laptop…", or why it did
 * nothing. At the top of the screen, under the kiosk bar where there is one;
 * it takes no pointer and no focus, and goes on its own. A switch that leaves
 * the page keeps it up until the page goes.
 */
function BoxSwitcherIndicatorView({ indicator, top, onDone }: { indicator: Indicator | null; top: number; onDone: () => void }) {
  const { t } = useT();
  const id = indicator?.id;
  const leaving = indicator?.kind === "go";
  useEffect(() => {
    if (id === undefined || leaving) return;
    const timer = setTimeout(onDone, INDICATOR_MS);
    return () => clearTimeout(timer);
  }, [id, leaving, onDone]);
  if (!indicator) return null;

  const count = Math.max(indicator.workspaces.length, indicator.slot);
  const name = indicator.name ?? "";
  const text =
    indicator.kind === "go" ? t("desktop.boxSwitcher.opening", { name })
    : indicator.kind === "empty" ? t("desktop.boxSwitcher.empty", { n: indicator.slot })
    : indicator.kind === "unlinked" ? t("desktop.boxSwitcher.unlinked", { name })
    // The number and the name, the same in every language.
    : `${indicator.slot} · ${name}`;

  return (
    <div
      key={indicator.id}
      className="pointer-events-none fixed left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 rounded-2xl bg-[rgba(17,24,39,0.92)] border border-white/10 shadow-2xl px-5 py-3 animate-in fade-in zoom-in-95 duration-150"
      style={{ top: top + 24, zIndex: DESKTOP_LAYERS.menu, maxWidth: "min(92vw, 520px)" }}
      role="status"
      aria-live="polite"
      aria-label={t("desktop.boxSwitcher.aria")}
      data-testid="box-switcher-indicator"
      data-slot={indicator.slot}
      data-kind={indicator.kind}
    >
      <div className="flex items-center gap-2" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => {
          const slot = i + 1;
          const lit = slot === indicator.slot;
          const known = indicator.workspaces.some((w) => w.slot === slot);
          return (
            <span
              key={slot}
              data-testid={`box-switcher-dot-${slot}`}
              data-lit={lit ? "true" : undefined}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors ${
                lit
                  ? "bg-[var(--coral-bright)] text-white"
                  : known
                    ? "bg-white/10 text-white/70"
                    : "border border-dashed border-white/25 text-white/40"
              }`}
            >
              {slot}
            </span>
          );
        })}
      </div>
      <div className="flex items-start gap-1.5 text-sm text-white max-w-full">
        <span className="material-symbols-rounded shrink-0 text-white/70" style={{ fontSize: 18, lineHeight: "20px" }} aria-hidden="true">
          {indicator.kind === "empty" || indicator.kind === "unlinked" ? "info" : "workspaces"}
        </span>
        {/* Wrapped, never cut: the empty-slot sentence is longer than one line. */}
        <span className="min-w-0 break-words leading-5" data-testid="box-switcher-text">{text}</span>
      </div>
    </div>
  );
}

export default memo(BoxSwitcherIndicatorView);
