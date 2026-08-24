"use client";

import AIProviderIcon from "./AIProviderIcon";
import { useT } from "@/lib/i18n";
import { useProviderStatus } from "@/hooks/useProviderStatus";
import type { ProviderConnectionState, ProviderStatusRow } from "@/lib/provider-status";

/**
 * The connection overview: every provider's state, readable without clicking.
 *
 * The panel below this one answers "is X connected?" only after you have
 * selected X, so learning what the box was set up with cost one click per
 * vendor — and the four key-only providers never answered at all. This strip is
 * the whole answer at a glance, and it is the only place the default provider
 * is marked.
 *
 * DESIGN NOTES, because each is load-bearing rather than taste:
 *
 *  - Every state carries a WORD, not just a dot. Two of the four states differ
 *    only in hue otherwise, and roughly one man in twelve cannot separate the
 *    two hues that would carry them.
 *  - The state colours are cyan (verified) and amber (needs attention), never
 *    coral. Coral is this product's ACTION colour on every surface; a status
 *    painted in it reads as a button.
 *  - The default marker is deliberately NOT a fifth hue. It is a filled star and
 *    the word "Default" in the ordinary text colour, so the strip has exactly
 *    two colours competing for attention and both of them mean something is
 *    wrong or right.
 */

interface ProviderStatusStripProps {
  /** Open this provider's configuration. */
  onOpenProvider: (row: ProviderStatusRow) => void;
}

/** Tailwind for each state: chip shell, dot, and the word. */
const STATE_STYLES: Record<
  ProviderConnectionState,
  { chip: string; dot: string; text: string; labelKey: string }
> = {
  connected: {
    chip: "border-[var(--cyan-edge)] bg-[var(--cyan-wash)] hover:border-[var(--cyan-bright)]",
    dot: "bg-[var(--cyan-bright)]",
    text: "text-[var(--cyan-bright)]",
    labelKey: "settings.providers.connected",
  },
  "needs-reauth": {
    chip: "border-[var(--amber-edge)] bg-[var(--amber-wash)] hover:border-[var(--amber-ink)]",
    dot: "bg-[var(--amber-ink)]",
    text: "text-[var(--amber-ink)]",
    labelKey: "settings.providers.needsReauth",
  },
  disconnected: {
    chip: "border-[var(--hair)] bg-white/[0.02] hover:border-[var(--hair-2)]",
    dot: "bg-[var(--text-muted)] opacity-50",
    text: "text-[var(--text-muted)]",
    labelKey: "settings.providers.notConnected",
  },
  unknown: {
    chip: "border-dashed border-[var(--hair)] bg-transparent hover:border-[var(--hair-2)]",
    dot: "bg-[var(--text-muted)] opacity-30",
    text: "text-[var(--text-muted)] opacity-70",
    labelKey: "settings.providers.unknown",
  },
};

export default function ProviderStatusStrip({ onOpenProvider }: ProviderStatusStripProps) {
  const { t } = useT();
  const { summary, loading, error, settingDefault, defaultError, setDefault } = useProviderStatus();

  return (
    <div
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
      data-testid="provider-status-strip"
    >
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>
          hub
        </span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.providers.title")}
        </label>
      </div>

      {loading ? (
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[38px] w-32 rounded-[var(--r-full)] bg-white/[0.05] animate-pulse" />
          ))}
        </div>
      ) : summary && summary.providers.length > 0 ? (
        <ul
          className="flex flex-wrap gap-2 list-none p-0 m-0"
          // A list, so a screen reader announces how many providers there are
          // before reading them out — the same "at a glance" the sighted
          // version gets from the strip being one row.
          aria-label={t("settings.providers.title")}
        >
          {summary.providers.map((row) => {
            const style = STATE_STYLES[row.state];
            const stateLabel = t(style.labelKey);
            const busy = settingDefault === row.id;
            // Offered only where it would do something: a provider with no
            // credential cannot be made the default, and the one that already
            // is has nothing to change.
            const canMakeDefault = row.state === "connected" && !row.isDefault;
            return (
              <li
                key={row.id}
                className={`flex items-center gap-2 rounded-[var(--r-full)] border pl-2.5 pr-1.5 py-1 transition-colors ${style.chip}`}
              >
                <button
                  type="button"
                  onClick={() => onOpenProvider(row)}
                  className="flex items-center gap-2 text-left rounded-[var(--r-full)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]"
                  aria-label={t("settings.providers.openConfig", { provider: row.label })}
                >
                  <AIProviderIcon provider={row.id} size={16} />
                  <span className="flex flex-col leading-tight">
                    <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-primary)]">
                      {row.label}
                      {row.isDefault && (
                        <span
                          className="inline-flex items-center gap-0.5 ml-0.5 px-1.5 py-px rounded-[var(--r-full)] bg-white/[0.10] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-primary)]"
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }} aria-hidden="true">
                            star
                          </span>
                          {t("settings.providers.default")}
                        </span>
                      )}
                    </span>
                    <span className={`flex items-center gap-1 text-[10px] ${style.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} aria-hidden="true" />
                      {stateLabel}
                    </span>
                  </span>
                </button>

                {canMakeDefault ? (
                  <button
                    type="button"
                    onClick={() => void setDefault(row.id)}
                    disabled={busy}
                    title={t("settings.providers.makeDefault")}
                    aria-label={t("settings.providers.makeDefaultOf", { provider: row.label })}
                    className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.08] disabled:opacity-40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)]"
                  >
                    <span
                      className={`material-symbols-rounded ${busy ? "animate-pulse" : ""}`}
                      style={{ fontSize: 14 }}
                      aria-hidden="true"
                    >
                      star
                    </span>
                  </button>
                ) : (
                  // Keeps every chip the same height whether or not it carries
                  // the button, so the row does not comb up and down.
                  <span className="shrink-0 w-6 h-6" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-xs text-[var(--text-muted)]">
          {error ? t("settings.providers.loadFailed") : t("settings.providers.empty")}
        </div>
      )}

      {summary?.degraded && (
        <p className="mt-3 text-[11px] text-[var(--amber-ink)] opacity-80">
          {t("settings.providers.degraded")}
        </p>
      )}
      {defaultError && (
        <output
          aria-live="polite"
          className="mt-3 block rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {t("settings.providers.defaultFailed", { message: defaultError })}
        </output>
      )}
    </div>
  );
}
