/**
 * /setup-api/prime-radiant/maintenance — owner-run whole-vault passes.
 *
 * POST `{ action, dryRun? }`:
 *  - `rejudge-reviews`: re-run every OPEN contradiction item through today's
 *    pairing rules (rejudge.ts) and close the ones that no longer qualify,
 *    each with a note saying why: "different subjects" (identifiers, records,
 *    or subjects once template words are out), "superseded" (an old fact
 *    against the current one), "same document: draft vs final", or "verified
 *    claim wins" (the other side becomes a stale note on its page). Items the
 *    owner settled are never touched; an item with both sides owner-verified
 *    stays open. Answers the result with its counts per reason (`byReason`,
 *    `summary`). `dryRun: true` only counts — run it first.
 *  - `version-groups`: list the pages that are versions of one document (a
 *    draft and its final, a copy and its original; versions.ts), the version
 *    kept first. Read only: merge them with the page merge if you like.
 *  - `reindex`: start a whole-vault search reindex (every page on `main`,
 *    vectors at 1,024-d); `GET status` follows it (`index.needsFullScan`
 *    clears when it finishes uncapped).
 *  - `connect`: the connect pass (connect.ts) — entity links, new entity
 *    pages, related pages, dated hubs — written in commits.
 *  - `migrate-frontmatter`: write memory-wiki's fields (id, pageType,
 *    sourceIds, updatedAt) into every page that lacks them.
 *  - `rename-slugs`: pages whose file name says nothing (`x.md`, `x-3.md`,
 *    `2026.md`, `3.md` — a Cyrillic title from before the slugger
 *    transliterated) get the name their title transliterates to (rename.ts):
 *    the old path kept as an alias the links still reach, every link to it
 *    rewritten, ONE commit Undo reverses. `{ renamed, skipped, more, … }`;
 *    `dryRun: true` lists them — run it first.
 *  - `upgrade-assistant-verifications`: the one-off migration (verify.ts):
 *    every claim stamped `verified: { by: assistant }` with a
 *    human-verification line — given on the user's own confirmation — becomes
 *    the owner's, `{ by: owner, via: assistant }`, which wins like a
 *    verification in the app; ONE commit. `{ upgraded, pages, skipped }`;
 *    `dryRun: true` lists them — run it first, and `rejudge-reviews` after.
 *  - `structure`: the structure pass (structure.ts, also step 4b of the
 *    nightly pass) — monthly record hubs, domain hubs, the company's root
 *    page, entity enrichment and the decisions register, written in commits.
 *    `dryRun: true` answers what it would write (`would`) and never asks the
 *    cheap model.
 *  - `classify-records`: read only — the record leaves by type and month
 *    (records.ts), and the record-like pages the rules could not type (what
 *    the capped model fallback would be asked).
 *  - `summaries`: the summaries pass (node-summary.ts, also step 4c of the
 *    nightly pass) — every node's summary written from its connections and
 *    sources, entities first, the cheap model within `summaries.maxPages` and
 *    `summaries.capUsd`, written in commits. Its answer carries the duplicate
 *    entities as merge suggestions (the merge tool's dry run: `mergeSuggestions`)
 *    and the entities filed under the wrong domain (`domainMismatches`).
 *    `dryRun: true` answers what it would write (`would`) and those
 *    suggestions, and never asks the model.
 * `reindex`, `connect`, `migrate-frontmatter`, `structure` and `summaries` run on in the background:
 * 202 `{ started: true }`; 409 `busy` while one runs. A `dryRun` answers its
 * counts at once.
 *
 * GET → `{ running, last: { [action]: result | { error } } }`.
 *
 * OWNER ONLY (POST: cookie AND same origin) — but the assistant, through the
 * MCP bearer, may run `connect` (the owner's "run the connect pass now") and
 * the `summaries` DRY RUN (it writes nothing and asks no model). The
 * others stay the owner's: a reindex re-embeds the whole vault, the rejudge,
 * the renames and the migrations are repairs — and the assistant never makes
 * its own stamps the owner's. 412 `not_initialised` before the vault exists;
 * 400 `invalid` for an unknown action; 409 `lint_blocked` when a blocking
 * lint finding refuses a rename or the migration (nothing is written).
 */
