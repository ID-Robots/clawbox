"use client";

import AIProviderIcon from "./AIProviderIcon";
import ProviderConnectionLabel from "./ProviderConnectionLabel";
import { useT } from "@/lib/i18n";
import type { ProviderStatusRow } from "@/lib/provider-status";

/**
 * The spotlight at the top of the AI Providers section: what is answering
 * RIGHT NOW.
 *
 * The list below it can tell you which row is ticked, but not what that choice
 * actually resolves to — the model id is the half of the answer a customer
 * comes to this page for ("which brain is my box using?") and it was previously
 * only reachable by selecting the provider and reading a dropdown. So the hero
 * states all three facts in one line of sight: vendor, model, connection.
 *
 * It is deliberately NOT a control. The one action it carries is "Change
 * model", which scrolls the customer to the picker they already know rather
 * than growing a second model UI up here.
 */
interface ProviderDefaultHeroProps {
  /** The provider the harness config actually names as its default. */
  row: ProviderStatusRow;
  /** The model that default resolves to, or "" while it is still unknown. */
  model: string;
  /**
   * Opens the model-selection UI for this provider. Omitted when the default is
   * a provider this panel has no row for (one configured through Hermes' own
   * dashboard) — an action that cannot land anywhere is worse than no action.
   */
  onChangeModel?: () => void;
  /**
   * A short trailing clause after the model id, for a panel that has something
   * edition-specific to say about how switching works (Hermes does; OpenClaw
   * does not). It is a PROP rather than a `t()` call in here because the copy
   * is the one part of this card that is not shared — baking Hermes' sentence
   * into a component both editions render is how a shared card becomes a
   * Hermes card again.
   */
  note?: string;
}

export default function ProviderDefaultHero({
  row,
  model,
  onChangeModel,
  note,
}: ProviderDefaultHeroProps) {
  const { t } = useT();

  return (
    /* Stacked in a narrow pane, one line in a wide one. The vendor name and
       the model id both truncated behind a "Change model" button that never
       shrinks, so the card that exists to say WHICH BRAIN IS ANSWERING said
       "Anthropic Cla…" and half a model id.
       The query is the CONTAINER's, not the viewport's: this card is drawn in
       a `max-w-xl` pane inside a window the owner can drag to 300 px, so a
       viewport breakpoint answers "wide" for a card that is not. The wrapper
       exists because an element cannot query the container it declares. */
    <div className="@container mb-4">
      <div
        data-testid="provider-default-hero"
        className="flex flex-col @md:flex-row @md:items-center gap-3 @md:gap-4 p-[18px] rounded-[var(--r-2)] border border-[var(--cyan-rim)] bg-[linear-gradient(135deg,var(--cyan-mist),var(--bg-deep-veil))]"
      >
        <div className="flex items-center gap-4 min-w-0 @md:flex-1">
          <span
            aria-hidden="true"
            className="flex items-center justify-center w-11 h-11 rounded-[var(--r-1)] bg-[var(--fill-2)] shrink-0"
          >
            <AIProviderIcon provider={row.id} size={26} />
          </span>

          <div className="flex flex-col gap-[3px] flex-1 min-w-0">
            <span className="flex flex-wrap @md:flex-nowrap items-center gap-2 text-base font-bold text-[var(--text-primary)]">
              <span className="break-words @md:truncate" data-testid="provider-default-hero-name">{row.label}</span>
              <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded-[var(--r-1)] bg-[var(--fill-2)] text-[9px] font-bold uppercase tracking-[0.08em] leading-[1.6] text-[var(--text-primary)]">
                <span
                  className="material-symbols-rounded"
                  style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}
                  aria-hidden="true"
                >
                  star
                </span>
                {t("settings.providers.default")}
              </span>
            </span>

            {(model || note) && (
              /* `break-words` because a model id is one long hyphenated token:
                 with the ellipsis gone below `sm:` it would otherwise push the
                 card wider than the phone. */
              <span className="text-xs text-[var(--text-secondary)] break-words @md:truncate" data-testid="provider-default-hero-model">
                {model ? <span className="font-mono">{model}</span> : null}
                {model && note ? " · " : null}
                {note}
              </span>
            )}

            <ProviderConnectionLabel state={row.state} className="mt-[2px]" />
          </div>
        </div>

        {onChangeModel && (
          <button
            type="button"
            onClick={onChangeModel}
            className="shrink-0 self-start @md:self-auto whitespace-nowrap bg-transparent border-none p-0 text-xs font-semibold text-[var(--coral-bright)] cursor-pointer hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)] rounded-[var(--r-1)]"
          >
            {t("settings.providers.changeModel")}
          </button>
        )}
      </div>
    </div>
  );
}
