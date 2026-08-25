"use client";

import { useT } from "@/lib/i18n";
import type { ProviderConnectionState } from "@/lib/provider-status";

/**
 * One provider's connection state, as a dot AND a word.
 *
 * Used twice in the AI Providers section — on the right of every row in the
 * picker, and under the provider's name in the hero card — so the two can never
 * disagree about what a state looks like or what it is called.
 *
 * DESIGN NOTES, each load-bearing rather than taste (carried over from the
 * connection strip this section absorbed):
 *
 *  - Every state carries a WORD, not just a dot. Two of the four states differ
 *    only in hue otherwise, and roughly one man in twelve cannot separate the
 *    two hues that would carry them.
 *  - The state colours are cyan (verified) and amber (needs attention), never
 *    coral. Coral is this product's ACTION colour on every surface; a status
 *    painted in it reads as a button.
 */
const STATE_STYLES: Record<
  ProviderConnectionState,
  { dot: string; text: string; labelKey: string }
> = {
  connected: {
    dot: "bg-[var(--cyan-bright)]",
    text: "text-[var(--cyan-bright)]",
    labelKey: "settings.providers.connected",
  },
  "needs-reauth": {
    dot: "bg-[var(--amber-ink)]",
    text: "text-[var(--amber-ink)]",
    labelKey: "settings.providers.needsReauth",
  },
  disconnected: {
    dot: "bg-[var(--text-muted)] opacity-60",
    text: "text-[var(--text-muted)]",
    labelKey: "settings.providers.notConnected",
  },
  unknown: {
    dot: "bg-[var(--text-muted)] opacity-30",
    text: "text-[var(--text-muted)] opacity-70",
    labelKey: "settings.providers.unknown",
  },
};

interface ProviderConnectionLabelProps {
  state: ProviderConnectionState;
  className?: string;
}

export default function ProviderConnectionLabel({
  state,
  className = "",
}: ProviderConnectionLabelProps) {
  const { t } = useT();
  const style = STATE_STYLES[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold leading-none ${style.text} ${className}`}
    >
      <span
        className={`inline-block w-[7px] h-[7px] rounded-[var(--r-full)] shrink-0 ${style.dot}`}
        aria-hidden="true"
      />
      {t(style.labelKey)}
    </span>
  );
}
