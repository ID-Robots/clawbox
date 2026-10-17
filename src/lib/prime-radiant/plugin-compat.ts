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
 * The other way round, {@link adoptPluginFrontmatter}: a page the plugin wrote
 * in its own format (plugin-files.ts `isPluginFormatFrontmatter`) is given
 * Prime Radiant's page contract — its fields kept beside, its claims given
 * ids in the vault's namespace.
 *
 * Pure, except the migration.
 */

import { allocateClaimId, slugify, type ClaimIndex } from "./claims";
import { CLAIM_STATUSES, PAGE_TYPES, PRIVACY_TIERS, SLUG_RE, type Claim, type ClaimEvidence, type PageFrontmatter, type PageType } from "./schema";
import type { VaultSnapshot, VaultTx } from "./vault";
import { DEFAULT_DOMAIN, DEFAULT_OWNER } from "./writer";

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
        // Edited since the snapshot: left as it is (the next migration picks it up).
        const current = await tx.read(p.path);
        if (current?.text !== p.text) continue;
        await tx.writePage(p.path, p.parsed.frontmatter, p.parsed.body);
      }
    });
    if (commit) result.commits.push(commit);
  }
  return result;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function firstHeading(body: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m ? m[1].trim() : null;
}

/** The plugin's privacy tier as one of Prime Radiant's: one it shares stays, none is internal, any other is confidential. */
function privacyOf(raw: Record<string, unknown>): PageFrontmatter["privacy"] {
  const tier = typeof raw.privacyTier === "string" ? raw.privacyTier.trim().toLowerCase() : "";
  if ((PRIVACY_TIERS as readonly string[]).includes(tier)) return tier as PageFrontmatter["privacy"];
  // Any other tier (local-private, sensitive, confirm-before-use) is one the plugin flags for review.
  return tier === "" ? "internal" : "confidential";
}

export interface AdoptedPage {
  frontmatter: PageFrontmatter;
  /** The plugin's claims that became the page's, with their new ids. */
  claims: number;
}

/**
 * Prime Radiant frontmatter for a page memory-wiki wrote in its own format at
 * `rel`: `type` from its `pageType` (else its folder's kind), the title it
 * gave (else the page's first heading, else the file name), the plugin's
 * `sourceIds` as `sources`, `status: draft` (the plugin's `active` says
 * nothing a person checked), `generated` by memory-wiki at its `updatedAt`.
 * Its claims keep their text, confidence and evidence under ids allocated in
 * the vault's namespace (`ctx.claimIndex` is updated, so the next page sees
 * them); a claim with no text is dropped. Every other field it wrote is kept
 * as it was. Pure.
 */
export function adoptPluginFrontmatter(rel: string, raw: Record<string, unknown>, body: string, ctx: { claimIndex: ClaimIndex; now: Date }): AdoptedPage {
  const kind = typeof raw.pageType === "string" ? raw.pageType.trim() : "";
  const type: PageType = (PAGE_TYPES as readonly string[]).includes(kind)
    ? (kind as PageType)
    : (((PAGE_TYPES as readonly string[]).includes(pluginKindFor(rel) ?? "") ? pluginKindFor(rel) : "concept") as PageType);
  const leaf = rel.split("/").pop()!.replace(/\.md$/, "");
  const title = (typeof raw.title === "string" && raw.title.trim()) || firstHeading(body) || leaf.replace(/[-_]+/g, " ");
  const domain = typeof raw.domain === "string" && SLUG_RE.test(raw.domain) && raw.domain.length <= 48 ? raw.domain : DEFAULT_DOMAIN;
  const at = isIso(raw.updatedAt) ? raw.updatedAt : ctx.now.toISOString();
  const sources = [...new Set([...stringList(raw.sources), ...stringList(raw.sourceIds)])];

  const claims: Claim[] = [];
  const used = new Set<string>();
  const entity = slugify(title, 48);
  for (const c of Array.isArray(raw.claims) ? raw.claims : []) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) continue;
    const pc = c as Record<string, unknown>;
    const text = typeof pc.text === "string" ? pc.text.replace(/\s+/g, " ").trim() : "";
    if (text === "") continue;
    const id = allocateClaimId(ctx.claimIndex, domain, entity, slugify(text, 48), rel, used);
    used.add(id);
    const confidence = typeof pc.confidence === "number" && Number.isFinite(pc.confidence) && pc.confidence >= 0 && pc.confidence <= 1 ? pc.confidence : 0.5;
    const status = typeof pc.status === "string" && (CLAIM_STATUSES as readonly string[]).includes(pc.status) && pc.status !== "verified" ? pc.status : "proposed";
    const evidence = Array.isArray(pc.evidence) ? (pc.evidence.filter((e) => typeof e === "object" && e !== null && !Array.isArray(e)) as ClaimEvidence[]) : [];
    const claim: Claim = {
      id,
      text,
      confidence,
      status: status as Claim["status"],
      updatedAt: isIso(pc.updatedAt) ? pc.updatedAt : at,
      evidence: [...evidence.slice(0, 10), { kind: "memory-wiki", note: typeof pc.id === "string" ? `memory-wiki claim ${pc.id.slice(0, 120)}` : "memory-wiki claim" }],
    };
    claims.push(claim);
    const list = ctx.claimIndex.active.get(id) ?? [];
    list.push({ page: rel, claim });
    ctx.claimIndex.active.set(id, list);
  }

  const kept = { ...raw };
  for (const key of ["status", "claims", "verified", "stale_after", "retiredClaimIds", "checked_by", "opus_pending"]) delete kept[key];
  const frontmatter: PageFrontmatter = {
    ...kept,
    type,
    title: title.slice(0, 200),
    domain,
    owner: typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : DEFAULT_OWNER,
    status: "draft",
    generated: { at, by: "memory-wiki" },
    verified: null,
    stale_after: null,
    sources,
    privacy: privacyOf(raw),
    checked_by: "flash",
    opus_pending: false,
    claims,
    retiredClaimIds: [],
  };
  return { frontmatter, claims: claims.length };
}
