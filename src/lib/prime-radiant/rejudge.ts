/**
 * Re-judge the OPEN contradiction items under today's pairing rules
 * (pairing.ts): an item the nightly pass would no longer raise is closed —
 * status `resolved`, action `dismiss`, by `auto` — with a note that says why,
 * so the owner can audit it:
 *
 *  - "same document: draft vs final" — its two pages are versions of one
 *    document (versions.ts);
 *  - "different subjects" — different identifiers, days, months or records
 *    ({@link IDENTIFIER_FILTER_NOTE}, {@link RECORD_FILTER_NOTE}), or
 *    different subjects once template words are out;
 *  - "superseded" — an old fact against the current one: a deprecated page,
 *    a historical claim, or periods that do not overlap (validity.ts);
 *  - "verified claim wins" — one side is owner-verified: the other becomes a
 *    stale note on its page (verify.ts), not a question.
 *
 * Nothing is asked of a model. An item the owner already settled is never
 * touched: only `open` items are read, and an open one that carries a
 * person's resolution is left as it is. An item with BOTH sides
 * owner-verified stays open: two facts a person settled disagree, so a person
 * decides. `dryRun` closes nothing and counts what would close, per reason.
 *
 * SERVER ONLY.
 */

import { DIFFERENT_RECORDS, differentSubjectSides, IDENTIFIER_FILTER_NOTE, RECORD_FILTER_NOTE, sideIdentifiers } from "./identifiers";
import { noPairFamily, noPairReason, type NoPair, type NoPairCode, type PairClaim } from "./pairing";
import { redactText } from "./redact";
import { listReviewItems, MAX_REVIEW_LIST, settleReviewItem, type ReviewCandidate, type ReviewItem } from "./review-store";
import type { Claim, PageFrontmatter } from "./schema";
import { claimSubject } from "./subject";
import { claimValidity, historicalClaim, pageValidity, textValidity } from "./validity";
import { ownerVerified, recordStaleClaims, type StaleClaimNote } from "./verify";
import { documentName, sameDocument, versionGroups, versionIndex, versionPages } from "./versions";
import type { VaultSnapshot } from "./vault";

/** As the contradiction pass cuts a claim before it redacts it (contradictions.ts). */
const MAX_CLAIM_CHARS = 500;
const SAMPLE = 200;

/** Every reason the re-judge closes an item for: pairing.ts's, and an owner-verified side. */
export type RejudgeCode = NoPairCode | "verified-wins";

export interface RejudgeResult {
  /** Open contradiction items looked at. */
  checked: number;
  /** Items closed (with `dryRun`: that would be). */
  closed: number;
  /** Closed per reason (with `dryRun`: would be). */
  byReason: Partial<Record<RejudgeCode, number>>;
  /** The same, by family: same document, different subjects, superseded, verified claim wins. */
  byFamily: Record<string, number>;
  /** Items with both sides owner-verified: left open, a person decides. */
  keptVerified: number;
  /** Open items that carry a person's resolution: never touched. */
  keptOwner: number;
  /** Open items that still qualify: left for the owner. */
  stillOpen: number;
  /** Stale notes written for the losing side of a verified claim (with `dryRun`: that would be). */
  staleNotes: number;
  /** Why, per closed item (id → reason and note), at most the first 200. */
  sample: Array<{ id: string; reason: string; code: RejudgeCode; note: string }>;
  dryRun: boolean;
}

/** What the filter reads of a page: its title, and its type (an entity or a how-to page is never a record). */
export interface RejudgePage {
  title: string;
  type?: string | null;
  status?: string | null;
  generatedAt?: string | null;
  /** The page's own frontmatter, when the snapshot has it: the claims are read from it. */
  frontmatter?: PageFrontmatter;
}

/** What a person verified: an item touching any of it is a person's. */
export interface VerifiedIndex {
  /** Ids of the owner-verified claims. */
  claims: ReadonlySet<string>;
  /** Per page, the texts of its owner-verified claims, as written and as the pass redacts them. */
  texts: ReadonlyMap<string, ReadonlySet<string>>;
  /** Pages a person verified as a whole. */
  pages: ReadonlySet<string>;
}

/** The owner-verified claims (and pages) of a snapshot. Pure. */
export function verifiedIndex(snapshot: Pick<VaultSnapshot, "pages">): VerifiedIndex {
  const claims = new Set<string>();
  const texts = new Map<string, Set<string>>();
  const pages = new Set<string>();
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    if (fm.verified && ownerVerified({ verified: null, status: "proposed" }, fm)) pages.add(p.path);
    for (const c of fm.claims) {
      if (!ownerVerified(c)) continue;
      claims.add(c.id);
      const onPage = texts.get(p.path) ?? new Set<string>();
      onPage.add(c.text);
      onPage.add(redactText(c.text.slice(0, MAX_CLAIM_CHARS)).text);
      texts.set(p.path, onPage);
    }
  }
  return { claims, texts, pages };
}

