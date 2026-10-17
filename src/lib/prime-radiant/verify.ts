/**
 * Verification: a person settles a fact.
 *
 * A verification REPLACES the claim — it does not add a second opinion beside
 * it. In ONE vault operation (one commit, `verify: <claimId>`):
 *
 *   - the claim `claimId` on its page becomes the verified text, with
 *     `status: verified`, `confidence: 1`, `verified: {at, by}` and a
 *     human-verification line in its evidence; the page's `checked_by`
 *     becomes `human`;
 *   - every LOSING id (`retire`) is removed from every page that carries it
 *     and listed in that page's `retiredClaimIds` — and in the ledger, so the
 *     id can never be reused, also when no page carried it;
 *   - a second copy of `claimId` on another page (a collision) is removed
 *     there without being retired: the id lives on, on its page.
 *
 * A claim id that is on no page yet is written to `page` (the caller names
 * where a new answer goes), provided the id was never retired.
 *
 * An OWNER-verified claim wins ({@link ownerVerified}): a claim on another
 * page that the judge finds against it is no question for the owner (the
 * owner already answered) but a STALE note on that page
 * ({@link recordStaleClaims}), which the lint reports as a warning until the
 * claim is rewritten or gone. The assistant's verifications (stamped
 * `assistant`) settle a fact for the record, not for the owner: they win
 * nothing here.
 *
 * SERVER ONLY.
 */

import { buildClaimIndex, isClaimId, nowIso, retireClaimsOnPage } from "./claims";
import type { VaultAuthor } from "./git";
import { safePagePath, vaultDir } from "./paths";
import type { Claim, ClaimEvidence, PageFrontmatter, Stamp } from "./schema";
import { readRetiredLedger, recordRetired, runInTransaction, stateDbExists, withStateDb } from "./state-db";
import { vaultOperation, type VaultOperationResult } from "./vault";

/** Who the assistant's verification stamps name (route-helpers.ts's writer `by`). */
export const ASSISTANT_VERIFIER = "assistant";

/** Whether a stamp is a person's: every verifier but the assistant. */
function personsStamp(stamp: Stamp | null | undefined): boolean {
  return !!stamp && stamp.by !== ASSISTANT_VERIFIER;
}

/**
 * Whether a claim is OWNER-verified: a person's verification stamp on it, or
 * `status: verified` with no stamp (a person's hand edit), or a page a person
 * verified as a whole.
 */
export function ownerVerified(claim: Pick<Claim, "verified" | "status">, page?: Pick<PageFrontmatter, "verified"> | null): boolean {
  if (claim.verified) return personsStamp(claim.verified);
  return claim.status === "verified" || personsStamp(page?.verified);
}

/** A claim the judge found against an owner-verified one: the verified one wins, this one is stale. */
export interface StaleClaimNote {
  claimId: string;
  page: string;
  verifiedClaimId: string;
  verifiedPage: string;
  /** The judge's few words, when it gave them. */
  why: string;
  at: string;
}

/** Record stale notes (one per claim and verified claim; a repeat refreshes it). Answers how many were written. */
export function recordStaleClaims(vault: string, notes: readonly StaleClaimNote[]): number {
  if (notes.length === 0) return 0;
  return withStateDb(vault, (db) => {
    const stmt = db.prepare(
      `INSERT INTO stale_claims (claim_id, page, verified_claim_id, verified_page, why, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_id, verified_claim_id) DO UPDATE SET page = excluded.page, verified_page = excluded.verified_page, why = excluded.why, at = excluded.at`,
    );
    runInTransaction(db, () => {
      for (const n of notes) stmt.run(n.claimId, n.page, n.verifiedClaimId, n.verifiedPage, n.why.slice(0, 200), n.at);
    });
    return notes.length;
  });
}

/** Every stale note. Never creates the database. */
export function readStaleClaims(vault: string): StaleClaimNote[] {
  if (!stateDbExists(vault)) return [];
  return withStateDb(vault, (db) =>
    (
      db.prepare("SELECT claim_id, page, verified_claim_id, verified_page, why, at FROM stale_claims ORDER BY page, claim_id").all() as Array<{
        claim_id: string;
        page: string;
        verified_claim_id: string;
        verified_page: string;
        why: string | null;
        at: string;
      }>
    ).map((r) => ({ claimId: r.claim_id, page: r.page, verifiedClaimId: r.verified_claim_id, verifiedPage: r.verified_page, why: r.why ?? "", at: r.at })),
  );
}

/** A verified claim is one line a person read: the lint's claim limit. */
export const MAX_VERIFIED_TEXT = 240;
export const MAX_RETIRE = 20;

