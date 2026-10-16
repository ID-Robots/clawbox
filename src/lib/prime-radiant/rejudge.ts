/**
 * Re-judge the OPEN contradiction items with the identifier filter
 * ({@link differentSubjectSides}): an item whose two sides carry different
 * identifiers (two waybills, two transfers, two days' reports) is closed as
 * dismissed, with the note {@link IDENTIFIER_FILTER_NOTE}. Every other item
 * stays exactly as it was — nothing is closed in bulk, nothing is asked of a
 * model.
 *
 * SERVER ONLY.
 */

import { differentSubjectSides, IDENTIFIER_FILTER_NOTE } from "./identifiers";
import { listReviewItems, MAX_REVIEW_LIST, settleReviewItem, type ReviewItem } from "./review-store";
import type { VaultSnapshot } from "./vault";

export interface RejudgeResult {
  /** Open contradiction items looked at. */
  checked: number;
  /** Items closed by the filter. */
  closed: number;
  /** Why, per closed item (id → reason), at most the first 200. */
  sample: Array<{ id: string; reason: string }>;
  dryRun: boolean;
}

/** The reason the filter would close this item, or null to leave it. Pure. */
export function rejudgeReason(item: Pick<ReviewItem, "kind" | "candidates">, titles: ReadonlyMap<string, string>): string | null {
  // Only the two-sided items the pass raises; a hand-raised item with more candidates is a person's question.
  if (item.kind !== "contradiction" || item.candidates.length !== 2) return null;
  const [a, b] = item.candidates;
  const side = (c: (typeof item.candidates)[number]) => ({ title: c.page ? (titles.get(c.page) ?? null) : null, text: c.text });
  return differentSubjectSides(side(a), side(b));
}

export function rejudgeOpenContradictions(
  stateVault: string,
  snapshot: Pick<VaultSnapshot, "pages">,
  options: { dryRun?: boolean; now?: () => Date } = {},
): RejudgeResult {
  const titles = new Map<string, string>();
  for (const p of snapshot.pages) if (p.parsed.ok) titles.set(p.path, p.parsed.frontmatter.title);
  const open: ReviewItem[] = [];
  for (let offset = 0; ; offset += MAX_REVIEW_LIST) {
    const page = listReviewItems(stateVault, { status: "open", kind: "contradiction", offset, limit: MAX_REVIEW_LIST });
    open.push(...page.items);
    if (page.items.length < MAX_REVIEW_LIST) break;
  }
  const result: RejudgeResult = { checked: open.length, closed: 0, sample: [], dryRun: !!options.dryRun };
  const at = (options.now ?? (() => new Date()))().toISOString();
  for (const item of open) {
    const reason = rejudgeReason(item, titles);
    if (!reason) continue;
    const moved = options.dryRun ? true : settleReviewItem(stateVault, item.id, "resolved", { action: "dismiss", by: "auto", note: IDENTIFIER_FILTER_NOTE }, at);
    if (!moved) continue;
    result.closed += 1;
    if (result.sample.length < 200) result.sample.push({ id: item.id, reason });
  }
  return result;
}
