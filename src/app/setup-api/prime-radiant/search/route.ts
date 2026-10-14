/**
 * GET /setup-api/prime-radiant/search?q=…&limit=… — the vault through Memory
 * Shard's engine: every hit carries the page `path`, the page or claim `id`,
 * its `kind` and the page `type`, and verified pages and claims rank first.
 * Owner-only, like the rest of this family.
 *
 * A Memory Shard source, so it answers nothing — and starts no index — while
 * Memory Shard is switched off (`shardEnabled: false`).
 *
 * Never creates the vault. With a vault and no index yet (a box that had its
 * vault before this build), the first search starts a whole-vault index in the
 * background and answers `indexing: true` with no results.
 */
import { requireSession } from "@/lib/route-auth";
import { MEMORY_SEARCH_DEADLINE_MS } from "@/lib/memory-index-local";
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import { reindexPrimeRadiantVault, searchPrimeRadiant, vaultIndexStatus } from "@/lib/prime-radiant/shard-index";
import { vaultInitialised } from "@/lib/prime-radiant/vault";
import { fail, json } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;
const MAX_QUERY_CHARS = 1000;

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  if (!query) return fail("no_query", "What should it search for?", 400);
  if (query.length > MAX_QUERY_CHARS) return fail("query_too_long", `At most ${MAX_QUERY_CHARS} characters.`, 400);
  const asked = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(asked) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(asked))) : DEFAULT_LIMIT;

  try {
    const initialised = await vaultInitialised();
    const shardEnabled = await getMemoryShardEnabled();
    if (!initialised || !shardEnabled) {
      return json({ initialised, shardEnabled, indexing: false, results: [] });
    }
    const index = await vaultIndexStatus();
    // No index, one built for another embedder, or a run that did not finish:
    // a whole-vault run puts it right. Queued, never awaited — it coalesces with
    // any run already going.
    if (!index.exists || index.identity !== "valid" || index.needsFullScan) {
      void reindexPrimeRadiantVault().catch((err) => {
        console.warn(`[prime-radiant] vault index build did not finish: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // `needsFullScan` alone still answers: every run sets it while it works and
    // a capped vault keeps it for good, and each page is replaced in its own
    // transaction, so an unfinished run leaves some pages one commit behind —
    // never a half-written one. Withholding that would blank search after
    // every commit. The flag travels in `index` for a caller that cares.
    if (!index.exists || index.identity !== "valid") {
      return json({ initialised: true, shardEnabled: true, indexing: true, index, results: [] });
    }
    const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(MEMORY_SEARCH_DEADLINE_MS)]);
    const results = await searchPrimeRadiant(query, limit, deadline);
    return json({ initialised: true, shardEnabled: true, indexing: false, index, results });
  } catch (err) {
    console.warn(`[prime-radiant] search failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail("search_failed", "The vault could not be searched right now.", 503);
  }
}