export class VerifyError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "retired" | "no_page",
    message: string,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface VerifyInput {
  claimId: string;
  text: string;
  /** Who verified, as the stamp records it. */
  by: string;
  /** Losing claim ids, retired everywhere. */
  retire?: readonly string[];
  /** Where the claim goes when no page carries it yet. */
  page?: string | null;
  /** Evidence kept with the verified claim (e.g. the picked candidate's). */
  evidence?: readonly ClaimEvidence[];
  note?: string;
  /** Who the commit names as its author (the assistant's verifications name it). */
  author?: VaultAuthor;
  /**
   * Whether a person gave this verification. Default true: the page's
   * `checked_by` becomes `human`. The assistant's verification leaves it as it
   * was — the stamp says who verified, and `checked_by` is not a lie.
   */
  person?: boolean;
  vault?: string;
  now?: Date;
}

export interface VerifyResult {
  claimId: string;
  page: string;
  /** Ids retired by this verification (whether or not a page still carried them). */
  retired: string[];
  /** Pages the operation changed. */
  changed: string[];
  commit: string | null;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

export function cleanVerifiedText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return t === "" || t.length > MAX_VERIFIED_TEXT ? null : t;
}

function ledger(vault: string): string[] {
  try {
    return readRetiredLedger(vault);
  } catch {
    return [];
  }
}

export async function verifyClaim(input: VerifyInput): Promise<VerifyResult> {
  const vault = input.vault ?? vaultDir();
  const claimId = input.claimId;
  if (!isClaimId(claimId)) throw new VerifyError("invalid", "That is not a claim id.");
  const text = cleanVerifiedText(input.text);
  if (!text) throw new VerifyError("invalid", `A verified fact is one line of 1 to ${MAX_VERIFIED_TEXT} characters.`);
  const retire = [...new Set(input.retire ?? [])].filter((id) => id !== claimId);
  if (retire.length > MAX_RETIRE || !retire.every(isClaimId)) throw new VerifyError("invalid", "The ids to retire are not claim ids.");
  const by = (input.by || "owner").replace(CONTROL_RE, " ").trim().slice(0, 80) || "owner";
  const stamp = nowIso(input.now);
  const asked = input.page == null ? null : safePagePath(input.page);
  if (input.page != null && !asked) throw new VerifyError("invalid", "That is not a page path.");

  const op: VaultOperationResult<{ page: string }> = await vaultOperation(
    `verify: ${claimId}`,
    async (tx) => {
      // Read under the lock: what the commit changes is what is on disk now.
      const snapshot = await tx.snapshot();
      const valid = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, frontmatter: p.parsed.frontmatter, body: p.parsed.body }] : []));
      const index = buildClaimIndex(valid, ledger(tx.vault));
      if (index.retired.has(claimId)) throw new VerifyError("retired", `The claim id ${claimId} was retired and cannot be verified again.`);
      const holders = index.active.get(claimId) ?? [];
      const target = asked && holders.some((h) => h.page === asked) ? asked : (holders[0]?.page ?? asked);
      if (!target) throw new VerifyError("not_found", `No page carries ${claimId}; name the page the fact belongs on.`);
      const targetPage = valid.find((p) => p.path === target);
      if (!targetPage) throw new VerifyError("no_page", `There is no valid page at ${target}.`);

      const retireSet = new Set(retire);
      for (const page of valid) {
        const isTarget = page.path === target;
        const carries = page.frontmatter.claims.some((c) => retireSet.has(c.id) || (!isTarget && c.id === claimId));
        if (!carries && !isTarget) continue;
        let fm: PageFrontmatter = page.frontmatter;
        if (!isTarget) fm = { ...fm, claims: fm.claims.filter((c) => c.id !== claimId) };
        fm = retireClaimsOnPage(fm, retireSet).frontmatter;
        if (isTarget) {
          const previous = page.frontmatter.claims.find((c) => c.id === claimId);
          const evidence: ClaimEvidence[] = [
            ...(input.evidence ?? []).slice(0, 10),
            { kind: "human-verification", note: (input.note ?? `verified by ${by}`).replace(CONTROL_RE, " ").slice(0, 200), updatedAt: stamp },
          ];
          const verified: Claim = {
            ...(previous ?? {}),
            id: claimId,
            text,
            confidence: 1,
            status: "verified",
            updatedAt: stamp,
            evidence,
            verified: { at: stamp, by },
          };
          const at = fm.claims.findIndex((c) => c.id === claimId);
          const claims = [...fm.claims];
          if (at >= 0) claims[at] = verified;
          else claims.push(verified);
          fm = { ...fm, claims, ...(input.person === false ? {} : { checked_by: "human" as const }) };
        }
        await tx.writePage(page.path, fm, page.body);
      }
      return { page: target };
    },
    { vault, now: input.now, author: input.author },
  );

  // Every losing id is retired in the ledger, also one no page carried: the
  // vault operation records the ids pages list, this records the rest.
  if (retire.length > 0) {
    try {
      recordRetired(vault, retire.map((id) => ({ id, page: op.result.page })), stamp);
    } catch {
      // The pages record what they carried; the ledger is the second copy.
    }
  }
  return { claimId, page: op.result.page, retired: retire, changed: op.changed, commit: op.commit };
}
