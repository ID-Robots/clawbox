/**
 * What the `/setup-api/prime-radiant/*` routes answer from: status, the page
 * list, one page with its links, the lint report, and `initialise`. Routes
 * stay thin (auth, parameters, status codes); everything here is testable
 * without a request.
 *
 * The reads NEVER create anything: on a vault that does not exist yet, status
 * says `initialised: false`, the list and the lint are empty and a page is
 * absent. Only {@link initialise} (and a mutating `vaultOperation`) makes it.
 *
 * SERVER ONLY.
 */

import { buildLinkGraph, pathAliases } from "./links";
import { lintVault, type LintReport } from "./lint";
import { pageSummary } from "./frontmatter";
import { pageBlurb } from "./page-blurb";
import { isPluginFormatFrontmatter } from "./plugin-files";
import { hasVerification, type PageFrontmatter, type SchemaError } from "./schema";
import { currentBranch, commitCount, headCommit, type CommitInfo } from "./git";
import { adoptPluginPages, repairPluginWritesOnce, type PluginRepairResult } from "./plugin-repair";
import { ensureMemoryWikiWiring, memoryWikiWiringStatus, type WiringPlan, type WiringResult } from "./plugin-wiring";
import { vaultDir, safePagePath, isKnowledgePage } from "./paths";
import { readRetiredLedger } from "./state-db";
import { readStaleClaims, type StaleClaimNote } from "./verify";
import {
  ensureVault,
  listEntry,
  readPage,
  readVaultSnapshot,
  vaultInitialised,
  type PageListEntry,
  type VaultSnapshot,
} from "./vault";

export interface PrimeRadiantStatus {
  /** False until `POST init` (or a first change) has made the vault. */
  initialised: boolean;
  vault: {
    path: string;
    pages: number;
    invalidPages: number;
    verifiedPages: number;
    claims: number;
    domains: string[];
    truncated: boolean;
  };
  git: { branch: string | null; head: CommitInfo | null; commits: number };
  plugin: WiringPlan;
  lint: { errors: number; warnings: number; ok: boolean };
}

function ledger(vault: string): string[] {
  try {
    return readRetiredLedger(vault);
  } catch {
    return [];
  }
}

/** The stale notes owner-verified claims left (verify.ts); none when the state database cannot be read. */
function staleNotes(vault: string): StaleClaimNote[] {
  try {
    return readStaleClaims(vault);
  } catch {
    return [];
  }
}

export async function getStatus(vault: string = vaultDir()): Promise<PrimeRadiantStatus> {
  if (!(await vaultInitialised(vault))) {
    return {
      initialised: false,
      vault: { path: vault, pages: 0, invalidPages: 0, verifiedPages: 0, claims: 0, domains: [], truncated: false },
      git: { branch: null, head: null, commits: 0 },
      plugin: await memoryWikiWiringStatus(vault),
      lint: { errors: 0, warnings: 0, ok: true },
    };
  }
  const snapshot = await readVaultSnapshot(vault);
  const valid = snapshot.pages.flatMap((p) => (p.parsed.ok ? [p.parsed.frontmatter] : []));
  const report = lintVault(snapshot, { ledgerRetired: ledger(vault), staleClaims: staleNotes(vault) });
  const [branch, head, commits, plugin] = await Promise.all([
    currentBranch(vault),
    headCommit(vault),
    commitCount(vault),
    memoryWikiWiringStatus(vault),
  ]);
  return {
    initialised: true,
    vault: {
      path: vault,
      pages: snapshot.pages.length,
      // A page memory-wiki wrote in its own format is converted on the next pass, not broken.
      invalidPages: snapshot.pages.filter((p) => !p.parsed.ok && !isPluginFormatFrontmatter(p.parsed.raw)).length,
      verifiedPages: valid.filter(hasVerification).length,
      claims: valid.reduce((n, fm) => n + fm.claims.length, 0),
      domains: [...new Set(valid.map((fm) => fm.domain))].sort(),
      truncated: snapshot.truncated,
    },
    git: { branch, head, commits },
    plugin,
    lint: { errors: report.errors, warnings: report.warnings, ok: report.ok },
  };
}

export interface PageFilter {
  type?: string;
  domain?: string;
  status?: string;
  /** Case-insensitive match on title or path. */
  q?: string;
  verified?: boolean;
  /** The page's owner, matched whole and case-insensitively. */
  owner?: string;
  offset?: number;
  limit?: number;
}

export const MAX_PAGE_LIST = 500;