/** Whether one candidate is owner-verified: marked so by the pass, a verified claim's id or text on its page, or a verified page. Pure. */
export function candidateVerified(c: ReviewCandidate, verified: VerifiedIndex): boolean {
  return (
    c.evidence.some((e) => e.kind === "verified-claim") ||
    (!!c.claimId && verified.claims.has(c.claimId)) ||
    (!!c.page && (verified.pages.has(c.page) || !!verified.texts.get(c.page)?.has(c.text)))
  );
}

/** Whether an item touches something a person verified (either side, or the claim it is filed under). Pure. */
export function touchesVerified(item: Pick<ReviewItem, "claimId" | "candidates">, verified: VerifiedIndex): boolean {
  if (item.claimId && verified.claims.has(item.claimId)) return true;
  return item.candidates.some((c) => candidateVerified(c, verified));
}

/**
 * The title a page path's slug spells, for a page the vault no longer holds:
 * "concepts/export-declaration-acme-inv-2026-0021-pdf-23-02-2026.md" →
 * "export declaration acme inv-2026-0021 pdf 23.02.2026". Dates and
 * references keep their joins so the filters can read them.
 */
export function titleFromPath(path: string): string {
  let s = path.replace(/^.*\//, "").replace(/\.md$/, "");
  s = s.replace(/(?<![\da-z])(\d{1,2})-(\d{1,2})-((?:19|20)\d{2})(?![\da-z])/g, "$1.$2.$3");
  s = s.replace(/(?<![\da-z])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![\da-z])/g, "$1~$2~$3");
  // A code's prefix ("inv-2026-0021", "cb-inv-2026-…") keeps its joins; a word before a year ("report-2026") does not.
  s = s.replace(/(?<![\da-z])([a-z]{1,4}(?:-[a-z]{1,4})?)-((?:\d+-)*\d{3,})(?![\da-z])/g, (m, _p: string, digits: string) =>
    /^(?:19|20)\d{2}$/.test(digits) ? m : m.replace(/-/g, "~"),
  );
  return s.replace(/-/g, " ").replace(/~/g, "-");
}

