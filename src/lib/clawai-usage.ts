/**
 * The ClawBox AI usage payload, read the way the Settings usage card needs it.
 *
 * Pure TypeScript — the setup-api route normalizes the portal's answer with it
 * and the card formats the numbers with it, so the two cannot disagree about
 * what a field means.
 *
 * TWO shapes arrive. A portal with rolling allowances answers `weekly`, `burst`,
 * `meters` and `credits` beside the fields it has always sent; an older portal
 * sends only those fields (`percentUsed`, `resetIn`, `isOverLimit`, `tier`,
 * `tierDisplayName`, `buckets`). The presence of a `weekly` object is what
 * tells them apart, and an older answer is rendered from its own fields rather
 * than squeezed into the new card with blanks where the numbers should be.
 *
 * `unavailable` on a window means the portal could not READ it — zero and
 * unreadable are the same number and opposite facts, so an unreadable window is
 * never drawn as an empty bar.
 */

import { PORTAL_DASHBOARD_URL, PORTAL_LOGIN_URL } from "@/lib/max-subscription";

/** Where a paid plan buys prepaid credits. */
export const PORTAL_CREDITS_URL = `${PORTAL_LOGIN_URL}/credits`;

/** The plan cards, with the monthly/yearly switch. */
export const PORTAL_PLANS_URL = `${PORTAL_DASHBOARD_URL}#subscription`;

/**
 * The yearly discount the portal advertises, rounded the way its plan cards
 * round it (Pro EUR 89 against EUR 108 a year of monthly charges, Max EUR 479
 * against EUR 588).
 */
export const YEARLY_SAVINGS_PCT = 18;

/** The four rolling-week meters, in the order the card lists them. */
export const CLAWAI_USAGE_METERS = ["images", "speechSeconds", "audioSeconds", "embeddingsTokens"] as const;

export type ClawaiUsageMeter = (typeof CLAWAI_USAGE_METERS)[number];

export type ClawaiUsagePlan = "free" | "pro" | "max";

export interface ClawaiUsageWindow {
  used: number;
  limit: number;
  percentUsed: number;
  isOverLimit: boolean;
  /** ISO 8601 "frees up at", or null. */
  resetAt: string | null;
  /** The portal could not read this window; `used` is not a fact. */
  unavailable: boolean;
}

export interface ClawaiUsageCredits {
  balanceCents: number;
  usedThisWeekCents: number;
  /** A paid plan: offered a top-up. Free is offered an upgrade instead. */
  canBuy: boolean;
  /** ISO 4217. The portal bills credits in euros and says so only when that changes. */
  currency: string;
  /** The balance could not be read; the zeros are not a balance. */
  unavailable: boolean;
}

/** The fields every portal has sent, weekly or not. Kept whole for the one release that still reads them. */
export interface ClawaiLegacyUsage {
  percentUsed: number;
  resetIn: string | null;
  isOverLimit: boolean;
  tier: string | null;
  tierDisplayName: string | null;
  buckets: Record<string, unknown> | null;
}

export type ClawaiUsage =
  | {
      shape: "weekly";
      plan: ClawaiUsagePlan | null;
      tierDisplayName: string | null;
      weekly: ClawaiUsageWindow;
      burst: ClawaiUsageWindow | null;
      meters: Partial<Record<ClawaiUsageMeter, ClawaiUsageWindow>>;
      credits: ClawaiUsageCredits | null;
      /** "month" or "year" when the portal says; null when it does not. */
      billingInterval: "month" | "year" | null;
      legacy: ClawaiLegacyUsage;
    }
  | {
      shape: "legacy";
      plan: ClawaiUsagePlan | null;
      tierDisplayName: string | null;
      legacy: ClawaiLegacyUsage;
    };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function percent(value: unknown, used: number, limit: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
  return limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
}

function instant(value: unknown): string | null {
  const at = text(value);
  return at && !Number.isNaN(Date.parse(at)) ? at : null;
}

function readWindow(value: unknown): ClawaiUsageWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const used = count(raw.used);
  const limit = count(raw.limit);
  return {
    used,
    limit,
    percentUsed: percent(raw.percentUsed, used, limit),
    isOverLimit: raw.isOverLimit === true || (limit > 0 && used >= limit),
    resetAt: instant(raw.resetAt ?? raw.resetsAt),
    unavailable: raw.unavailable === true,
  };
}

