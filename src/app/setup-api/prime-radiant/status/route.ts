/**
 * GET /setup-api/prime-radiant/status — the vault (never created here; see
 * POST init), its git head, the memory-wiki wiring, a lint summary and the
 * vault search index's size against the owner's limit (`index`: used and
 * limit MB, chunks, capped pages; null when it cannot be read) and the golden
 * questions' accuracy (`golden`: how many, the latest % correct, its trend and
 * change — golden-score.ts `goldenStatus`; null when it cannot be read).
 * Owner-only.
 */
import { requireSession } from "@/lib/route-auth";
import { getStatus } from "@/lib/prime-radiant/service";
import { goldenStatus } from "@/lib/prime-radiant/golden-score";
import { vaultIndexStatus } from "@/lib/prime-radiant/shard-index";
import { BYTES_PER_MB } from "@/lib/prime-radiant/settings";
import { json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

/** MB to one decimal: what the settings' limit is in. */
function mb(bytes: number | undefined): number {
  return Math.round(((bytes ?? 0) / BYTES_PER_MB) * 10) / 10;
}

/** The search index as the status shows it. Never creates the store; null when it cannot be read. */
async function indexSummary() {
  try {
    const s = await vaultIndexStatus();
    return {
      exists: s.exists,
      usedMb: mb(s.usedBytes),
      limitMb: mb(s.limitBytes),
      chunks: s.chunks,
      maxChunks: s.maxChunks ?? null,
      pages: s.pages,
      cappedPages: s.cappedPages ?? null,
      withoutPageVector: s.withoutPageVector ?? null,
      needsFullScan: s.needsFullScan,
      migrationPending: s.migrationPending ?? false,
    };
  } catch (err) {
    console.warn(`[prime-radiant] status: the search index could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The golden questions' score as the status shows it. Never creates anything; null when it cannot be read. */
async function goldenSummary() {
  try {
    return await goldenStatus();
  } catch (err) {
    console.warn(`[prime-radiant] status: the golden score could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const [status, index, golden] = await Promise.all([getStatus(), indexSummary(), goldenSummary()]);
    return json({ ...status, index, golden });
  } catch (err) {
    return vaultFailure("status", err);
  }
}
