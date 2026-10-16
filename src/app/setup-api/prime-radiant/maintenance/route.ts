/**
 * /setup-api/prime-radiant/maintenance — owner-run whole-vault passes.
 *
 * POST `{ action, dryRun? }`:
 *  - `rejudge-reviews`: close the OPEN contradiction items whose two sides
 *    carry different identifiers (waybills, invoices, transfers, dates), with
 *    the note "auto: different subjects (identifier filter)". Nothing else is
 *    closed. Answers the result. `dryRun: true` only counts.
 *  - `reindex`: start a whole-vault search reindex (every page on `main`,
 *    vectors at 1,024-d); `GET status` follows it (`index.needsFullScan`
 *    clears when it finishes uncapped).
 *  - `connect`: the connect pass (connect.ts) — entity links, new entity
 *    pages, related pages, dated hubs — written in commits.
 *  - `migrate-frontmatter`: write memory-wiki's fields (id, pageType,
 *    sourceIds, updatedAt) into every page that lacks them.
 * `reindex`, `connect` and `migrate-frontmatter` run on in the background:
 * 202 `{ started: true }`; 409 `busy` while one runs. A `dryRun` answers its
 * counts at once.
 *
 * GET → `{ running, last: { [action]: result | { error } } }`.
 *
 * OWNER ONLY (POST: cookie AND same origin) — but the assistant, through the
 * MCP bearer, may run `connect` (the owner's "run the connect pass now"). The
 * other three stay the owner's: a reindex re-embeds the whole vault, and the
 * rejudge and the migration are repairs. 412 `not_initialised` before the
 * vault exists; 400 `invalid` for an unknown action.
 */
import { processStore } from "@/lib/process-store";
import { requireSession } from "@/lib/route-auth";
import { runConnectPass } from "@/lib/prime-radiant/connect";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { migratePluginFrontmatter } from "@/lib/prime-radiant/plugin-compat";
import { readPageVectors, reindexPrimeRadiantVault, vaultIndexingAllowed } from "@/lib/prime-radiant/shard-index";
import { rejudgeOpenContradictions } from "@/lib/prime-radiant/rejudge";
import { fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";
import type { VaultAuthor } from "@/lib/prime-radiant/git";
import { readVaultSnapshot, vaultInitialised, vaultOperation, type VaultTx } from "@/lib/prime-radiant/vault";

export const dynamic = "force-dynamic";

const state = processStore("prime-radiant:maintenance", () => ({ running: null as string | null, last: {} as Record<string, unknown> }));

/** Commits for a pass, authored by whoever started it (the assistant's connect pass names it). */
function commitWith(vault: string, author: VaultAuthor) {
  return async (message: string, fn: (tx: VaultTx) => Promise<void>) => {
    const { commit } = await vaultOperation(message, fn, { vault, author });
    return { commit };
  };
}

function background(action: string, work: () => Promise<unknown>) {
  state.running = action;
  void work()
    .then((result) => {
      state.last[action] = { ...(result && typeof result === "object" ? result : { result }), finishedAt: new Date().toISOString() };
    })
    .catch((err) => {
      console.warn(`[prime-radiant] maintenance ${action} did not finish: ${err instanceof Error ? err.message : err}`);
      state.last[action] = { error: err instanceof Error ? err.message.slice(0, 300) : "error", finishedAt: new Date().toISOString() };
    })
    .finally(() => {
      state.running = null;
    });
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json({ running: state.running, last: state.last });
}

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Running a vault maintenance pass");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { action?: unknown; dryRun?: unknown };
  if (!gate.writer.person && b.action !== "connect") {
    return fail("owner_only", "Only the owner can run that maintenance pass; the assistant may run the connect pass.", 403);
  }
  if (!(await vaultInitialised())) return fail("not_initialised", "Open Prime Radiant once to create its vault first.", 412);
  const dryRun = b.dryRun === true;
  const vault = vaultDir();
  const busy = () => json({ error: "A maintenance pass is already running.", code: "busy", running: state.running }, 409);
  try {
    switch (b.action) {
      case "rejudge-reviews":
        return json(rejudgeOpenContradictions(vault, await readVaultSnapshot(vault), { dryRun }));
      case "reindex": {
        if (!(await vaultIndexingAllowed())) return fail("shard_off", "Switch Memory Shard on to index the vault.", 409);
        if (state.running) return busy();
        background("reindex", () => reindexPrimeRadiantVault());
        return json({ started: true }, 202);
      }
      case "connect": {
        if (state.running) return busy();
        if (dryRun) return json(await runConnectPass(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { dryRun, vectors: await readPageVectors(vault) }));
        background("connect", async () => runConnectPass(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { vectors: await readPageVectors(vault) }));
        return json({ started: true }, 202);
      }
      case "migrate-frontmatter": {
        if (state.running) return busy();
        if (dryRun) return json(await migratePluginFrontmatter(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { dryRun }));
        background("migrate-frontmatter", async () => migratePluginFrontmatter(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author)));
        return json({ started: true }, 202);
      }
      default:
        return fail("invalid", "Unknown action.", 400);
    }
  } catch (err) {
    return vaultFailure(`maintenance ${String(b.action).slice(0, 40)}`, err);
  }
}