/** The entity a page's claims are filed under (claims.ts: the title's slug, 48 characters), read from its path. */
function pathEntity(path: string | null): string {
  return (path ?? "").replace(/^.*\//, "").replace(/\.md$/, "").slice(0, 48).replace(/-+$/, "");
}

interface Side extends PairClaim {
  candidate: ReviewCandidate;
  title: string | null;
  claimId: string | null;
}

function findClaim(fm: PageFrontmatter | undefined, c: ReviewCandidate): Claim | null {
  if (!fm) return null;
  if (c.claimId) {
    const byId = fm.claims.find((x) => x.id === c.claimId);
    if (byId) return byId;
  }
  return fm.claims.find((x) => x.text === c.text || redactText(x.text.slice(0, MAX_CLAIM_CHARS)).text === c.text) ?? null;
}

function sideOf(c: ReviewCandidate, pages: ReadonlyMap<string, string | RejudgePage>, written: string | null): Side {
  const known = c.page ? pages.get(c.page) : undefined;
  const info: RejudgePage | null = typeof known === "string" ? { title: known } : (known ?? null);
  // A page the vault no longer holds is read by its path's slug.
  const title = info?.title ?? (c.page ? titleFromPath(c.page) : null);
  const claim = findClaim(info?.frontmatter, c);
  const pageInfo = { title, type: info?.type ?? null, generatedAt: info?.generatedAt ?? null };
  const validity = claim ? claimValidity(claim, pageInfo) : (textValidity(c.text, written) ?? pageValidity(title, info?.type, info?.generatedAt ?? written));
  const claimId = c.claimId ?? claim?.id ?? null;
  return {
    candidate: c,
    title,
    claimId,
    text: c.text,
    subject: claimSubject(claimId ?? `x/${pathEntity(c.page)}/x`, c.text, title),
    ids: sideIdentifiers(title, c.text, info?.type ?? null),
    validity,
    historical: claim ? historicalClaim(claim) : historicalClaim({ text: c.text }),
    deprecated: info?.status === "deprecated",
  };
}

/** The two sides of a two-sided contradiction item, with their pages' version groups; null for any other item. */
function sidesOf(
  item: Pick<ReviewItem, "kind" | "candidates" | "createdAt">,
  pages: ReadonlyMap<string, string | RejudgePage>,
  versions: ReadonlyMap<string, string>,
): [Side, Side] | null {
  // Only the two-sided items the pass raises; a hand-raised item with more candidates is a person's question.
  if (item.kind !== "contradiction" || item.candidates.length !== 2) return null;
  const [a, b] = item.candidates.map((c) => sideOf(c, pages, item.createdAt ?? null));
  const va = a.candidate.page ? (versions.get(a.candidate.page) ?? null) : null;
  const vb = b.candidate.page ? (versions.get(b.candidate.page) ?? null) : null;
  if (va && va === vb) {
    a.version = va;
    b.version = vb;
  } else if (a.candidate.page !== b.candidate.page && a.title && b.title && sameDocument(documentName(a.title), documentName(b.title))) {
    // Pages one of which the vault no longer holds: their titles alone.
    a.version = b.version = `${a.candidate.page}|${b.candidate.page}`;
  }
  return [a, b];
}

/**
 * Why today's rules would not raise this item, or null to leave it (pure).
 * `pages` maps a page path to its title (and type, status, frontmatter);
 * without the type a page is judged by its title alone, and a page missing
 * from the map by its path. The reason is pairing.ts's detail: "different
 * identifiers", {@link DIFFERENT_RECORDS}, "same document: draft vs final" …
 */
export function rejudgeReason(
  item: Pick<ReviewItem, "kind" | "candidates"> & { createdAt?: string },
  pages: ReadonlyMap<string, string | RejudgePage>,
  versions: ReadonlyMap<string, string> = new Map(),
): string | null {
  return rejudgeVerdict({ createdAt: "", ...item }, pages, versions)?.detail ?? null;
}

/** {@link rejudgeReason} with its code and which side is current. */
export function rejudgeVerdict(
  item: Pick<ReviewItem, "kind" | "candidates" | "createdAt">,
  pages: ReadonlyMap<string, string | RejudgePage>,
  versions: ReadonlyMap<string, string> = new Map(),
): NoPair | null {
  const sides = sidesOf(item, pages, versions);
  return sides ? noPairReason(sides[0], sides[1]) : null;
}

const VERIFIED_NOTE_PREFIX = "auto: verified claim wins:";

/** The resolution note an item closed for `reason` carries: auditable, a line. */
export function rejudgeNote(reason: string, context: { code?: RejudgeCode; pages?: readonly (string | null)[]; current?: string | null; winner?: string | null } = {}): string {
  const code = context.code;
  if (!code || code === "different-identifiers" || code === "different-dates" || code === "different-months" || code === "different-records") {
    return reason === DIFFERENT_RECORDS ? RECORD_FILTER_NOTE : IDENTIFIER_FILTER_NOTE;
  }
  const pages = (context.pages ?? []).filter((p): p is string => !!p);
  const note =
    code === "verified-wins"
      ? `${VERIFIED_NOTE_PREFIX} ${reason}`
      : code === "same-document"
        ? `auto: ${reason} (${pages.join(" and ")} are versions of one document${context.winner ? `; ${context.winner} is kept` : ""})`
        : `auto: ${noPairFamily(code)}: ${reason}${code.startsWith("superseded") && context.current ? `; the current claim is on ${context.current}` : ""}`;
  return note.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 400);
}

const FAMILY: Readonly<Record<RejudgeCode, string>> = {
  "same-document": "same document",
  "different-identifiers": "different subjects",
  "different-dates": "different subjects",
  "different-months": "different subjects",
  "different-records": "different subjects",
  "different-subjects": "different subjects",
  "superseded-deprecated": "superseded",
  "superseded-historical": "superseded",
  "superseded-period": "superseded",
  "verified-wins": "verified claim wins",
};

