/**
 * The one-shot repair of a vault written before pages kept one claim per
 * fact: the same fact filed twice on a page — the ingest gave a repeated
 * fact a `-2` id, a merge brought a second copy of a document's claims along
 * — becomes one claim, the first kept with the other copies' sources joined
 * to its evidence and the higher confidence (claims.ts `foldDuplicateClaims`).
 * A verified claim, and a page verified as a whole, are left as they are.
 *
 * Idempotent: a vault with nothing to fold writes nothing. Written in commits
 * of {@link FOLD_BATCH} pages, `claims: fold …`, each one Undo reverses; a
 * folded claim is removed, not retired, so the undo can bring it back. The
 * review items still waiting on a folded claim are closed (the question lives
 * on under the kept one, and the next night asks it there).
 *
 * SERVER ONLY.
 */

import { foldDuplicateClaims, nowIso } from "./claims";
import { closeFoldedItems } from "./edit";
import type { VaultAuthor } from "./git";
import { vaultDir } from "./paths";
import type { PageFrontmatter } from "./schema";
import { syncActiveClaims } from "./state-db";
import { readVaultSnapshot, vaultOperation, type VaultSnapshot } from "./vault";

/** Pages one commit folds. */
export const FOLD_BATCH = 50;

export interface ClaimFold {
  page: string;
  /** The claim folded away, and the one it lives on under. */
  id: string;
  into: string;
}

export interface FoldDuplicateClaimsResult {
  dryRun: boolean;
  commits: string[];
  /** Pages with a claim folded (with `dryRun`, that would have one). */
  pages: string[];
  folds: ClaimFold[];
  /** Pages verified as a whole that hold the same fact twice: the owner's to settle. */
  skipped: string[];
}

interface PageFold {
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  folds: ClaimFold[];
}

/** Every page that holds the same fact twice, folded (pure). */
export function planClaimFolds(snapshot: VaultSnapshot, at: string): { writes: PageFold[]; skipped: string[] } {
  const writes: PageFold[] = [];
  const skipped: string[] = [];
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    const r = foldDuplicateClaims(fm.claims, at);
    if (r.folded.length === 0) continue;
    if (fm.verified) {
      skipped.push(p.path);
      continue;
    }
    writes.push({ path: p.path, frontmatter: { ...fm, claims: r.claims }, body: p.parsed.body, folds: r.folded.map((f) => ({ page: p.path, ...f })) });
  }
  return { writes, skipped };
}

/** Fold the vault's duplicate claims (see the header). `dryRun` answers the same without writing anything. */
export async function foldDuplicateClaimsInVault(
  options: { dryRun?: boolean; vault?: string; author?: VaultAuthor; now?: Date; by?: string } = {},
): Promise<FoldDuplicateClaimsResult> {
  const vault = options.vault ?? vaultDir();
  const at = nowIso(options.now);
  if (options.dryRun) {
    const plan = planClaimFolds(await readVaultSnapshot(vault), at);
    return { dryRun: true, commits: [], pages: plan.writes.map((w) => w.path), folds: plan.writes.flatMap((w) => w.folds), skipped: plan.skipped };
  }
  const result: FoldDuplicateClaimsResult = { dryRun: false, commits: [], pages: [], folds: [], skipped: [] };
  for (;;) {
    const op = await vaultOperation(
      (batch: { writes: PageFold[] }) => {
        const n = batch.writes.reduce((sum, w) => sum + w.folds.length, 0);
        return `claims: fold ${n} duplicate claim${n === 1 ? "" : "s"} on ${batch.writes.length} page${batch.writes.length === 1 ? "" : "s"}`;
      },
      async (tx) => {
        const plan = planClaimFolds(await tx.snapshot(), at);
        const writes = plan.writes.slice(0, FOLD_BATCH);
        for (const w of writes) await tx.writePage(w.path, w.frontmatter, w.body);
        return { writes, skipped: plan.skipped, more: plan.writes.length > writes.length };
      },
      { vault, now: options.now, author: options.author },
    );
    const { writes, skipped, more } = op.result;
    result.skipped = skipped;
    // Nothing to fold, or a batch that changed nothing: done (never a loop on the same pages).
    if (writes.length === 0 || !op.commit) break;
    result.commits.push(op.commit);
    result.pages.push(...writes.map((w) => w.path));
    result.folds.push(...writes.flatMap((w) => w.folds));
    closeFoldedItems(vault, writes.flatMap((w) => w.folds), options.by ?? "owner", at);
    try {
      syncActiveClaims(vault, writes.flatMap((w) => w.frontmatter.claims.map((c) => ({ id: c.id, page: w.path, updatedAt: c.updatedAt }))));
    } catch {
      // The ledger is a second copy; the pages hold the claims.
    }
    if (!more) break;
  }
  return result;
}
