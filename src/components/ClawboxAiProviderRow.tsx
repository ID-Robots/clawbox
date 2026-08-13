"use client";

import type { ReactNode } from "react";
import AIProviderIcon from "./AIProviderIcon";
import { useT } from "@/lib/i18n";
import { CLAWBOX_AI_DESCRIPTION } from "@/lib/clawbox-ai-tiers";

// The ClawBox AI radio row, shared by the OpenClaw wizard (AIModelsStep) and the
// Hermes provider panel (HermesProviderConfig). Markup is the OpenClaw row,
// moved verbatim: same label/radio/dot/crab-tile/badge structure, so the Hermes
// panel gains the full experience instead of the minimal row it used to draw.
//
// Colour comes ONLY from the `--set-*` roles. This row renders in two places
// that do not share an ancestor — inside `.settings-pane` and inside
// `.setup-shell` — and the role layer in globals.css is declared on `:root`,
// `.settings-pane` and `.setup-shell` precisely so one class string paints
// correctly in both, under both editions, with no fallback chain here.

interface ClawboxAiProviderRowProps {
  /** Radio group name — "ai-provider" (OpenClaw) or "hermes-ai-provider". */
  radioName: string;
  selected: boolean;
  onSelect: () => void;
  /** Extra badge rendered after "Recommended". Hermes passes an "Active" pill;
   *  OpenClaw passes nothing, so React emits nothing and the DOM matches. */
  trailingBadge?: ReactNode;
}

export default function ClawboxAiProviderRow({
  radioName,
  selected,
  onSelect,
  trailingBadge,
}: ClawboxAiProviderRowProps) {
  const { t } = useT();
  return (
    <label
      className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-[var(--set-outline-variant)] last:border-b-0 transition-colors cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--set-primary)] has-[:focus-visible]:ring-inset ${
        selected
          ? "bg-[color-mix(in_srgb,var(--set-primary)_8%,transparent)]"
          : "hover:bg-[var(--set-state-hover)]"
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
            ? "border-[var(--set-primary)]"
            : "border-[var(--set-outline)]"
        }`}
      >
        {selected && (
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--set-primary)]" />
        )}
      </span>
      {/* A filled control plate, not a `bg-white/[0.0x]` overlay: an overlay
          ignores the palette under it, `container-highest` inherits it. */}
      <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--set-surface-container-highest)] shrink-0">
        <AIProviderIcon provider="clawai" size={22} />
      </span>
      <div className="flex-1">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--set-on-surface)]">
          ClawBox AI
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-[color-mix(in_srgb,var(--set-primary)_15%,transparent)] text-[var(--set-primary)] leading-none">
            {t("recommended")}
          </span>
          {trailingBadge}
        </span>
        <span className="block text-xs text-[var(--set-on-surface-variant)]">
          {CLAWBOX_AI_DESCRIPTION}
        </span>
      </div>
    </label>
  );
}
