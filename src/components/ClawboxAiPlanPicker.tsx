"use client";

import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_ORDER,
  type ClawaiTier,
} from "@/lib/clawbox-ai-tiers";

// The ClawBox AI tier selector + plan card, shared by the OpenClaw wizard and
// the Hermes provider panel. Moved verbatim out of AIModelsStep; it returns a
// Fragment (no wrapper element) so the OpenClaw panel's DOM is node-for-node
// what it was, and the Hermes panel gains the same pricing/feature card instead
// of a bare "Use ClawBox AI" button.

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
  const info = CLAWAI_TIER_INFO[tier];
  return (
    <>
      <p className="text-xs leading-relaxed text-orange-200/90">
        Max plan unlocks ClawKeep cloud backups, Remote Desktop, and extended warranty for ClawBox owners.
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Tier
        </span>
        <div role="radiogroup" aria-label="ClawBox AI tier" className="relative inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-0.5">
          {CLAWAI_TIER_ORDER.map((option) => {
            const optionInfo = CLAWAI_TIER_INFO[option];
            const isActive = tier === option;
            const showPickerTrial = optionInfo.hasTrial;
            const ariaLabel = showPickerTrial ? `${optionInfo.pillLabel} tier, Trial` : `${optionInfo.pillLabel} tier`;
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
                    Trial
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
              {info.planName}
            </span>
            <span className="text-xs font-semibold text-[var(--text-secondary)]">
              €{info.priceEuro}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{info.pricePeriod}</span>
          </div>
          {info.hasTrial && (
            <a
              href={`${PORTAL_LOGIN_URL}/dashboard`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)] hover:from-fuchsia-400 hover:to-pink-400 transition-colors whitespace-nowrap"
            >
              Start 30-day free trial
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
            </a>
          )}
        </div>
        <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]">
          {info.features.map((feature) => (
            <li key={feature} className="flex items-start gap-1.5">
              <span
                aria-hidden="true"
                className={`material-symbols-rounded shrink-0 ${info.cardCheckClass}`}
                style={{ fontSize: 12, marginTop: 2 }}
              >
                check_circle
              </span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
