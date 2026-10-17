/**
 * When a page is due for a re-check. Pure.
 *
 * A page's own `stale_after` (the MCP tools call it `recheck_after`) is its
 * date. A page without one follows its TYPE: a metric is re-checked 30 days
 * after it was last looked at, a decision or an entity after 180, … — and a
 * RECORD never (an invoice, a statement, a daily report: identifiers.ts
 * `recordPage`), nor a source page, nor one of the connect pass's dated hubs
 * (a list of records). "Last looked at" is the latest of the page's writing,
 * its own `as_of`, and any verification on it — so a claim verified on the
 * page (the owner's answer to a daily question) starts its clock again.
 */

import { recordPage } from "./identifiers";
import { isIsoDate, type PageFrontmatter, type PageType } from "./schema";

/** Days between re-checks by page type; null = never. */
export const RECHECK_DAYS: Readonly<Record<PageType, number | null>> = Object.freeze({
  metric: 30,
  synthesis: 90,
  decision: 180,
  entity: 180,
  howto: 180,
  concept: 365,
  reference: 365,
  source: null,
});

export interface Recheck {
  /** The day (YYYY-MM-DD) after which the page is due; null = never. */
  date: string | null;
  /** `page`: the page's own `stale_after`; `type`: worked out from its type. */
  by: "page" | "type";
  /** The type's interval in days (null = never). */
  days: number | null;
}

type RecheckFields = Pick<PageFrontmatter, "type" | "title" | "stale_after" | "generated" | "verified" | "claims"> & { as_of?: unknown; hub?: unknown };

/** The type's interval for this page: null for records, source pages and dated hubs. */
export function recheckDays(fm: Pick<RecheckFields, "type" | "title" | "hub">): number | null {
  if (fm.hub && typeof fm.hub === "object") return null;
  if (recordPage(fm.title, fm.type)) return null;
  return RECHECK_DAYS[fm.type] ?? null;
}

/** The latest moment someone (or the writer) looked at the page, as epoch ms; NaN when nothing parses. */
export function lastChecked(fm: Pick<RecheckFields, "generated" | "verified" | "claims" | "as_of">): number {
  const moments = [fm.generated?.at, fm.verified?.at, typeof fm.as_of === "string" ? fm.as_of : null, ...fm.claims.map((c) => c.verified?.at)];
  let best = Number.NaN;
  for (const m of moments) {
    if (typeof m !== "string" || !isIsoDate(m)) continue;
    const t = Date.parse(m);
    if (Number.isNaN(best) || t > best) best = t;
  }
  return best;
}

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The page's re-check date: its own, else its type's from when it was last checked. */
export function recheckOf(fm: RecheckFields): Recheck {
  const days = recheckDays(fm);
  if (fm.stale_after) return { date: fm.stale_after.slice(0, 10), by: "page", days };
  if (days === null) return { date: null, by: "type", days };
  const from = lastChecked(fm);
  if (Number.isNaN(from)) return { date: null, by: "type", days };
  return { date: isoDay(from + days * DAY_MS), by: "type", days };
}

/** Whether the page is past its re-check day (a day runs through its end, UTC). */
export function recheckPassed(fm: RecheckFields, now: Date): boolean {
  const { date } = recheckOf(fm);
  if (!date) return false;
  return now.getTime() > Date.parse(`${date}T23:59:59.999Z`);
}
