/**
 * The global claim-id namespace.
 *
 * A claim id is `<domain>/<entity-slug>/<fact-slug>`, every part lowercase
 * kebab-case, and it is unique across the WHOLE vault — not per page — so a
 * review item, a verification or a search hit can name one fact without also
 * naming where it lives. Two rules hold for ever:
 *
 *   1. one active id, one claim: two claims (on one page or on two) may never
 *      share an id;
 *   2. a retired id is never reused: verification retires the ids it
 *      replaces, and the page lists them under `retiredClaimIds`. The state
 *      database keeps its own ledger too (state-db.ts), so a retirement
 *      outlives the page that recorded it.
 *
 * Pure: the index is built from pages the caller has already read.
 */

import { SLUG_RE, type Claim, type PageFrontmatter } from "./schema";

export const CLAIM_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_CHARS = 64;

export function isClaimId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 3 * MAX_SLUG_CHARS + 2 && CLAIM_ID_RE.test(value);
}

/**
 * Cyrillic to Latin, lowercase: Bulgarian's official system (the 2009
 * Transliteration Act — щ sht, ъ a, ь y, ю yu, я ya, and `-ия` at a word's end
 * `ia`) for every letter Bulgarian has, then the Russian, Ukrainian,
 * Belarusian, Serbian and Macedonian letters it lacks by their own common
 * Latin forms. A letter the table does not know is left for the slugger to drop.
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
  // Russian / Belarusian
  ё: "yo", ы: "y", э: "e", ў: "u",
  // Ukrainian
  є: "ye", і: "i", ї: "yi", ґ: "g",
  // Serbian / Macedonian
  ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz", ѓ: "gj", ќ: "kj", ѕ: "dz",
};

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const CYRILLIC_LETTERS_RE = /[Ѐ-ӿ]/g;
/** `-ия` closing a word (България → bulgaria, София → sofia). */
const WORD_FINAL_IYA_RE = /ия(?![\p{L}\p{M}\p{N}])/gu;

/** Cyrillic letters in `text` written in Latin (the rest untouched). Deterministic. */
export function transliterateCyrillic(text: string): string {
  if (!CYRILLIC_RE.test(text)) return text;
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(WORD_FINAL_IYA_RE, "ia")
    .replace(CYRILLIC_LETTERS_RE, (ch) => CYRILLIC_TO_LATIN[ch] ?? CYRILLIC_TO_LATIN[ch.normalize("NFD")[0]] ?? ch);
}

/**
 * Any text to lowercase kebab-case ASCII: Cyrillic transliterated
 * ({@link transliterateCyrillic}), accents folded, the rest dropped; at most
 * `max` characters, never cut mid-dash; `x` when nothing is left.
 */
export function slugify(text: string, max = MAX_SLUG_CHARS): string {
  const slug = transliterateCyrillic(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, max).replace(/-+$/, "");
  return cut === "" ? "x" : cut;
}

export function makeClaimId(domain: string, entity: string, fact: string): string {
  const d = SLUG_RE.test(domain) ? domain : slugify(domain);
  return `${d}/${slugify(entity)}/${slugify(fact)}`;
}

export function parseClaimId(id: string): { domain: string; entity: string; fact: string } | null {
  if (!isClaimId(id)) return null;
  const [domain, entity, fact] = id.split("/");
  return { domain, entity, fact };
}

export interface ClaimLocation {
  page: string;
  claim: Claim;
}

export interface PageClaims {
  path: string;
  frontmatter: Pick<PageFrontmatter, "claims" | "retiredClaimIds">;
}

export interface ClaimIndex {
  /** Active id -> every place it appears (more than one = a collision). */
  active: Map<string, ClaimLocation[]>;
  /** Retired id -> the pages (or "ledger") that recorded the retirement. */
  retired: Map<string, string[]>;
}

/**
 * Build the vault-wide index. `ledgerRetired` is the state database's own list
 * of retired ids (see state-db.ts); a retirement found there but on no page
 * is attributed to `"ledger"`.
 */
export function buildClaimIndex(pages: Iterable<PageClaims>, ledgerRetired: Iterable<string> = []): ClaimIndex {
  const active = new Map<string, ClaimLocation[]>();
  const retired = new Map<string, string[]>();
  for (const page of pages) {
    for (const claim of page.frontmatter.claims) {
      const list = active.get(claim.id) ?? [];
      list.push({ page: page.path, claim });
      active.set(claim.id, list);
    }
    for (const id of page.frontmatter.retiredClaimIds) {
      const list = retired.get(id) ?? [];
      if (!list.includes(page.path)) list.push(page.path);
      retired.set(id, list);
    }
  }
  for (const id of ledgerRetired) {
    if (!retired.has(id)) retired.set(id, ["ledger"]);
  }
  return { active, retired };
}

