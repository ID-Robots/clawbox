"use client";

import type { ReactNode } from "react";
import AIProviderIcon from "./AIProviderIcon";
import { useT } from "@/lib/i18n";
import { CLAWBOX_AI_DESCRIPTION } from "@/lib/clawbox-ai-tiers";

// The ClawBox AI radio row, shared by the OpenClaw wizard (AIModelsStep) and the
// Hermes provider panel (HermesProviderConfig). Markup is the OpenClaw row,
// moved verbatim: same label/radio/dot/crab-tile/badge structure and the same
// class strings, so the OpenClaw DOM is unchanged and the Hermes panel gains the
// full experience instead of the minimal row it used to draw.

interface ClawboxAiProviderRowProps {
  /** Radio group name — "ai-provider" (OpenClaw) or "hermes-ai-provider". */
  radioName: string;
  selected: boolean;
  onSelect: () => void;
  /** Extra badge rendered after "Recommended". Hermes passes an "Active" pill;
   *  OpenClaw passes nothing, so React emits nothing and the DOM matches. */
  trailingBadge?: ReactNode;
  /** Connection state, rendered hard right. Hermes' AI Providers section passes
   *  one; OpenClaw passes nothing and the DOM is unchanged. */
  statusSlot?: ReactNode;
  /** True when this is the box's DEFAULT provider. Tints the row cyan, which
   *  outranks the coral selection wash: the two are usually the same row, and
   *  when they are not, "what is running" is the more useful of the two to
   *  spot. OpenClaw never passes it. */
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
    <label
      className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] has-[:focus-visible]:ring-inset ${
        isDefault
          ? "bg-[var(--cyan-veil)]"
          : selected
            ? "bg-orange-500/5"
            : "hover:bg-[var(--surface-card)]"
      }`}
    >
      <input
        type="radio"
        name={radioName}
        value="clawai"
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
          selected
            ? "border-[var(--coral-bright)]"
            : "border-gray-600"
        }`}
      >
        {selected && (
          <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
        )}
      </span>
      <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] shrink-0">
        <AIProviderIcon provider="clawai" size={22} />
      </span>
      <div className="flex-1 min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-200">
          ClawBox AI
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-orange-500/15 text-orange-400 leading-none">
            {t("recommended")}
          </span>
          {trailingBadge}
        </span>
        <span className="block text-xs text-[var(--text-muted)]">
          {CLAWBOX_AI_DESCRIPTION}
        </span>
      </div>
      {statusSlot}
    </label>
  );
}