import { processStore } from "@/lib/process-store";
import { requireSession } from "@/lib/route-auth";
import { RELATED_DIMS, runConnectPass } from "@/lib/prime-radiant/connect";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { migratePluginFrontmatter } from "@/lib/prime-radiant/plugin-compat";
import { classifyRecord, RECORD_TYPES } from "@/lib/prime-radiant/records";
import { flashAvailable } from "@/lib/prime-radiant/flash-client";
import { effectiveCostRates, readSettings } from "@/lib/prime-radiant/settings";
import { modelCandidates, runStructure } from "@/lib/prime-radiant/structure-run";
import { runSummaries } from "@/lib/prime-radiant/node-summary-run";
import { readPageVectors, reindexPrimeRadiantVault, vaultIndexingAllowed } from "@/lib/prime-radiant/shard-index";
import { rejudgeOpenContradictions, rejudgeSummary } from "@/lib/prime-radiant/rejudge";
import { renameMeaninglessPages } from "@/lib/prime-radiant/rename";
import { upgradeAssistantVerifications } from "@/lib/prime-radiant/verify";
import { versionGroups, versionPages } from "@/lib/prime-radiant/versions";
import { editFailure, fail, json, readJsonBody, writerGuard } from "@/lib/prime-radiant/route-helpers";
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
  if (!gate.writer.person && b.action !== "connect" && !(b.action === "summaries" && b.dryRun === true)) {
    return fail("owner_only", "Only the owner can run that maintenance pass; the assistant may run the connect pass and the summaries dry run.", 403);
  }
  if (!(await vaultInitialised())) return fail("not_initialised", "Open Prime Radiant once to create its vault first.", 412);
  const dryRun = b.dryRun === true;
  const vault = vaultDir();
  const busy = () => json({ error: "A maintenance pass is already running.", code: "busy", running: state.running }, 409);
  try {
    switch (b.action) {
      case "rejudge-reviews": {
        const result = rejudgeOpenContradictions(vault, await readVaultSnapshot(vault), { dryRun });
        return json({ ...result, summary: rejudgeSummary(result) });
      }
      case "version-groups": {
        const groups = versionGroups(versionPages(await readVaultSnapshot(vault)));
        return json({ groups, count: groups.length, pages: groups.reduce((n, g) => n + g.pages.length, 0) });
      }
      case "reindex": {
        if (!(await vaultIndexingAllowed())) return fail("shard_off", "Switch Memory Shard on to index the vault.", 409);
        if (state.running) return busy();
        background("reindex", () => reindexPrimeRadiantVault());
        return json({ started: true }, 202);
      }
      case "connect": {
        if (state.running) return busy();
        if (dryRun) return json(await runConnectPass(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { dryRun, vectors: await readPageVectors(vault, { dims: RELATED_DIMS }) }));
        background("connect", async () => runConnectPass(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { vectors: await readPageVectors(vault, { dims: RELATED_DIMS }) }));
        return json({ started: true }, 202);
      }
      case "structure": {
        if (state.running) return busy();
        const settings = readSettings();
        const go = async (dry: boolean) =>
          runStructure(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), {
            stateVault: vault,
            settings,
            rates: effectiveCostRates(),
            online: dry ? false : await flashAvailable().catch(() => false),
            dryRun: dry,
          });
        if (dryRun) return json(await go(true));
        background("structure", () => go(false));
        return json({ started: true }, 202);
      }
      case "summaries": {
        if (state.running) return busy();
        const settings = readSettings();
        const go = async (dry: boolean) =>
          runSummaries(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), {
            stateVault: vault,
            settings,
            rates: effectiveCostRates(),
            online: dry ? false : await flashAvailable().catch(() => false),
            dryRun: dry,
            mergePreviews: true,
          });
        if (dryRun) return json(await go(true));
        background("summaries", () => go(false));
        return json({ started: true }, 202);
      }
      case "classify-records": {
        const snapshot = await readVaultSnapshot(vault);
        const company = readSettings().structure.company;
        const byType = Object.fromEntries(RECORD_TYPES.map((t) => [t, 0])) as Record<string, number>;
        const byMonth: Record<string, number> = {};
        const sample: Array<{ path: string; type: string; month: string; counterparty: string | null; via: string }> = [];
        let leaves = 0;
        for (const p of snapshot.pages) {
          if (!p.parsed.ok) continue;
          const info = classifyRecord(p.path, p.parsed.frontmatter, { ownCompany: company });
          if (!info) continue;
          leaves++;
          byType[info.type]++;
          byMonth[info.month] = (byMonth[info.month] ?? 0) + 1;
          if (sample.length < 50) sample.push({ path: p.path, type: info.type, month: info.month, counterparty: info.counterparty, via: info.via });
        }
        const untyped = modelCandidates(snapshot.pages);
        return json({ pages: snapshot.pages.length, leaves, byType, byMonth, sample, untyped: untyped.length, untypedSample: untyped.slice(0, 50).map((c) => c.path) });
      }
      case "migrate-frontmatter": {
        if (state.running) return busy();
        if (dryRun) return json(await migratePluginFrontmatter(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author), { dryRun }));
        background("migrate-frontmatter", async () => migratePluginFrontmatter(await readVaultSnapshot(vault), commitWith(vault, gate.writer.author)));
        return json({ started: true }, 202);
      }
      case "rename-slugs": {
        if (state.running) return busy();
        return json(await renameMeaninglessPages({ dryRun, vault, author: gate.writer.author }));
      }
      case "upgrade-assistant-verifications": {
        if (state.running) return busy();
        return json(await upgradeAssistantVerifications({ dryRun, vault, author: gate.writer.author }));
      }
      default:
        return fail("invalid", "Unknown action.", 400);
    }
  } catch (err) {
    // A rename or migration a blocking lint finding refuses is a 409 `lint_blocked`, as any edit's.
    return editFailure(`maintenance ${String(b.action).slice(0, 40)}`, err);
  }
}
