/**
 * Verification: a person settles a fact.
 *
 * A verification REPLACES the claim — it does not add a second opinion beside
 * it. In ONE vault operation (one commit, `verify: <claimId>`):
 *
 *   - the claim `claimId` on its page becomes the verified text, with
 *     `status: verified`, `confidence: 1`, `verified: {at, by}` and a
 *     human-verification line in its evidence (an `assistant-verification`
 *     line for the assistant's own, unconfirmed one); the page's `checked_by`
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
 * claim is rewritten or gone. A verification the assistant made on the
 * owner's word (the MCP tools' `confirm: true`: the user confirmed the fact
 * in their own words) is the owner's — stamped `{ by: owner, via: assistant }`
 * — and wins exactly like one made in the app. The assistant's own
 * verifications (stamped `assistant`) settle a fact for the record, not for
 * the owner: they win nothing here.
 *
 * The commit carries who verified as its trailers (`Verified-by`,
 * `Verified-via`; git.ts `verifiedTrailers`), so History says it.
 *
 * SERVER ONLY.
 */

import { buildClaimIndex, isClaimId, nowIso, retireClaimsOnPage } from "./claims";
import { verifiedTrailers, type VaultAuthor } from "./git";
import { safePagePath, vaultDir } from "./paths";
import { ASSISTANT_VERIFIER, OWNER_VERIFIER, VIA_ASSISTANT, type Claim, type ClaimEvidence, type PageFrontmatter } from "./schema";
import { readRetiredLedger, recordRetired, runInTransaction, stateDbExists, withStateDb } from "./state-db";
import { readVaultSnapshot, vaultOperation, type VaultOperationResult, type VaultSnapshot } from "./vault";

// Who counts as the owner is the page contract's (pure, so the lint reads it too).
export { ASSISTANT_VERIFIER, OWNER_VERIFIER, ownerVerified, VIA_ASSISTANT, verifiedViaAssistant } from "./schema";

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

/** Stale notes follow renamed pages (rename.ts): old path -> new path, on either side. Answers how many rows moved. */
export function followMovedStaleNotes(vault: string, moved: ReadonlyMap<string, string>): number {
  if (moved.size === 0 || !stateDbExists(vault)) return 0;
  return withStateDb(vault, (db) => {
    const page = db.prepare("UPDATE stale_claims SET page = ? WHERE page = ?");
    const verifiedPage = db.prepare("UPDATE stale_claims SET verified_page = ? WHERE verified_page = ?");
    let n = 0;
    runInTransaction(db, () => {
      for (const [from, to] of moved) {
        n += Number(page.run(to, from).changes) + Number(verifiedPage.run(to, from).changes);
      }
    });
    return n;
  });
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
  /** Who carried it out for them (`assistant`: the owner's word, given through the assistant). */
  via?: string;
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
  const via = (input.via ?? "").replace(CONTROL_RE, " ").trim().slice(0, 80);
  const who = via ? `${by} via ${via}` : by;
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
            {
              // The assistant's OWN verification (no owner's word behind it) is no human's: the
              // migration below upgrades only stamps a human-verification line backs.
              kind: by === ASSISTANT_VERIFIER && !via ? "assistant-verification" : "human-verification",
              note: (input.note ?? `verified by ${who}`).replace(CONTROL_RE, " ").slice(0, 200),
              updatedAt: stamp,
            },
          ];
          const verified: Claim = {
            ...(previous ?? {}),
            id: claimId,
            text,
            confidence: 1,
            status: "verified",
            updatedAt: stamp,
            evidence,
            verified: via ? { at: stamp, by, via } : { at: stamp, by },
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
    { vault, now: input.now, author: input.author, trailers: verifiedTrailers(via ? { by, via } : { by }) },
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

// ── the one-off migration: the assistant's confirmed verifications are the owner's ──

/** A claim the migration upgrades, and where. */
export interface UpgradedVerification {
  claimId: string;
  page: string;
}

export interface UpgradeAssistantVerificationsResult {
  dryRun: boolean;
  commit: string | null;
  /** Claims whose `verified: { by: assistant }` became `{ by: owner, via: assistant }`. */
  upgraded: UpgradedVerification[];
  /** Pages they are on (each now `checked_by: human`). */
  pages: string[];
  /** Assistant stamps left as they were: no human-verification evidence line says the owner's word was behind them. */
  skipped: UpgradedVerification[];
}

const ASSISTANT_NOTE_RE = /^verified by assistant\b/;

/**
 * Whether a claim carries the assistant's OWN verification stamp from before
 * owner confirmations were stamped as the owner's: `by: assistant`, no `via`.
 */
function assistantStamped(c: Claim): boolean {
  return !!c.verified && c.verified.by === ASSISTANT_VERIFIER && !c.verified.via;
}

/**
 * The migration worked out over a snapshot (pure): every claim stamped
 * `verified: { by: assistant }` that carries a `human-verification` evidence
 * line — the line verify.ts wrote for every verification before the
 * assistant's own were told apart, which the MCP tools only gave with the
 * user's own confirmation (`confirm: true`); an unconfirmed one made since
 * carries `assistant-verification` instead and stays as it is — gets
 * `{ by: owner, via: assistant }`, its moment kept, and that line's note says
 * so; its page becomes `checked_by: human`, as a verification in the app makes
 * it. A stamp with no such line is left as it is and listed in `skipped`.
 * Answers the pages to write.
 */
export function planAssistantVerificationUpgrade(snapshot: Pick<VaultSnapshot, "pages">): {
  writes: Array<{ path: string; frontmatter: PageFrontmatter; body: string }>;
  upgraded: UpgradedVerification[];
  skipped: UpgradedVerification[];
} {
  const writes: Array<{ path: string; frontmatter: PageFrontmatter; body: string }> = [];
  const upgraded: UpgradedVerification[] = [];
  const skipped: UpgradedVerification[] = [];
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    let changed = false;
    const claims = fm.claims.map((c) => {
      if (!assistantStamped(c) || !c.verified) return c;
      if (!c.evidence.some((e) => e.kind === "human-verification")) {
        skipped.push({ claimId: c.id, page: p.path });
        return c;
      }
      changed = true;
      upgraded.push({ claimId: c.id, page: p.path });
      const evidence = c.evidence.map((e) =>
        e.kind === "human-verification" && typeof e.note === "string" && ASSISTANT_NOTE_RE.test(e.note)
          ? { ...e, note: e.note.replace(ASSISTANT_NOTE_RE, `verified by ${OWNER_VERIFIER} via ${VIA_ASSISTANT}`).slice(0, 200) }
          : e,
      );
      return { ...c, evidence, verified: { at: c.verified.at, by: OWNER_VERIFIER, via: VIA_ASSISTANT } };
    });
    if (changed) writes.push({ path: p.path, frontmatter: { ...fm, claims, checked_by: "human" }, body: p.parsed.body });
  }
  return { writes, upgraded, skipped };
}

