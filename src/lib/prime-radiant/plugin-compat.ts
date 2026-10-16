/**
 * The frontmatter OpenClaw's memory-wiki plugin reads, written beside Prime
 * Radiant's own so the plugin's `wiki_lint` agrees with the app's lint.
 *
 * The plugin wants, on every page under its folders (entities/, concepts/,
 * syntheses/, sources/, reports/):
 *   - `id`: a page id unique in the vault (here: the path without `.md`);
 *   - `pageType`: the kind its folder means (`entity`, `concept`,
 *     `synthesis`, `source`, `report`) — Prime Radiant's own `type`
 *     (reference, howto, metric, …) stays in `type`;
 *   - `sourceIds`: the provenance of every non-source page (here: the page's
 *     `sources`);
 *   - `updatedAt`: when the page was last touched, for its freshness check.
 * Claims already carry `evidence` and `updatedAt` in the plugin's shape.
 *
 * Applied on every page write (vault.ts `writePage`) and, for pages written
 * before, by {@link migratePluginFrontmatter}.
 *
 * Pure, except the migration.
 */

import type { PageFrontmatter } from "./schema";
import type { VaultSnapshot, VaultTx } from "./vault";

const FOLDER_KINDS: ReadonlyArray<[string, string]> = [
  ["entities/", "entity"],
  ["concepts/", "concept"],
  ["syntheses/", "synthesis"],
  ["sources/", "source"],
  ["reports/", "report"],
];

/** The plugin's page kind for a vault path, or null outside its folders. */
export function pluginKindFor(rel: string): string | null {
  for (const [prefix, kind] of FOLDER_KINDS) if (rel.startsWith(prefix)) return kind;
  return null;
}

/** The latest of the page's own timestamps. */
export function pageUpdatedAt(fm: PageFrontmatter): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  const consider = (v: unknown) => {
    if (typeof v !== "string") return;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  };
  consider(fm.generated?.at);
  consider(fm.verified?.at);
  for (const c of fm.claims ?? []) consider(c.updatedAt);
  return best;
}

function stringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

/** `fm` with the plugin's fields filled in for the page at `rel`. Never removes or changes Prime Radiant's own fields. */
export function withPluginFields(rel: string, fm: PageFrontmatter): PageFrontmatter {
  const out: PageFrontmatter = { ...fm };
  const own = typeof fm.id === "string" ? fm.id.trim() : "";
  out.id = own !== "" ? own : rel.replace(/\.md$/, "");
  const kind = pluginKindFor(rel);
  if (kind) out.pageType = kind;
  const sources = [...new Set([...(fm.sources ?? []).map((s) => s.trim()).filter(Boolean)])];
  const existing = stringList(fm.sourceIds);
  const sourceIds = [...new Set([...sources, ...existing])];
  if (sourceIds.length > 0) out.sourceIds = sourceIds;
  const updatedAt = pageUpdatedAt(fm);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/** Whether a page lacks (or has stale) plugin fields. */
export function needsPluginFields(rel: string, fm: PageFrontmatter): boolean {
  const next = withPluginFields(rel, fm);
  for (const key of ["id", "pageType", "updatedAt"] as const) if (next[key] !== fm[key]) return true;
  return JSON.stringify(next.sourceIds ?? null) !== JSON.stringify(fm.sourceIds ?? null);
}

/** Pages the migration rewrites in one commit. */
export const MIGRATION_BATCH = 400;

export interface PluginMigrationResult {
  checked: number;
  /** Pages that needed (dryRun) or got the plugin's fields. */
  updated: number;
  commits: string[];
  dryRun: boolean;
}

/**
 * Write the plugin's fields into every page that lacks them, in commits of
 * {@link MIGRATION_BATCH}. The body is untouched; `writePage` fills the
 * fields. A page with invalid frontmatter is left to lint.
 */
export async function migratePluginFrontmatter(
  snapshot: Pick<VaultSnapshot, "pages">,
  run: (message: string, fn: (tx: VaultTx) => Promise<void>) => Promise<{ commit: string | null }>,
  options: { dryRun?: boolean } = {},
): Promise<PluginMigrationResult> {
  const todo = snapshot.pages.filter((p) => p.parsed.ok && needsPluginFields(p.path, p.parsed.frontmatter));
  const result: PluginMigrationResult = { checked: snapshot.pages.length, updated: todo.length, commits: [], dryRun: !!options.dryRun };
  if (options.dryRun) return result;
  for (let at = 0; at < todo.length; at += MIGRATION_BATCH) {
    const batch = todo.slice(at, at + MIGRATION_BATCH);
    const { commit } = await run(`migrate: memory-wiki frontmatter (${at + 1}-${at + batch.length} of ${todo.length})`, async (tx) => {
      for (const p of batch) {
        if (!p.parsed.ok) continue;
        await tx.writePage(p.path, p.parsed.frontmatter, p.parsed.body);
      }
    });
    if (commit) result.commits.push(commit);
  }
  return result;
}