function readPlan(value: unknown): ClawaiUsagePlan | null {
  const tier = text(value)?.toLowerCase();
  return tier === "free" || tier === "pro" || tier === "max" ? tier : null;
}

function readCredits(value: unknown): ClawaiUsageCredits | null {
  const raw = record(value);
  if (!raw) return null;
  const currency = text(raw.currency);
  return {
    balanceCents: count(raw.balanceCents),
    usedThisWeekCents: count(raw.usedThisWeekCents),
    canBuy: raw.canBuy === true,
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "EUR",
    unavailable: raw.unavailable === true,
  };
}

/** "4h 30m", "45m", "2d 3h" — the portal's own `resetIn` wording, for a weekly answer that left it out. */
export function durationUntil(resetAt: string | null, now = Date.now()): string | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt) - now;
  if (Number.isNaN(ms)) return null;
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * The portal's answer as the card reads it, or null when it is not a usage
 * payload at all (an HTML page, an error envelope, an empty body).
 */
export function normalizeClawaiUsage(body: unknown, now = Date.now()): ClawaiUsage | null {
  const raw = record(body);
  if (!raw) return null;
  const weekly = readWindow(raw.weekly);
  const hasLegacy = typeof raw.percentUsed === "number" || typeof raw.tier === "string";
  if (!weekly && !hasLegacy) return null;

  const plan = readPlan(raw.tier);
  const tierDisplayName = text(raw.tierDisplayName);
  const legacy: ClawaiLegacyUsage = {
    // Derived from the weekly pool when a newer portal stops sending them, so
    // a reader of the old fields keeps getting an answer for one more release.
    percentUsed: typeof raw.percentUsed === "number" && Number.isFinite(raw.percentUsed)
      ? Math.max(0, Math.min(100, Math.round(raw.percentUsed)))
      : weekly?.percentUsed ?? 0,
    resetIn: text(raw.resetIn) ?? (weekly ? durationUntil(weekly.resetAt, now) : null),
    isOverLimit: typeof raw.isOverLimit === "boolean" ? raw.isOverLimit : weekly?.isOverLimit ?? false,
    tier: text(raw.tier),
    tierDisplayName,
    buckets: record(raw.buckets),
  };

  if (!weekly) return { shape: "legacy", plan, tierDisplayName, legacy };

  const meterTable = record(raw.meters);
  const meters: Partial<Record<ClawaiUsageMeter, ClawaiUsageWindow>> = {};
  for (const meter of CLAWAI_USAGE_METERS) {
    const window = readWindow(meterTable?.[meter]);
    if (window) meters[meter] = window;
  }
  const interval = text(raw.billingInterval)?.toLowerCase();
  return {
    shape: "weekly",
    plan,
    tierDisplayName,
    weekly,
    burst: readWindow(raw.burst),
    meters,
    credits: readCredits(raw.credits),
    billingInterval: interval === "month" || interval === "year" ? interval : null,
    legacy,
  };
}

/** A paid plan that is not already billed yearly — the one the yearly offer is for. */
export function offersYearlyBilling(usage: ClawaiUsage): boolean {
  return usage.shape === "weekly"
    && (usage.plan === "pro" || usage.plan === "max")
    && usage.billingInterval !== "year";
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat("en", options);
  }
}

/** A token or picture count, short: "950", "12K", "1.2M" in the owner's language. */
export function formatUsageCount(value: number, locale: string): string {
  return numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(Math.max(0, value));
}

/**
 * Seconds of audio as whole minutes. Rounded UP for what was used, so a
 * ten-second clip never reads as "0 of 60", and DOWN for the limit, so the card
 * never promises a part-minute the meter does not have.
 */
export function formatUsageMinutes(seconds: number, locale: string, round: "up" | "down"): string {
  const minutes = round === "up" ? Math.ceil(Math.max(0, seconds) / 60) : Math.floor(Math.max(0, seconds) / 60);
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(minutes);
}

/** Cents as money in the owner's language: "€12.50", "12,50 €". */
export function formatCredits(cents: number, currency: string, locale: string): string {
  try {
    return numberFormat(locale, { style: "currency", currency }).format(Math.max(0, cents) / 100);
  } catch {
    return numberFormat(locale, { style: "currency", currency: "EUR" }).format(Math.max(0, cents) / 100);
  }
}
