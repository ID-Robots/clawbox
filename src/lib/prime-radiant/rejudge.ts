/**
 * Re-judge the OPEN contradiction items with the identifier filter
 * ({@link differentSubjectSides}): an item whose two sides carry different
 * identifiers (two waybills, two transfers, two days' reports) is closed as
 * dismissed, with the note {@link IDENTIFIER_FILTER_NOTE}; one whose two
 * sides are record pages with no reference in common (two invoices, two
 * receipts, two declarations) with the note {@link RECORD_FILTER_NOTE}. Every
 * other item stays exactly as it was — nothing is closed in bulk, nothing is
 * asked of a model — and an item that touches a VERIFIED claim (or a page a
 * person verified) is never closed here, whatever the filter says: a person
 * settled one side, so a person settles the item.
 *
 * SERVER ONLY.
 */

import { DIFFERENT_RECORDS, differentSubjectSides, IDENTIFIER_FILTER_NOTE, RECORD_FILTER_NOTE } from "./identifiers";
import { redactText } from "./redact";
import { listReviewItems, MAX_REVIEW_LIST, settleReviewItem, type ReviewItem } from "./review-store";
import type { VaultSnapshot } from "./vault";

/** As the contradiction pass cuts a claim before it redacts it (contradictions.ts). */
const MAX_CLAIM_CHARS = 500;

export interface RejudgeResult {
  /** Open contradiction items looked at. */
  checked: number;
  /** Items closed by the filter. */
  closed: number;
  /** Items the filter would close but that touch a verified claim: left open. */
  keptVerified: number;
  /** Why, per closed item (id → reason), at most the first 200. */
  sample: Array<{ id: string; reason: string }>;
  dryRun: boolean;
}

/** What the filter reads of a page: its title, and its type (an entity or a how-to page is never a record). */
export interface RejudgePage {
  title: string;
  type?: string | null;
}

/** What a person verified: an item touching any of it is never closed by the re-judge. */
export interface VerifiedIndex {
  /** Ids of the verified claims. */
  claims: ReadonlySet<string>;
  /** Per page, the texts of its verified claims, as written and as the pass redacts them. */
  texts: ReadonlyMap<string, ReadonlySet<string>>;
  /** Pages verified as a whole. */
  pages: ReadonlySet<string>;
}

/** The verified claims (and pages) of a snapshot. Pure. */
export function verifiedIndex(snapshot: Pick<VaultSnapshot, "pages">): VerifiedIndex {
  const claims = new Set<string>();
  const texts = new Map<string, Set<string>>();
  const pages = new Set<string>();
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    if (p.parsed.frontmatter.verified) pages.add(p.path);
    for (const c of p.parsed.frontmatter.claims) {
      if (!c.verified && c.status !== "verified") continue;
      claims.add(c.id);
      const onPage = texts.get(p.path) ?? new Set<string>();
      onPage.add(c.text);
      onPage.add(redactText(c.text.slice(0, MAX_CLAIM_CHARS)).text);
      texts.set(p.path, onPage);
    }
  }
  return { claims, texts, pages };
}

/**
 * Whether an item touches something a person verified: a side the pass
 * marked as a verified claim, a verified claim's id, a verified claim's text
 * on its page, or a page verified as a whole. Pure.
 */
export function touchesVerified(item: Pick<ReviewItem, "claimId" | "candidates">, verified: VerifiedIndex): boolean {
  if (item.claimId && verified.claims.has(item.claimId)) return true;
  return item.candidates.some(
    (c) =>
      c.evidence.some((e) => e.kind === "verified-claim") ||
      (!!c.claimId && verified.claims.has(c.claimId)) ||
      (!!c.page && (verified.pages.has(c.page) || !!verified.texts.get(c.page)?.has(c.text))),
  );
}

/**
 * The reason the filter would close this item, or null to leave it. Pure.
 * `pages` maps a page path to its title (and type); without the type a page
 * is judged by its title alone.
 */
export function rejudgeReason(item: Pick<ReviewItem, "kind" | "candidates">, pages: ReadonlyMap<string, string | RejudgePage>): string | null {
  // Only the two-sided items the pass raises; a hand-raised item with more candidates is a person's question.
  if (item.kind !== "contradiction" || item.candidates.length !== 2) return null;
  const [a, b] = item.candidates;
  const side = (c: (typeof item.candidates)[number]) => {
    const page = c.page ? pages.get(c.page) : undefined;
    const info = typeof page === "string" ? { title: page } : page;
    return { title: info?.title ?? null, type: info?.type ?? null, text: c.text };
  };
  return differentSubjectSides(side(a), side(b));
}

/** The resolution note an item closed for `reason` carries. */
export function rejudgeNote(reason: string): string {
  return reason === DIFFERENT_RECORDS ? RECORD_FILTER_NOTE : IDENTIFIER_FILTER_NOTE;
}

export function rejudgeOpenContradictions(
  stateVault: string,
  snapshot: Pick<VaultSnapshot, "pages">,
  options: { dryRun?: boolean; now?: () => Date } = {},
): RejudgeResult {
  const pages = new Map<string, RejudgePage>();
  for (const p of snapshot.pages) if (p.parsed.ok) pages.set(p.path, { title: p.parsed.frontmatter.title, type: p.parsed.frontmatter.type });
  const verified = verifiedIndex(snapshot);
  const open: ReviewItem[] = [];
  for (let offset = 0; ; offset += MAX_REVIEW_LIST) {
    const page = listReviewItems(stateVault, { status: "open", kind: "contradiction", offset, limit: MAX_REVIEW_LIST });
    open.push(...page.items);
    if (page.items.length < MAX_REVIEW_LIST) break;
  }
  const result: RejudgeResult = { checked: open.length, closed: 0, keptVerified: 0, sample: [], dryRun: !!options.dryRun };
  const at = (options.now ?? (() => new Date()))().toISOString();
  for (const item of open) {
    const reason = rejudgeReason(item, pages);
    if (!reason) continue;
    // A verified claim on either side: a person decides, never this filter.
    if (touchesVerified(item, verified)) {
      result.keptVerified += 1;
      continue;
    }
    const moved = options.dryRun ? true : settleReviewItem(stateVault, item.id, "resolved", { action: "dismiss", by: "auto", note: rejudgeNote(reason) }, at);
    if (!moved) continue;
    result.closed += 1;
    if (result.sample.length < 200) result.sample.push({ id: item.id, reason });
  }
  return result;
}
