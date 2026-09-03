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
 *  - The two QUIET states are quiet in the DOT, not in the word. They used to
 *    be `--text-muted`, and `unknown` dimmed that again to 70% — 3.56:1 and
 *    2.41:1 against the row, i.e. under AA for 11px text, on the two states a
 *    customer is most likely to be squinting at because something is wrong.
 *    The word is now `--text-secondary` (6.79:1 plain, 5.08:1 on a hovered
 *    row) and the dot alone carries "we are less sure about this one".
 *  - `checking` is the one state with MOTION, and it is the only thing that
 *    separates it from `unknown` at a glance: both are quiet and grey, and one
 *    of them is going to change on its own. Under `motion-safe:` — with the
 *    animation off it is still a ring rather than a filled dot, and the word
 *    still says so. Its word is `settings.checking`, the catalogue's existing
 *    "Checking…" in all ten locales, rather than a fifth `settings.providers.*`
 *    key saying the same thing in one.
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
    text: "text-[var(--text-secondary)]",
    labelKey: "settings.providers.notConnected",
  },
  unknown: {
    dot: "bg-[var(--text-muted)] opacity-30",
    text: "text-[var(--text-secondary)]",
    labelKey: "settings.providers.unknown",
  },
  checking: {
    // A ring with a gap rather than a filled dot, so the spin is visible.
    dot: "border border-[var(--text-muted)] border-t-transparent motion-safe:animate-spin",
    text: "text-[var(--text-secondary)]",
    labelKey: "settings.checking",
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
  // The spinning ring reads as a ring only with a little more room than a dot.
  const checking = state === "checking";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold leading-none ${style.text} ${className}`}
    >
      <span
        data-testid={checking ? "provider-state-spinner" : undefined}
        className={`inline-block rounded-[var(--r-full)] shrink-0 ${checking ? "w-[9px] h-[9px]" : "w-[7px] h-[7px]"} ${style.dot}`}
        aria-hidden="true"
      />
      {t(style.labelKey)}
    </span>
  );
}
