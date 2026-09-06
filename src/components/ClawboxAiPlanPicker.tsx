"use client";

import { useCallback, useState } from "react";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import { useT } from "@/lib/i18n";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_ORDER,
  type ClawaiTier,
} from "@/lib/clawbox-ai-tiers";

// The ClawBox AI tier selector + plan card, shared by the OpenClaw wizard and
// the Hermes provider panel — one component, so the two can never drift. It
// opens as a one-line summary of the plan and its price and returns the tiers,
// the pitch and the feature list as a Fragment (no wrapper element) once
// opened, so the expanded DOM is node-for-node what both panels rendered
// before the disclosure landed.

interface ClawboxAiPlanPickerProps {
  tier: ClawaiTier;
  onTierChange: (tier: ClawaiTier) => void;
  /** OpenClaw omits this, so `disabled={undefined}` emits no attribute. */
  disabled?: boolean;
}

export default function ClawboxAiPlanPicker({
  tier,
  onTierChange,
  disabled,
}: ClawboxAiPlanPickerProps) {
  const { t } = useT();
  // Every word on this card used to be an English literal, so a German or
  // Japanese box read its plan, its price period and its six feature bullets
  // in English. English is the floor rather than the value: `t()` answers with
  // the raw key when a locale pack has not reached it, and "ai.planNameMax" on
  // the price line would be worse than the sentence it replaced.
  const tr = useCallback((key: string, english: string) => {
    const value = t(key);
    return value === key ? english : value;
  }, [t]);
  const info = CLAWAI_TIER_INFO[tier];
  // Presentational only — no state the connect flow reads is gated on it.
  // A plan is always selected (the picker has no empty value and nothing
  // validates it), so this can never be the hidden reason an action is
  // unavailable. What it must never hide is the price: the summary states the
  // plan and what it costs, so a paid default is on screen before anyone
  // presses Connect, and one tap opens the tiers and what each includes.
  const [open, setOpen] = useState(false);
  // "/month" is a suffix, "free forever" is a phrase — the two join the price
  // differently, and a free plan should not read "€0".
  const pricePeriod = tr(info.pricePeriodKey, info.pricePeriod);
  const planName = tr(info.planNameKey, info.planName);
  const priceLabel =
    info.priceEuro === 0 ? pricePeriod : `€${info.priceEuro}${pricePeriod}`;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-expanded={false}
        aria-controls="clawai-plan-panel"
        className="flex w-full min-h-[44px] items-center justify-between gap-3 px-4 py-2 bg-[var(--fill-1)] border border-[var(--hair-2)] rounded-[var(--r-1)] text-left cursor-pointer hover:bg-[var(--fill-2)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)]">
            {tr("ai.plan", "Plan")}
          </span>
          <span className="truncate text-[length:var(--t-4)] text-[var(--text-primary)]">
            {planName} · {priceLabel}
          </span>
        </span>
        <span className="shrink-0 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)]">
          {tr("ai.planChange", "Change")}
        </span>
      </button>
    );
  }

  return (
    <>
      <p id="clawai-plan-panel" className="text-xs leading-relaxed text-orange-200/90">
        {tr(
          "ai.planBlurb",
          "Max plan unlocks ClawKeep cloud backups, Remote Desktop, and extended warranty for ClawBox owners.",
        )}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {tr("ai.planTier", "Tier")}
        </span>
        <div role="radiogroup" aria-label={tr("ai.planTierGroup", "ClawBox AI tier")} className="relative inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-0.5">
          {CLAWAI_TIER_ORDER.map((option) => {
            const optionInfo = CLAWAI_TIER_INFO[option];
            const isActive = tier === option;
            const showPickerTrial = optionInfo.hasTrial;
            // The pill label is a product name (Free/Pro/Max) and stays put;
            // the word around it is what a screen reader has to say in the
            // owner's language.
            const ariaLabel = showPickerTrial
              ? tr("ai.planTierOptionTrial", `${optionInfo.pillLabel} tier, Trial`)
                  .replace("{tier}", optionInfo.pillLabel)
              : tr("ai.planTierOption", `${optionInfo.pillLabel} tier`)
                  .replace("{tier}", optionInfo.pillLabel);
            return (
              <button
                type="button"
                role="radio"
                aria-checked={isActive}
                aria-label={ariaLabel}
                key={option}
                disabled={disabled}
                onClick={() => onTierChange(option)}
                className={`relative px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer border-none disabled:opacity-50 ${
                  isActive
                    ? optionInfo.pillActiveClass
                    : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {optionInfo.pillLabel}
                {showPickerTrial && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_2px_8px_rgba(217,70,239,0.45)] whitespace-nowrap leading-none"
                  >
                    {tr("ai.planTrial", "Trial")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {/* Plan-tier card mirrors the portal's Subscription Plans block:
          same name/price/feature data so the in-Settings preview and
          the portal billing page never disagree. */}
      <div className={`mt-3 rounded-lg border px-3.5 py-3 ${info.cardClass}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-sm font-bold ${info.cardHeadlineClass}`}>
              {planName}
            </span>
            <span className="text-xs font-semibold text-[var(--text-secondary)]">
              €{info.priceEuro}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{pricePeriod}</span>
          </div>
          {info.hasTrial && (
            <a
              href={`${PORTAL_LOGIN_URL}/dashboard`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)] hover:from-fuchsia-400 hover:to-pink-400 transition-colors whitespace-nowrap"
            >
              {tr("ai.planStartTrial", "Start 30-day free trial")}
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
            </a>
          )}
        </div>
        <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]">
          {info.features.map((english, i) => (
            <li key={info.featureKeys[i]} className="flex items-start gap-1.5">
              <span
                aria-hidden="true"
                className={`material-symbols-rounded shrink-0 ${info.cardCheckClass}`}
                style={{ fontSize: 12, marginTop: 2 }}
              >
                check_circle
              </span>
              <span>{tr(info.featureKeys[i], english)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