/**
 * The maintenance route's `upgrade-assistant-verifications` (owner only, run
 * once): {@link planAssistantVerificationUpgrade} as ONE commit
 * `migrate: N assistant verifications -> owner via the assistant` (trailers
 * `Verified-by: owner`, `Verified-via: assistant`), which Undo reverses whole;
 * none when nothing is left to upgrade, so a second run changes nothing.
 * `dryRun` answers the same and writes nothing — run it first. Contradiction
 * items waiting on an upgraded claim are not touched here: the
 * `rejudge-reviews` pass settles them now that one side is owner-verified.
 */
export async function upgradeAssistantVerifications(
  options: { dryRun?: boolean; vault?: string; author?: VaultAuthor; now?: Date } = {},
): Promise<UpgradeAssistantVerificationsResult> {
  const vault = options.vault ?? vaultDir();
  const pagesOf = (u: UpgradedVerification[]) => [...new Set(u.map((x) => x.page))].sort();
  if (options.dryRun) {
    const plan = planAssistantVerificationUpgrade(await readVaultSnapshot(vault));
    return { dryRun: true, commit: null, upgraded: plan.upgraded, pages: pagesOf(plan.upgraded), skipped: plan.skipped };
  }
  const op = await vaultOperation(
    (plan: ReturnType<typeof planAssistantVerificationUpgrade>) =>
      `migrate: ${plan.upgraded.length} assistant verification${plan.upgraded.length === 1 ? "" : "s"} -> owner via the assistant`,
    async (tx) => {
      const plan = planAssistantVerificationUpgrade(await tx.snapshot());
      for (const w of plan.writes) await tx.writePage(w.path, w.frontmatter, w.body);
      return plan;
    },
    { vault, now: options.now, author: options.author, trailers: verifiedTrailers({ by: OWNER_VERIFIER, via: VIA_ASSISTANT }) },
  );
  return { dryRun: false, commit: op.commit, upgraded: op.result.upgraded, pages: pagesOf(op.result.upgraded), skipped: op.result.skipped };
}
