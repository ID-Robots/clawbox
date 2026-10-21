/**
 * Prime Radiant's share of the ClawBox AI allowance: the meter beside the
 * Usage view's totals.
 *
 * Every Flash call (the import's writer and the nightly passes: the
 * contradiction judge, the golden questions, node summaries, structure) goes
 * out on the box's ClawBox AI sign-in, so the proxy counts it against the
 * plan's allowance exactly like a chat turn. There is no separate Prime
 * Radiant cap, and a spent allowance stops the work (`FlashCallError` kind
 * `allowance`). The box adds the other half of the picture: how much of the
 * week was Prime Radiant's, from its own record of every call (the `costs`
 * table), beside the account's pool as the portal reports it.
 *
 * The window is the allowance's own, the trailing seven days. It rolls and
 * nothing resets (see `clawai-allowance.ts`). The tokens are Prime Radiant's
 * own count, prompt plus completion as the provider reported them. The
 * portal's pool may weigh tokens differently, so the two are shown side by
 * side and never divided into a share.
 *
 * SERVER ONLY: the account half reads the box's credential.
 */

import { isClawboxAiToken } from "@/lib/clawai-token";
import type { ClawaiUsagePlan, ClawaiUsageWindow } from "@/lib/clawai-usage";
import { fetchClawaiUsage, type ClawaiUsageAnswer, type ClawaiUsageUnavailable } from "@/lib/clawai-usage-portal";
import { resolveClawaiToken } from "@/lib/harness/credentials";
import { readCostTotals, type CostTotals } from "./runs";

/** The allowance's rolling window: the weekly pool covers the trailing seven days. */
export const ALLOWANCE_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Operations whose model call does NOT go through ClawBox AI. The optional
 * Opus tier answers from the owner's Anthropic key or Claude subscription.
 * Every other operation is a Flash call through the proxy. A new operation
 * that answers from somewhere else belongs here.
 */
export const OFF_ALLOWANCE_OPERATIONS: readonly string[] = Object.freeze(["opus-review"]);

export interface AllowanceWindow {
  used: number;
  limit: number;
  percentUsed: number;
  isOverLimit: boolean;
  /** ISO 8601 "frees up at", or null. */
  resetAt: string | null;
}

/** The account's pool as the portal reports it, or why it could not be read. */
export type AllowanceAccount =
  | {
      available: true;
      plan: ClawaiUsagePlan | null;
      /** The box's zone, so a browser elsewhere reads "frees up at" in the box's clock. */
      timeZone: string | null;
      weekly: AllowanceWindow;
      /** The 5-hour ceiling over the weekly pool; null when the portal sends none. */
      burst: AllowanceWindow | null;
    }
  | { available: false; reason: ClawaiUsageUnavailable };

export interface AllowanceMeter {
  /** Where these calls are counted: the box's ClawBox AI plan allowance. */
  countedAgainst: "clawbox-ai";
  windowDays: number;
  /** The window's start, `windowDays` back from now. */
  since: string;
  /** Prime Radiant's calls through ClawBox AI in the window. */
  primeRadiant: CostTotals;
  /** The account's pool; null when it was not asked for. */
  account: AllowanceAccount | null;
}

function windowOf(w: ClawaiUsageWindow): AllowanceWindow {
  return { used: w.used, limit: w.limit, percentUsed: w.percentUsed, isOverLimit: w.isOverLimit, resetAt: w.resetAt };
}

/**
 * The portal's answer as the meter reads it. A weekly pool the portal could
 * not read is not a 0% pool, so it counts as unreachable.
 */
export function allowanceAccountFrom(answer: ClawaiUsageAnswer, timeZone: string | null): AllowanceAccount {
  if (!answer.available) return { available: false, reason: answer.reason };
  const { usage } = answer;
  if (usage.shape === "legacy") {
    const { percentUsed, isOverLimit } = usage.legacy;
    return { available: true, plan: usage.plan, timeZone, weekly: { used: 0, limit: 0, percentUsed, isOverLimit, resetAt: null }, burst: null };
  }
  if (usage.weekly.unavailable) return { available: false, reason: "unreachable" };
  const burst = usage.burst && !usage.burst.unavailable ? windowOf(usage.burst) : null;
  return { available: true, plan: usage.plan, timeZone, weekly: windowOf(usage.weekly), burst };
}

function boxTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The account's pool, asked with the box's own `claw_*` sign-in (the portal's answer is cached for half a minute). */
export async function readAllowanceAccount(): Promise<AllowanceAccount> {
  const token = await resolveClawaiToken().catch(() => null);
  if (!token || !isClawboxAiToken(token)) return { available: false, reason: "not_connected" };
  const answer = await fetchClawaiUsage(token).catch((): ClawaiUsageAnswer => ({ available: false, reason: "unreachable" }));
  return allowanceAccountFrom(answer, boxTimeZone());
}

export interface AllowanceMeterOptions {
  now?: () => Date;
  /** How to read the account's pool; `null` leaves it unasked. Default: {@link readAllowanceAccount}. */
  account?: (() => Promise<AllowanceAccount>) | null;
}

/** Prime Radiant's ClawBox AI calls in the allowance's window, beside the account's pool. Creates nothing. */
export async function readAllowanceMeter(vault: string, options: AllowanceMeterOptions = {}): Promise<AllowanceMeter> {
  const now = (options.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - ALLOWANCE_WINDOW_DAYS * DAY_MS).toISOString();
  const primeRadiant = readCostTotals(vault, { since, excludeOperations: OFF_ALLOWANCE_OPERATIONS });
  const ask = options.account === undefined ? readAllowanceAccount : options.account;
  return {
    countedAgainst: "clawbox-ai",
    windowDays: ALLOWANCE_WINDOW_DAYS,
    since,
    primeRadiant,
    account: ask ? await ask() : null,
  };
}
