/**
 * The read side the `/setup-api/prime-radiant/*` routes answer from: status,
 * the page list, one page with its links, and the lint report. Routes stay
 * thin (auth, parameters, status codes); everything here is testable without
 * a request.
 *
 * SERVER ONLY.
 */

import { buildLinkGraph } from "./links";
import { lintVault, type LintReport } from "./lint";
import { pageSummary } from "./frontmatter";
import { hasVerification, type PageFrontmatter, type SchemaError } from "./schema";
import { currentBranch, commitCount, headCommit, type CommitInfo } from "./git";
import { memoryWikiWiringStatus, type WiringPlan } from "./plugin-wiring";
import { vaultDir, safePagePath, isKnowledgePage } from "./paths";
import { readRetiredLedger } from "./state-db";
import { ensureVault, listEntry, readVaultSnapshot, type PageListEntry, type VaultSnapshot } from "./vault";

export interface PrimeRadiantStatus {
  vault: {
    path: string;
    created: boolean;
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

export async function getStatus(vault: string = vaultDir()): Promise<PrimeRadiantStatus> {
  const { created } = await ensureVault(vault);
  const snapshot = await readVaultSnapshot(vault);
  const valid = snapshot.pages.flatMap((p) => (p.parsed.ok ? [p.parsed.frontmatter] : []));
  const report = lintVault(snapshot, { ledgerRetired: ledger(vault) });
  const [branch, head, commits, plugin] = await Promise.all([
    currentBranch(vault),
    headCommit(vault),
    commitCount(vault),
    memoryWikiWiringStatus(vault),
  ]);
  return {
    vault: {
      path: vault,
      created,
      pages: snapshot.pages.length,
      invalidPages: snapshot.pages.length - valid.length,
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
  offset?: number;
  limit?: number;
}

export const MAX_PAGE_LIST = 500;

export async function listPages(filter: PageFilter = {}, vault: string = vaultDir()): Promise<{ total: number; pages: PageListEntry[] }> {
  await ensureVault(vault);
  const snapshot = await readVaultSnapshot(vault);
  const q = filter.q?.trim().toLowerCase();
  const all = snapshot.pages.map(listEntry).filter((e) => {
    if (filter.type && e.type !== filter.type) return false;
    if (filter.domain && e.domain !== filter.domain) return false;
    if (filter.status && e.status !== filter.status) return false;
    if (filter.verified !== undefined && e.verified !== filter.verified) return false;
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
  await ensureVault(vault);
  const snapshot = await readVaultSnapshot(vault);
  const page = snapshot.pages.find((p) => p.path === safe);
  if (!page) return null;
  return pageDetail(snapshot, page.path, vault);
}

function pageDetail(snapshot: VaultSnapshot, rel: string, vault: string): PageDetail {
  const page = snapshot.pages.find((p) => p.path === rel)!;
  const graph = buildLinkGraph(
    snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, body: p.parsed.body })),
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
    lint: lintVault(snapshot, { scope: [rel], ledgerRetired: ledger(vault) }),
  };
}

/**
 * The lint report for `paths` (vault-relative; unsafe ones are dropped), or
 * for the whole vault when none are given.
 */
export async function getLint(paths: readonly string[] | null, vault: string = vaultDir(), now?: Date): Promise<LintReport> {
  await ensureVault(vault);
  const snapshot = await readVaultSnapshot(vault);
  const scope =
    paths && paths.length > 0
      ? paths.map((p) => safePagePath(p)).filter((p): p is string => p !== null && isKnowledgePage(p))
      : undefined;
  return lintVault(snapshot, { scope, ledgerRetired: ledger(vault), now });
}
