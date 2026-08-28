"use client";

import type { ReactNode } from "react";
import ProviderRadioRow from "./ProviderRadioRow";
import { useT } from "@/lib/i18n";
import { CLAWBOX_AI_DESCRIPTION } from "@/lib/clawbox-ai-tiers";

// The ClawBox AI radio row, shared by the OpenClaw wizard (AIModelsStep) and the
// Hermes provider panel (HermesProviderConfig).
//
// It is now the generic row (ProviderRadioRow) with ClawBox AI's own name,
// description and "Recommended" pill poured into it, rather than a second copy
// of the row markup. It used to be the OpenClaw row moved verbatim — which was
// right at the time and went stale the moment the OpenClaw row was moved onto
// the design tokens without it, leaving the one row shared by both editions as
// the only one still painted in hand-typed greys.

interface ClawboxAiProviderRowProps {
  /** Radio group name — "ai-provider" (OpenClaw) or "hermes-ai-provider". */
  radioName: string;
  selected: boolean;
  onSelect: () => void;
  /** Extra badge rendered after "Recommended". Hermes passes an "Active" pill;
   *  OpenClaw passes nothing, so React emits nothing and the DOM matches. */
  trailingBadge?: ReactNode;
  /** Connection state, rendered hard right. Both editions' AI Providers
   *  sections pass one; the wizard does not. */
  statusSlot?: ReactNode;
  /** True when this is the box's DEFAULT provider — see ProviderRadioRow for
   *  why that outranks the selection wash. */
  isDefault?: boolean;
}

export default function ClawboxAiProviderRow({
  radioName,
  selected,
  onSelect,
  trailingBadge,
  statusSlot,
  isDefault = false,
}: ClawboxAiProviderRowProps) {
  const { t } = useT();
  return (
    <ProviderRadioRow
      radioName={radioName}
      value="clawai"
      selected={selected}
      onSelect={onSelect}
      isDefault={isDefault}
      name="ClawBox AI"
      description={CLAWBOX_AI_DESCRIPTION}
      statusSlot={statusSlot}
      badges={
        <>
          <span className="px-1.5 py-0.5 text-[length:var(--t-1)] font-bold uppercase tracking-[0.06em] rounded-[var(--r-1)] bg-[var(--coral-tint)] text-[var(--coral-bright)] leading-none">
            {t("recommended")}
          </span>
          {trailingBadge}
        </>
      }
    />
  );
}
