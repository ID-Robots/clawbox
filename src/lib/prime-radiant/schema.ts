/**
 * The page contract: what a Prime Radiant page's YAML frontmatter must say,
 * and the one validator that decides whether it does.
 *
 * Pure — no fs, no network — so the lint, the writer, the review queue and
 * any client-side preview reach the same verdict.
 *
 * Unknown keys are KEPT (memory-wiki writes its own, e.g. `id`, `pageType`,
 * `relationships`), never stripped: the validator checks the fields this
 * module owns and passes everything else through untouched.
 */

import { validityRange } from "./validity";

export const PAGE_TYPES = [
  "entity",
  "concept",
  "howto",
  "reference",
  "decision",
  "metric",
  "synthesis",
  "source",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_STATUSES = ["draft", "stable", "deprecated"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const PRIVACY_TIERS = ["public", "internal", "confidential", "secret-ref"] as const;
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];

export const CHECKED_BY = ["flash", "opus", "human"] as const;
export type CheckedBy = (typeof CHECKED_BY)[number];

export const CLAIM_STATUSES = ["proposed", "supported", "contested", "verified"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Who did something, and when (ISO 8601). */
export interface Stamp {
  at: string;
  by: string;
  /**
   * Who carried it out for them, when not they themselves: `assistant` on an
   * owner's verification the assistant made on the owner's word (verify.ts).
   */
  via?: string;
}

export interface ClaimEvidence {
  kind?: string;
  sourceId?: string;
  path?: string;
  lines?: string;
  note?: string;
  confidence?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface Claim {
  /** Global id, `<domain>/<entity-slug>/<fact-slug>` — see claims.ts. */
  id: string;
  text: string;
  /** 0..1 */
  confidence: number;
  status: ClaimStatus;
  /** ISO 8601 */
  updatedAt: string;
  evidence: ClaimEvidence[];
  /** Set by a verification (verify.ts): the owner's, the owner's via the assistant, or the assistant's own. */
  verified?: Stamp | null;
  /**
   * When the fact holds, when its source says so (validity.ts): from this ISO
   * date (or datetime) on, through that one. Either may be absent (open).
   */
  valid_from?: string | null;
  valid_until?: string | null;
  /** The day (or moment) the fact was true on: "as of 30.09". */
  as_of?: string | null;
  /** A past state of things ("the launch price was €399"): never paired with a current claim. */
  historical?: boolean;
  [key: string]: unknown;
}

/** A claim's dated fields, the ones validity.ts reads. */
export const CLAIM_DATE_FIELDS = ["valid_from", "valid_until", "as_of"] as const;

export interface PageFrontmatter {
  type: PageType;
  title: string;
  domain: string;
  owner: string;
  status: PageStatus;
  generated: Stamp;
  verified: Stamp | null;
  /** ISO date (YYYY-MM-DD) or datetime after which the page needs a re-check; null = never. */
  stale_after: string | null;
  sources: string[];
  privacy: PrivacyTier;
  checked_by: CheckedBy;
  opus_pending: boolean;
  claims: Claim[];
  retiredClaimIds: string[];
  /** The page this one is a version of (a draft of that final, a copy of that original): versions.ts never pairs their claims. */
  version_of?: string | null;
  /**
   * The day (or moment) the page's figures were true on. A metric page needs
   * it — or every claim its own — or the lint warns (`as-of-missing`); a value
   * that is no ISO date counts as none, it never makes the page invalid.
   */
  as_of?: unknown;
  [key: string]: unknown;
}

/** The order fields are written in; anything else follows in its original order. */
export const FRONTMATTER_KEY_ORDER = [
  "type",
  "title",
  "domain",
  "owner",
  "status",
  "generated",
  "verified",
  "stale_after",
  "sources",
  "privacy",
  "checked_by",
  "opus_pending",
  "claims",
  "retiredClaimIds",
] as const;

export interface SchemaError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; frontmatter: PageFrontmatter }
  | { ok: false; errors: SchemaError[] };

/** Lowercase kebab: `acme-widgets`, `q3-2026`. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Whether an ISO date's year, month and day are a day on the calendar: `Date.parse` takes "2026-02-30" for 2 March. */
export function isCalendarDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return false;
  const month = +m[2];
  const day = +m[3];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(+m[1], month, 0)).getUTCDate();
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ISO_DATE_RE.test(value) && !ISO_DATETIME_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value)) && isCalendarDay(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `{at, by}`, or the legacy one-line form `2026-01-31 by someone` that the
 * page contract was first written with. Anything else is null.
 */
export function parseStamp(value: unknown): Stamp | null {
  if (isPlainObject(value)) {
    const at = value.at;
    const by = value.by;
    if (!isIsoDate(at) || !nonEmptyString(by)) return null;
    return nonEmptyString(value.via) ? { at, by: by.trim(), via: value.via.trim() } : { at, by: by.trim() };
  }
  if (typeof value === "string") {
    const m = /^(\S+)\s+by\s+(.+)$/.exec(value.trim());
    if (m && isIsoDate(m[1]) && m[2].trim() !== "") return { at: m[1], by: m[2].trim() };
  }
  return null;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function validateClaim(raw: unknown, index: number, errors: SchemaError[]): Claim | null {
  const field = `claims[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push({ field, message: "a claim must be an object" });
    return null;
  }
  const before = errors.length;
  if (!nonEmptyString(raw.id)) errors.push({ field: `${field}.id`, message: "required" });
  if (!nonEmptyString(raw.text)) errors.push({ field: `${field}.text`, message: "required" });
  const confidence = raw.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push({ field: `${field}.confidence`, message: "must be a number between 0 and 1" });
  }
  if (!oneOf(CLAIM_STATUSES, raw.status)) {
    errors.push({ field: `${field}.status`, message: `must be one of ${CLAIM_STATUSES.join(", ")}` });
  }
  if (!isIsoDate(raw.updatedAt)) errors.push({ field: `${field}.updatedAt`, message: "must be an ISO date" });
  const evidence = raw.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every(isPlainObject)) {
    errors.push({ field: `${field}.evidence`, message: "must be a list of objects" });
  }
  let verified: Stamp | null | undefined;
  if (raw.verified !== undefined && raw.verified !== null) {
    verified = parseStamp(raw.verified);
    if (!verified) errors.push({ field: `${field}.verified`, message: "must be null or {at, by}" });
  } else if (raw.verified === null) {
    verified = null;
  }
  for (const key of CLAIM_DATE_FIELDS) {
    const value = raw[key];
    if (value !== undefined && value !== null && !isIsoDate(value)) errors.push({ field: `${field}.${key}`, message: "must be an ISO date or null" });
  }
  // Read as validity.ts reads a period: a bare day as "until" runs through that day's end.
  if (isIsoDate(raw.valid_from) && isIsoDate(raw.valid_until) && !validityRange({ from: raw.valid_from, until: raw.valid_until, source: "claim" })) {
    errors.push({ field: `${field}.valid_until`, message: "must not be before valid_from" });
  }
  if (raw.historical !== undefined && typeof raw.historical !== "boolean") errors.push({ field: `${field}.historical`, message: "must be true or false" });
  if (errors.length !== before) return null;
  const claim: Claim = {
    ...raw,
    id: (raw.id as string).trim(),
    text: (raw.text as string).trim(),
    confidence: confidence as number,
    status: raw.status as ClaimStatus,
    updatedAt: raw.updatedAt as string,
    evidence: evidence as ClaimEvidence[],
  };
  if (verified !== undefined) claim.verified = verified;
  else delete claim.verified;
  return claim;
}

/**
 * Check a parsed frontmatter object against the page contract.
 *
 * Defaults are filled only for the bookkeeping fields a page written by a
 * person may reasonably omit (`claims`, `retiredClaimIds`, `checked_by`,
 * `opus_pending`, `verified`, `stale_after`); every field the contract names
 * as REQUIRED must be there.
 */
export function validateFrontmatter(raw: unknown): ValidationResult {
  const errors: SchemaError[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: "", message: "frontmatter must be a YAML mapping" }] };
  }
  if (!oneOf(PAGE_TYPES, raw.type)) errors.push({ field: "type", message: `must be one of ${PAGE_TYPES.join(", ")}` });
  if (!nonEmptyString(raw.title)) errors.push({ field: "title", message: "required" });
  if (!nonEmptyString(raw.domain) || !SLUG_RE.test(raw.domain)) {
    errors.push({ field: "domain", message: "required, lowercase kebab-case" });
  }
  if (!nonEmptyString(raw.owner)) errors.push({ field: "owner", message: "required" });
  if (!oneOf(PAGE_STATUSES, raw.status)) {
    errors.push({ field: "status", message: `must be one of ${PAGE_STATUSES.join(", ")}` });
  }
  const generated = parseStamp(raw.generated);
  if (!generated) errors.push({ field: "generated", message: "required, {at, by}" });

  let verified: Stamp | null = null;
  if (raw.verified !== undefined && raw.verified !== null && raw.verified !== false) {
    verified = parseStamp(raw.verified);
    if (!verified) errors.push({ field: "verified", message: "must be null or {at, by}" });
  }

  let staleAfter: string | null = null;
  if (raw.stale_after !== undefined && raw.stale_after !== null) {
    if (isIsoDate(raw.stale_after)) staleAfter = raw.stale_after;
    else errors.push({ field: "stale_after", message: "must be an ISO date or null" });
  }

  if (raw.sources === undefined) {
    errors.push({ field: "sources", message: "required (may be an empty list)" });
  } else if (!Array.isArray(raw.sources) || !raw.sources.every(nonEmptyString)) {
    errors.push({ field: "sources", message: "must be a list of strings" });
  }
  if (!oneOf(PRIVACY_TIERS, raw.privacy)) {
    errors.push({ field: "privacy", message: `must be one of ${PRIVACY_TIERS.join(", ")}` });
  }

  const checkedBy = raw.checked_by ?? "flash";
  if (!oneOf(CHECKED_BY, checkedBy)) errors.push({ field: "checked_by", message: `must be one of ${CHECKED_BY.join(", ")}` });
  const opusPending = raw.opus_pending ?? false;
  if (typeof opusPending !== "boolean") errors.push({ field: "opus_pending", message: "must be true or false" });

  const claims: Claim[] = [];
  const rawClaims = raw.claims ?? [];
  if (!Array.isArray(rawClaims)) {
    errors.push({ field: "claims", message: "must be a list" });
  } else {
    rawClaims.forEach((c, i) => {
      const claim = validateClaim(c, i, errors);
      if (claim) claims.push(claim);
    });
  }
  const retired = raw.retiredClaimIds ?? [];
  if (!Array.isArray(retired) || !retired.every(nonEmptyString)) {
    errors.push({ field: "retiredClaimIds", message: "must be a list of claim ids" });
  }
  if (raw.version_of !== undefined && raw.version_of !== null && !nonEmptyString(raw.version_of)) {
    errors.push({ field: "version_of", message: "must be a page path or null" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    frontmatter: {
      ...raw,
      type: raw.type as PageType,
      title: (raw.title as string).trim(),
      domain: raw.domain as string,
      owner: (raw.owner as string).trim(),
      status: raw.status as PageStatus,
      generated: generated as Stamp,
      verified,
      stale_after: staleAfter,
      sources: (raw.sources as string[]).map((s) => s.trim()),
      privacy: raw.privacy as PrivacyTier,
      checked_by: checkedBy as CheckedBy,
      opus_pending: opusPending as boolean,
      claims,
      retiredClaimIds: [...new Set((retired as string[]).map((s) => s.trim()))],
    },
  };
}

/** Who the assistant's own verification stamps name (route-helpers.ts's writer `by`). */
export const ASSISTANT_VERIFIER = "assistant";
/** Who an owner's verification stamps name, also one the assistant made on the owner's word. */
export const OWNER_VERIFIER = "owner";
/** The `via` of an owner's verification the assistant carried out: `{ by: owner, via: assistant }`. */
export const VIA_ASSISTANT = "assistant";

/** Whether a stamp is a person's: every verifier but the assistant. */
function personsStamp(stamp: Stamp | null | undefined): boolean {
  return !!stamp && stamp.by !== ASSISTANT_VERIFIER;
}

/** The owner's verification, given through the assistant (the user confirmed the fact in their own words). */
export function verifiedViaAssistant(stamp: Stamp | null | undefined): boolean {
  return personsStamp(stamp) && stamp?.via === VIA_ASSISTANT;
}

/**
 * Who a verification stamp says verified, as the app words it: the owner
 * (also through the assistant), the assistant on its own, or the stamp's own
 * name for anyone else (a legacy or hand-written stamp).
 */
export function verifierKind(stamp: Pick<Stamp, "by" | "via">): "owner" | "owner-via-assistant" | "assistant" | "other" {
  if (stamp.by === ASSISTANT_VERIFIER) return "assistant";
  if (stamp.by !== OWNER_VERIFIER) return "other";
  return stamp.via === VIA_ASSISTANT ? "owner-via-assistant" : "owner";
}

/**
 * Whether a claim is OWNER-verified: a person's verification stamp on it —
 * the owner's own, or the owner's given through the assistant
 * (`{ by: owner, via: assistant }`) — or `status: verified` with no stamp (a
 * person's hand edit), or a page a person verified as a whole. The
 * assistant's own stamps (`by: assistant`) verify nothing here.
 */
export function ownerVerified(claim: Pick<Claim, "verified" | "status">, page?: Pick<PageFrontmatter, "verified"> | null): boolean {
  if (claim.verified) return personsStamp(claim.verified);
  return claim.status === "verified" || personsStamp(page?.verified);
}

/** True when the page itself or any claim on it carries a human verification. */
export function hasVerification(fm: Pick<PageFrontmatter, "verified" | "claims">): boolean {
  if (fm.verified) return true;
  return fm.claims.some((c) => !!c.verified);
}

/**
 * The vault folder a page of this type lives in. memory-wiki's own layout
 * knows entities/, concepts/, syntheses/ and sources/; every other type is a
 * concept to the plugin.
 */
export function folderForType(type: PageType): string {
  switch (type) {
    case "entity":
      return "entities";
    case "synthesis":
      return "syntheses";
    case "source":
      return "sources";
    default:
      return "concepts";
  }
}