/** Ids used by more than one claim, with where. */
export function claimCollisions(index: ClaimIndex): Array<{ id: string; locations: ClaimLocation[] }> {
  const out: Array<{ id: string; locations: ClaimLocation[] }> = [];
  for (const [id, locations] of index.active) if (locations.length > 1) out.push({ id, locations });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Active ids that are also retired somewhere. */
export function retiredReuse(index: ClaimIndex): Array<{ id: string; locations: ClaimLocation[]; retiredBy: string[] }> {
  const out: Array<{ id: string; locations: ClaimLocation[]; retiredBy: string[] }> = [];
  for (const [id, locations] of index.active) {
    const retiredBy = index.retired.get(id);
    if (retiredBy) out.push({ id, locations, retiredBy });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class ClaimIdError extends Error {
  constructor(
    readonly code: "invalid" | "taken" | "retired",
    readonly claimId: string,
    message: string,
  ) {
    super(message);
    this.name = "ClaimIdError";
  }
}

/**
 * May `id` be given to a NEW claim on `page`? Throws a {@link ClaimIdError}
 * naming the rule it breaks. A claim already on the same page with the same
 * id is an update, not a new claim, and is allowed.
 */
export function assertClaimIdAvailable(index: ClaimIndex, id: string, page: string): void {
  if (!isClaimId(id)) throw new ClaimIdError("invalid", id, `not a claim id: ${id}`);
  if (index.retired.has(id)) throw new ClaimIdError("retired", id, `claim id ${id} was retired and cannot be reused`);
  const where = index.active.get(id) ?? [];
  if (where.some((loc) => loc.page !== page)) {
    throw new ClaimIdError("taken", id, `claim id ${id} is already used on ${where[0].page}`);
  }
}

/**
 * An id for a new fact that does not collide with anything active or retired:
 * the plain id when free, else `-2`, `-3`, … on the fact slug. `usedOnPage`
 * holds the ids the page being built already gave out, so two facts that
 * slug alike on one page get distinct ids instead of a lint collision.
 */
export function allocateClaimId(
  index: ClaimIndex,
  domain: string,
  entity: string,
  fact: string,
  page: string,
  usedOnPage: ReadonlySet<string> = new Set(),
): string {
  const base = makeClaimId(domain, entity, fact);
  const free = (id: string) =>
    !usedOnPage.has(id) && !index.retired.has(id) && (index.active.get(id) ?? []).every((loc) => loc.page === page);
  if (free(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const parts = base.split("/");
    const suffix = `-${n}`;
    const fact2 = `${parts[2].slice(0, MAX_SLUG_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
    const candidate = `${parts[0]}/${parts[1]}/${fact2}`;
    if (free(candidate)) return candidate;
  }
  throw new ClaimIdError("taken", base, `no free claim id near ${base}`);
}

// ── one claim per fact ────────────────────────────────────────────────────

/** A claim's text as duplicates are told apart: Unicode-normalised, spacing and case folded, a closing stop dropped. */
export function claimTextKey(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[\s.;,]+$/u, "").toLowerCase();
}

/**
 * The fact a claim states, as duplicates are told apart: its text
 * ({@link claimTextKey}) and the time it holds for — same-worded facts of two
 * periods are two facts.
 */
export function claimFactKey(c: Pick<Claim, "text"> & Partial<Pick<Claim, "valid_from" | "valid_until" | "as_of" | "historical">>): string {
  return JSON.stringify([claimTextKey(c.text), c.valid_from ?? null, c.valid_until ?? null, c.as_of ?? null, !!c.historical]);
}

const evidenceKey = (e: Claim["evidence"][number]) => JSON.stringify([e.kind ?? null, e.path ?? null, e.sourceId ?? null, e.lines ?? null]);

export interface FoldedClaims {
  claims: Claim[];
  /** Each claim folded into another: its id and the id it lives on under. */
  folded: Array<{ id: string; into: string }>;
}

/**
 * One claim per fact on a page (pure): claims whose text reads the same
 * ({@link claimTextKey}) for the same dates are one. The first is kept — its
 * id, text, quote and status — with the higher confidence and the other
 * copies' evidence joined to its own (a second copy of a document is a second
 * source, never dropped). A verified claim is left as it is, neither kept
 * into nor folded away: that is its owner's to settle. `at` stamps a kept
 * claim that changed.
 */
export function foldDuplicateClaims(claims: readonly Claim[], at?: string): FoldedClaims {
  const out: Claim[] = [];
  const folded: FoldedClaims["folded"] = [];
  const firstOf = new Map<string, number>();
  for (const c of claims) {
    const key = claimFactKey(c);
    const slot = c.verified ? undefined : firstOf.get(key);
    const kept = slot === undefined ? undefined : out[slot];
    if (slot === undefined || !kept || kept.id === c.id) {
      if (!c.verified && !firstOf.has(key)) firstOf.set(key, out.length);
      out.push(c);
      continue;
    }
    const have = new Set(kept.evidence.map(evidenceKey));
    const evidence = [...kept.evidence, ...c.evidence.filter((e) => !have.has(evidenceKey(e)))];
    const confidence = Math.max(kept.confidence, c.confidence);
    if (evidence.length !== kept.evidence.length || confidence !== kept.confidence) {
      out[slot] = { ...kept, evidence, confidence, ...(at ? { updatedAt: at } : {}) };
    }
    folded.push({ id: c.id, into: kept.id });
  }
  return { claims: out, folded };
}

/** Current time as the ISO string every `updatedAt` uses. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Retire `ids` on one page's frontmatter (pure): the claims with those ids go,
 * and the ids that were actually ON this page are added to its
 * `retiredClaimIds` (an id this page never carried is the ledger's to
 * remember, not this page's). `keep` is an id that must NOT be retired even if
 * it is listed (the id a verification writes its replacement under).
 */
export function retireClaimsOnPage<T extends Pick<PageFrontmatter, "claims" | "retiredClaimIds">>(
  fm: T,
  ids: Iterable<string>,
  keep?: string,
): { frontmatter: T; removed: string[] } {
  const gone = new Set(ids);
  if (keep) gone.delete(keep);
  const removed = [...new Set(fm.claims.filter((c) => gone.has(c.id)).map((c) => c.id))].sort();
  const claims = fm.claims.filter((c) => !gone.has(c.id));
  const retiredIds = new Set(fm.retiredClaimIds);
  for (const id of removed) retiredIds.add(id);
  return { frontmatter: { ...fm, claims, retiredClaimIds: [...retiredIds].sort() }, removed };
}
