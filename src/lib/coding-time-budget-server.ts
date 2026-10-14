/**
 * The server half of the time budget: what a start request's `budget` field,
 * its task's words and the owner's default come to, on the BOX's clock and in
 * the box's zone (src/lib/coding-time-budget.ts is the pure half, shared with
 * the start UI). One function, so the run route and the team route resolve a
 * budget the same way.
 */
import { getDefaultTimeBudget, getTokenLimit } from "@/lib/coding-agent";
import { resolveBudget, type BudgetResolution, type TimeBudget } from "@/lib/coding-time-budget";
import { readOsTimeZone } from "@/lib/timezone";

/**
 * Resolve a start request's budget.
 *
 * @param input.explicit the request's `budget` field, untouched — absent/null
 *   is "not chosen", `"none"` is "no budget", anything else is read or refused
 * @param input.text the task (or goal) — its words may name a budget
 * @param input.applyDefault false for a resume or a Fix CI continuation: the
 *   owner's default is for new work, not for a run picking up where it was
 * @returns the resolution; `ok: false` carries the sentence a route answers 400 with.
 *   A budget over two hours that names no spend ceiling carries the owner's
 *   existing token cap as its `tokenCap` (none when the owner set none).
 */
export async function resolveStartBudget(
  input: { explicit: unknown; text: string; applyDefault: boolean },
  now: number = Date.now(),
): Promise<BudgetResolution> {
  const [tz, defaultPreset, defaultTokenCap] = await Promise.all([
    readOsTimeZone().catch(() => "UTC"),
    input.applyDefault ? getDefaultTimeBudget().catch(() => null) : Promise.resolve(null),
    getTokenLimit().catch(() => null),
  ]);
  return resolveBudget({ explicit: input.explicit, text: input.text, defaultPreset, defaultTokenCap }, now, tz);
}

/**
 * The budget fields of a start route's answer: `timeBudget` when there is one,
 * and `timeBudgetIgnored` when the task's words named a budget this box would
 * not take (in the past, more than 14 days away, under 5 minutes) — so the
 * caller can tell the owner rather than have the words silently dropped.
 * Empty without either, so an answer without a budget is the answer it was.
 */
export function budgetAnswer(resolution: Extract<BudgetResolution, { ok: true }>): {
  timeBudget?: TimeBudget;
  timeBudgetIgnored?: { phrase: string; error: string };
} {
  const text = resolution.text;
  return {
    ...(resolution.budget ? { timeBudget: resolution.budget } : {}),
    ...(text && !text.ok ? { timeBudgetIgnored: { phrase: text.match.phrase, error: text.error } } : {}),
  };
}
