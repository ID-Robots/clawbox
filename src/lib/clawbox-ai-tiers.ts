import type { ClawboxAiTier } from "@/lib/clawbox-ai-models";

/**
 * ClawBox AI subscription-tier presentation data.
 *
 * Extracted out of AIModelsStep so the OpenClaw wizard and the Hermes provider
 * panel render the SAME card from the SAME data — the two panels drifted
 * before (Hermes showed a bare one-line row), and a shared module is the only
 * thing that stops it happening again. Pure data, no JSX, no "use client": the
 * Hermes clawai route needs `uiTierToDeviceTier` server-side and a route may
 * not import a client component.
 */

export type ClawaiTier = "free" | "flash" | "pro";

export const CLAWAI_TIER_STORAGE_KEY = "clawbox:ai-models:clawai-tier";

export interface ClawaiTierInfo {
  /** Plan label rendered to the user (Free/Pro/Max). Internal "flash" is
   *  marketed as "Pro" and internal "pro" is "Max" — preserved for
   *  backwards-compat with stored localStorage values + portal handshake.
   *  Keep in lockstep with CLAWBOX_AI_TIER_LABEL in clawbox-ai-models.ts. */
  planName: string;
  /** Selector pill label — same as planName today, kept separate so the
   *  pill can shorten if needed without touching the card. */
  pillLabel: string;
  priceEuro: number;
  /** Subtitle on the price line — "free forever", "/month", etc. */
  pricePeriod: string;
  /** True for tiers that should advertise a 30-day free trial CTA. */
  hasTrial: boolean;
  /** Bullet copy shown in the highlight card. */
  features: string[];
  /* ── The same three, as translation keys ──
   *
   * This module cannot call `t()`: it is imported by a route (see the header)
   * and by the Hermes panel, so it stays pure data. The English above is the
   * FLOOR the picker falls back to when a locale pack has not reached a key —
   * `t()` answers with the raw key when it is missing, and "ai.planNameMax" on
   * the price line would be worse than "Max plan". `featureKeys` is index-for-
   * index with `features`; the copy test pins that.
   */
  planNameKey: string;
  pricePeriodKey: string;
  featureKeys: string[];
  /** Tailwind palette classes for the highlight card + selector pill. */
  cardClass: string;
  cardHeadlineClass: string;
  cardCheckClass: string;
  pillActiveClass: string;
}

export const CLAWAI_TIER_INFO: Record<ClawaiTier, ClawaiTierInfo> = {
  free: {
    planName: "Free plan",
    planNameKey: "ai.planNameFree",
    pillLabel: "Free",
    priceEuro: 0,
    pricePeriod: "free forever",
    pricePeriodKey: "ai.planPeriodFree",
    hasTrial: false,
    features: [
      "Standard daily usage",
      "DeepSeek V4 Flash",
      "1 GB ClawKeep cloud backups",
      "Portal access",
    ],
    featureKeys: [
      "ai.planFeatureStandardUsage",
      "ai.planFeatureFlashModel",
      "ai.planFeatureBackups1gb",
      "ai.planFeaturePortal",
    ],
    cardClass: "border-white/10 bg-white/[0.03]",
    cardHeadlineClass: "text-gray-100",
    cardCheckClass: "text-emerald-300",
    pillActiveClass: "bg-[var(--bg-surface)] text-gray-100",
  },
  flash: {
    planName: "Pro plan",
    planNameKey: "ai.planNamePro",
    pillLabel: "Pro",
    priceEuro: 9,
    pricePeriod: "/month",
    pricePeriodKey: "ai.planPeriodMonth",
    // Pro bills from day one; flip to true if a trial returns.
    hasTrial: false,
    features: [
      "5× more usage than Free",
      "DeepSeek V4 Flash",
      "5 GB ClawKeep cloud backups",
      "Remote Desktop access",
      "Priority processing",
      "Email support",
    ],
    featureKeys: [
      "ai.planFeature5xUsage",
      "ai.planFeatureFlashModel",
      "ai.planFeatureBackups5gb",
      "ai.planFeatureRemoteDesktop",
      "ai.planFeaturePriority",
      "ai.planFeatureEmailSupport",
    ],
    cardClass: "border-orange-400/20 bg-orange-500/5",
    cardHeadlineClass: "text-orange-100",
    cardCheckClass: "text-orange-300",
    pillActiveClass: "bg-gradient-to-r from-orange-500/30 to-amber-500/20 text-orange-100",
  },
  pro: {
    planName: "Max plan",
    planNameKey: "ai.planNameMax",
    pillLabel: "Max",
    priceEuro: 49,
    pricePeriod: "/month",
    pricePeriodKey: "ai.planPeriodMonth",
    hasTrial: true,
    features: [
      "Maximum usage",
      "DeepSeek V4 Pro (frontier)",
      "50 GB ClawKeep cloud backups",
      "Remote Desktop access",
      "Highest priority",
      "Full Support — real humans via Call/Meeting",
    ],
    featureKeys: [
      "ai.planFeatureMaxUsage",
      "ai.planFeatureProModel",
      "ai.planFeatureBackups50gb",
      "ai.planFeatureRemoteDesktop",
      "ai.planFeatureHighestPriority",
      "ai.planFeatureFullSupport",
    ],
    cardClass:
      "border-fuchsia-400/25 bg-gradient-to-br from-fuchsia-500/10 via-pink-500/5 to-transparent",
    cardHeadlineClass: "text-fuchsia-100",
    cardCheckClass: "text-fuchsia-300",
    pillActiveClass: "bg-gradient-to-r from-fuchsia-500/20 to-pink-500/20 text-pink-100",
  },
};