export function rejudgeOpenContradictions(
  stateVault: string,
  snapshot: Pick<VaultSnapshot, "pages">,
  options: { dryRun?: boolean; now?: () => Date } = {},
): RejudgeResult {
  const pages = new Map<string, RejudgePage>();
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    pages.set(p.path, { title: fm.title, type: fm.type, status: fm.status, generatedAt: fm.generated?.at ?? null, frontmatter: fm });
  }
  const groups = versionGroups(versionPages(snapshot));
  const versions = versionIndex(groups);
  const verified = verifiedIndex(snapshot);
  const open: ReviewItem[] = [];
  for (let offset = 0; ; offset += MAX_REVIEW_LIST) {
    const page = listReviewItems(stateVault, { status: "open", kind: "contradiction", offset, limit: MAX_REVIEW_LIST });
    open.push(...page.items);
    if (page.items.length < MAX_REVIEW_LIST) break;
  }
  const result: RejudgeResult = {
    checked: open.length,
    closed: 0,
    byReason: {},
    byFamily: {},
    keptVerified: 0,
    keptOwner: 0,
    stillOpen: 0,
    staleNotes: 0,
    sample: [],
    dryRun: !!options.dryRun,
  };
  const at = (options.now ?? (() => new Date()))().toISOString();
  for (const item of open) {
    // An open item a person already answered (put off, then reopened by hand): theirs, never this pass's.
    if (item.resolution && item.resolution.by !== "auto") {
      result.keptOwner += 1;
      continue;
    }
    const sides = sidesOf(item, pages, versions);
    if (!sides) {
      result.stillOpen += 1;
      continue;
    }
    const [a, b] = sides;
    const aVerified = candidateVerified(a.candidate, verified) || (!!item.claimId && item.claimId === a.claimId && verified.claims.has(item.claimId));
    const bVerified = candidateVerified(b.candidate, verified) || (!!item.claimId && item.claimId === b.claimId && verified.claims.has(item.claimId));
    // Two facts a person settled disagree: a person decides.
    if (aVerified && bVerified) {
      result.keptVerified += 1;
      continue;
    }
    const why = noPairReason(a, b);
    let code: RejudgeCode;
    let reason: string;
    let current: Side | null = null;
    let staleNote: StaleClaimNote | null = null;
    if (why) {
      code = why.code;
      reason = why.detail;
      if (why.current) current = why.current === "a" ? a : b;
    } else if (aVerified !== bVerified) {
      const [won, other] = aVerified ? [a, b] : [b, a];
      // The losing claim must be named to be marked stale; one that cannot be stays the owner's question.
      if (!other.claimId || !other.candidate.page || !won.claimId || !won.candidate.page) {
        result.stillOpen += 1;
        continue;
      }
      code = "verified-wins";
      reason = `${other.candidate.page} disagrees with the owner-verified claim on ${won.candidate.page}; marked stale there, not a question`;
      staleNote = {
        claimId: other.claimId,
        page: other.candidate.page,
        verifiedClaimId: won.claimId,
        verifiedPage: won.candidate.page,
        why: item.evidence.find((e) => e.kind === "judge")?.note ?? "",
        at,
      };
    } else {
      result.stillOpen += 1;
      continue;
    }
    const winner = code === "same-document" ? (a.candidate.page ? (groups.find((g) => g.pages.includes(a.candidate.page!))?.winner ?? null) : null) : null;
    const note = rejudgeNote(reason, { code, pages: [a.candidate.page, b.candidate.page], current: current?.candidate.page ?? null, winner });
    if (staleNote && !options.dryRun) {
      // The stale note first: an item is never closed as "marked stale" when the mark could not be written.
      try {
        recordStaleClaims(stateVault, [staleNote]);
      } catch {
        result.stillOpen += 1;
        continue;
      }
    }
    const moved = options.dryRun ? true : settleReviewItem(stateVault, item.id, "resolved", { action: "dismiss", by: "auto", note }, at);
    if (!moved) continue;
    result.closed += 1;
    result.byReason[code] = (result.byReason[code] ?? 0) + 1;
    result.byFamily[FAMILY[code]] = (result.byFamily[FAMILY[code]] ?? 0) + 1;
    if (staleNote) result.staleNotes += 1;
    if (result.sample.length < SAMPLE) result.sample.push({ id: item.id, reason, code, note });
  }
  return result;
}

/** The counts a dry run prints, one line per reason, most first. */
export function rejudgeSummary(result: RejudgeResult): string[] {
  const lines = [`${result.dryRun ? "would close" : "closed"} ${result.closed} of ${result.checked} open contradiction item(s)`];
  for (const [code, n] of Object.entries(result.byReason).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))) lines.push(`  ${code}: ${n}`);
  lines.push(`left open: ${result.stillOpen}; both sides owner-verified: ${result.keptVerified}; carrying a person's answer: ${result.keptOwner}`);
  return lines;
}

/** The identifier filter alone, as before the other rules (pure): kept for readers that ask only for it. */
export function identifierReason(item: Pick<ReviewItem, "kind" | "candidates">, pages: ReadonlyMap<string, string | RejudgePage>): string | null {
  if (item.kind !== "contradiction" || item.candidates.length !== 2) return null;
  const [a, b] = item.candidates.map((c) => {
    const known = c.page ? pages.get(c.page) : undefined;
    const info = typeof known === "string" ? { title: known } : known;
    return { title: info?.title ?? null, type: info?.type ?? null, text: c.text };
  });
  return differentSubjectSides(a, b);
}