export async function listPages(filter: PageFilter = {}, vault: string = vaultDir()): Promise<{ total: number; pages: PageListEntry[] }> {
  if (!(await vaultInitialised(vault))) return { total: 0, pages: [] };
  const snapshot = await readVaultSnapshot(vault);
  const q = filter.q?.trim().toLowerCase();
  const owner = filter.owner?.trim().toLowerCase();
  const all = snapshot.pages.map(listEntry).filter((e) => {
    if (filter.type && e.type !== filter.type) return false;
    if (filter.domain && e.domain !== filter.domain) return false;
    if (filter.status && e.status !== filter.status) return false;
    if (filter.verified !== undefined && e.verified !== filter.verified) return false;
    if (owner && (e.owner ?? "").toLowerCase() !== owner) return false;
    if (q && !e.path.toLowerCase().includes(q) && !(e.title ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(MAX_PAGE_LIST, Math.max(1, filter.limit ?? 100));
  return { total: all.length, pages: all.slice(offset, offset + limit) };
}

export interface PageDetail {
  path: string;
  valid: boolean;
  frontmatter: PageFrontmatter | null;
  errors: SchemaError[] | null;
  body: string;
  summary: string | null;
  verified: boolean;
  /** Pages that link here. */
  backlinks: string[];
  /** Pages this one links to. */
  links: string[];
  inIndex: boolean;
  lint: LintReport;
}

export async function getPage(rel: string, vault: string = vaultDir()): Promise<PageDetail | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe)) return null;
  if (!(await vaultInitialised(vault))) return null;
  const snapshot = await readVaultSnapshot(vault);
  const page = snapshot.pages.find((p) => p.path === safe);
  if (!page) return null;
  return pageDetail(snapshot, page.path, vault);
}

/** A page in a few sentences, for the Map's card (page-blurb.ts). */
export interface PageBlurb {
  path: string;
  /** Null when the page has no summary and no prose. */
  summary: string | null;
}

/** The Map card's summary of one page: reads that page alone, whatever the vault's size. */
export async function getPageBlurb(rel: string, vault: string = vaultDir()): Promise<PageBlurb | null> {
  const safe = safePagePath(rel);
  if (!safe || !isKnowledgePage(safe)) return null;
  if (!(await vaultInitialised(vault))) return null;
  const page = await readPage(safe, vault);
  if (!page) return null;
  return { path: page.path, summary: pageBlurb(page.parsed.ok ? page.parsed.frontmatter : null, page.parsed.body) };
}

function pageDetail(snapshot: VaultSnapshot, rel: string, vault: string): PageDetail {
  const page = snapshot.pages.find((p) => p.path === rel)!;
  const graph = buildLinkGraph(
    snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, aliases: p.parsed.ok ? pathAliases(p.parsed.frontmatter.aliases) : undefined, body: p.parsed.body })),
    snapshot.indexBody,
  );
  const fm = page.parsed.ok ? page.parsed.frontmatter : null;
  return {
    path: page.path,
    valid: page.parsed.ok,
    frontmatter: fm,
    errors: page.parsed.ok ? null : page.parsed.errors,
    body: page.parsed.body,
    summary: pageSummary(page.parsed.body),
    verified: fm ? hasVerification(fm) : false,
    backlinks: [...(graph.inbound.get(rel) ?? [])].sort(),
    links: [...(graph.outbound.get(rel) ?? [])].sort(),
    inIndex: graph.indexed.has(rel),
    lint: lintVault(snapshot, { scope: [rel], ledgerRetired: ledger(vault), staleClaims: staleNotes(vault) }),
  };
}

/**
 * The lint report for `paths` (vault-relative; unsafe ones are dropped), or
 * for the whole vault when none are given.
 */
export async function getLint(paths: readonly string[] | null, vault: string = vaultDir(), now?: Date): Promise<LintReport> {
  const snapshot: VaultSnapshot = (await vaultInitialised(vault))
    ? await readVaultSnapshot(vault)
    : { vault, pages: [], indexBody: null, truncated: false };
  const scope =
    paths && paths.length > 0
      ? paths.map((p) => safePagePath(p)).filter((p): p is string => p !== null && isKnowledgePage(p))
      : undefined;
  return lintVault(snapshot, { scope, ledgerRetired: ledger(vault), staleClaims: staleNotes(vault), now });
}

export interface InitialiseResult {
  /** True when this call made the vault; false when it was already there. */
  created: boolean;
  /** The memory-wiki wiring after this call, and whether it wrote the config. */
  plugin: WiringResult;
  /**
   * The one-time repair of what memory-wiki had written into the vault, when
   * this call ran it (`ran: false` once it has run; null when it failed —
   * the nightly pass tries again).
   */
  repair: PluginRepairResult | null;
}

/**
 * Make the vault and point memory-wiki at it. Idempotent: a second call makes
 * nothing and writes no config. The wiring never overwrites an owner's own
 * memory-wiki setting (that is reported as a `conflict`). Also called on an
 * initialised vault whose wiring still needs a write (the keys a newer
 * ClawBox added) — the wiring and the repair are each done once.
 */
export async function initialise(vault: string = vaultDir()): Promise<InitialiseResult> {
  const { created } = await ensureVault(vault);
  let plugin: WiringResult;
  try {
    plugin = await ensureMemoryWikiWiring({ vault });
  } catch (err) {
    throw new WiringWriteError(err);
  }
  let repair: PluginRepairResult | null;
  try {
    repair = await repairPluginWritesOnce(vault);
  } catch (err) {
    console.warn(`[prime-radiant] memory-wiki repair failed: ${err instanceof Error ? err.message : String(err)}`);
    repair = null;
  }
  try {
    await adoptPluginPages(vault);
  } catch (err) {
    console.warn(`[prime-radiant] memory-wiki's own pages could not be converted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { created, plugin, repair };
}

/** The vault is there; the memory-wiki config write is what failed. */
export class WiringWriteError extends Error {
  constructor(readonly cause: unknown) {
    super(`memory-wiki wiring could not be written: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WiringWriteError";
  }
}