export const CLAWAI_TIER_ORDER: readonly ClawaiTier[] = ["free", "flash", "pro"] as const;

/** The one marketing line for ClawBox AI. Both panels render this string. */
export const CLAWBOX_AI_DESCRIPTION =
  "All-in cloud AI for ClawBox — backups, remote desktop, full support";

/** Its translation key, for a caller that has a `t()` to hand — the constant
 *  above stays the English floor for the ones that do not. */
export const CLAWBOX_AI_DESCRIPTION_KEY = "ai.clawboxAiDescription";

export function normalizeClawaiUiTier(value: unknown): ClawaiTier | null {
  return value === "free" || value === "flash" || value === "pro" ? value : null;
}

/**
 * UI tier → *device* tier (which model gets configured). Free and Pro both run
 * DeepSeek V4 Flash (see CLAWAI_TIER_INFO.free.features); only Max gets the
 * frontier weights. `ClawboxAiTier` has no "free" member because the device has
 * nothing different to configure for it.
 */
export function uiTierToDeviceTier(tier: ClawaiTier): ClawboxAiTier {
  return tier === "pro" ? "pro" : "flash";
}

/**
 * Device tier (or the raw stored value) → UI tier. `null`/absent means the
 * portal reconciled the account down to Free, so the pill must show Free —
 * not "Pro plan €9" for someone who is not paying.
 */
export function deviceTierToUiTier(stored: string | null | undefined): ClawaiTier {
  return stored === "pro" ? "pro" : stored === "flash" ? "flash" : "free";
}

/**
 * The UI tier the customer last chose, or the safe default.
 *
 * "flash" ("Pro plan") is the default only because it is what the connect flow
 * pre-selects for someone who has not paired anything yet. It must never be
 * used as the answer for a box that IS paired — see `resolveUiTier`.
 */
export function readStoredUiTier(): ClawaiTier {
  if (typeof window === "undefined") return "flash";
  try {
    return normalizeClawaiUiTier(window.localStorage?.getItem(CLAWAI_TIER_STORAGE_KEY)) ?? "flash";
  } catch {
    return "flash";
  }
}

/**
 * Which PLAN card to show for a paired device.
 *
 * The device tier cannot represent Free: `uiTierToDeviceTier` maps both "free"
 * and "flash" to the device's "flash" (Free and Pro run the same DeepSeek V4
 * Flash weights), so a stored "flash" means Free OR Pro. Trusting local storage
 * blindly showed "Pro plan — €9/month" to a Free user; trusting it on a paired
 * Max box shows "Pro plan — €9/month" to someone paying €49 (TASK-468). "pro"
 * (Max) is unambiguous and always wins over local storage.
 *
 * `hasToken` is what makes this safe for the wizard: an UNPAIRED box has no
 * account to reconcile against, and the picker there is the customer choosing a
 * plan they do not have yet, so their stored intent must survive untouched.
 *
 * Shared by both provider panels on purpose. The OpenClaw panel read only local
 * storage for months while the Hermes panel had this rule, which is exactly the
 * drift this module exists to prevent.
 */
export function resolveUiTier(hasToken: boolean, tierStored: string | null | undefined): ClawaiTier {
  if (!hasToken) return readStoredUiTier();
  const device = deviceTierToUiTier(tierStored);
  if (device !== "flash") return device;
  return readStoredUiTier() === "free" ? "free" : "flash";
}
