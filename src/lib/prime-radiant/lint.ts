/**
 * Prime Radiant's own lint, run over the pages an operation changed (or over
 * all of them).
 *
 * It complements memory-wiki's `wiki_lint` (provenance gaps, contradiction
 * notes) with the rules this layer is responsible for: the page contract, the
 * size caps that keep a page one screen for a person and one tool call for an
 * agent, the global claim-id namespace, and secrets.
 *
 * SCOPED means "which pages get findings", not "which pages are read": the
 * claim namespace and the link graph are vault-wide facts, so the whole
 * snapshot is always the input and only the scoped pages are judged.
 *
 * Severity:
 *   error    — the page breaks a cap or the contract; the nightly pass will not
 *              auto-merge while one is open.
 *   warning  — worth fixing, blocks nothing.
 * `blocksCommit` — the four rules no commit may carry at all
 * (`secret-pattern`, `frontmatter-invalid`, `claim-id-collision`,
 * `claim-id-retired-reuse`); `vaultOperation` refuses the change.
 *
 * Pure apart from the snapshot it is handed.
 */

import { buildClaimIndex, claimCollisions, isClaimId, retiredReuse } from "./claims";
import { pageSummary } from "./frontmatter";
import { buildLinkGraph } from "./links";
import { scanSecrets } from "./redact";
import type { PageFrontmatter } from "./schema";
import type { VaultPage, VaultSnapshot } from "./vault";

export const LIMITS = Object.freeze({
  bodySoftChars: 6_000,
  bodyHardChars: 12_000,
  summaryMaxChars: 300,
  maxClaims: 20,
  claimMaxChars: 240,
  atomicMaxChars: 3_000,
});

export const LINT_RULES = [
  "page-too-long",
  "summary-missing",
  "summary-too-long",
  "too-many-claims",
  "claim-too-long",
  "atomic-too-long",
  "orphan",
  "no-sources",
  "stale-after-passed",
  "secret-pattern",
  "frontmatter-invalid",
  "claim-id-collision",
  "claim-id-retired-reuse",
] as const;
export type LintRule = (typeof LINT_RULES)[number];

export const BLOCKING_RULES: ReadonlySet<LintRule> = new Set([
  "secret-pattern",
  "frontmatter-invalid",
  "claim-id-collision",
  "claim-id-retired-reuse",
]);

/** Page types held to the atomic cap. */
export const ATOMIC_TYPES: ReadonlySet<string> = new Set(["entity", "decision"]);

export type LintSeverity = "error" | "warning";

export interface SplitChild {
  title: string;
  /** Suggested vault-relative path for the child page. */
  path: string;
  chars: number;
  /** 1-based line in the body where the section starts. */
  startLine: number;
  /** True when this section alone is still over the target. */
  oversize: boolean;
}

export interface SplitSuggestion {
  /** The page stays as the hub: its summary plus a link to each child. */
  hub: string;
  target: number;
  strategy: "headings" | "paragraphs";
  children: SplitChild[];
}

export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  path: string;
  message: string;
  blocksCommit: boolean;
  /** Rule-specific facts (sizes, claim ids, kinds) — never page text or a secret. */
  details?: Record<string, unknown>;
  split?: SplitSuggestion;
}

export interface LintReport {
  scope: string[] | "all";
  checked: number;
  findings: LintFinding[];
  errors: number;
  warnings: number;
  /** No errors at all. */
  ok: boolean;
}

export interface LintOptions {
  /** Vault-relative page paths to judge; absent = every page. */
  scope?: readonly string[];
  /** Retired ids the state database remembers. */
  ledgerRetired?: Iterable<string>;
  now?: Date;
}

function finding(
  rule: LintRule,
  severity: LintSeverity,
  path: string,
  message: string,
  details?: Record<string, unknown>,
): LintFinding {
  const f: LintFinding = { rule, severity, path, message, blocksCommit: BLOCKING_RULES.has(rule) };
  if (details) f.details = details;
  return f;
}

function bodyChars(body: string): number {
  return body.trim().length;
}

/** `stale_after` has passed. A bare date means "through the end of that day" (UTC). */
export function staleAfterPassed(staleAfter: string | null, now: Date): boolean {
  if (!staleAfter) return false;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(staleAfter) ? Date.parse(`${staleAfter}T23:59:59.999Z`) : Date.parse(staleAfter);
  return Number.isFinite(t) && now.getTime() > t;
}

function slugifyTitle(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s === "" ? "part" : s;
}

/**
 * How to split an over-cap page: by its `##` headings (or `###` when it has
 * fewer than two `##`), otherwise into runs of paragraphs under `target`. The
 * page itself stays as the hub.
 */
export function suggestSplit(pagePath: string, body: string, target: number): SplitSuggestion {
  const lines = body.split(/\r?\n/);
  const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/")) : "";
  const stem = pagePath.slice(pagePath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const childPath = (title: string, used: Set<string>) => {
    let slug = slugifyTitle(title);
    for (let n = 2; used.has(slug); n++) slug = `${slugifyTitle(title)}-${n}`;
    used.add(slug);
    return `${dir === "" ? "" : `${dir}/`}${stem}/${slug}.md`;
  };

  const inFence: boolean[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    inFence.push(fence);
  }
  for (const level of [2, 3]) {
    const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
    const starts: Array<{ line: number; title: string }> = [];
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (m && !inFence[i]) starts.push({ line: i, title: m[1] });
    });
    if (starts.length >= 2) {
      const used = new Set<string>();
      const children: SplitChild[] = starts.map((s, k) => {
        const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
        const chars = lines.slice(s.line, end).join("\n").trim().length;
        return { title: s.title, path: childPath(s.title, used), chars, startLine: s.line + 1, oversize: chars > target };
      });
      return { hub: pagePath, target, strategy: "headings", children };
    }
  }

  // No usable headings: group paragraphs into parts no longer than `target`.
  const paragraphs: Array<{ line: number; text: string }> = [];
  let start = -1;
  let buf: string[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "" && !inFence[i]) {
      if (buf.length) paragraphs.push({ line: start, text: buf.join("\n") });
      buf = [];
      start = -1;
    } else {
      if (start < 0) start = i;
      buf.push(line);
    }
  });
  if (buf.length) paragraphs.push({ line: start, text: buf.join("\n") });
  const used = new Set<string>();
  const children: SplitChild[] = [];
  let part: { line: number; chars: number } | null = null;
  const flush = () => {
    if (!part) return;
    const title = `Part ${children.length + 1}`;
    children.push({ title, path: childPath(title, used), chars: part.chars, startLine: part.line + 1, oversize: part.chars > target });
    part = null;
  };
  for (const p of paragraphs) {
    const len = p.text.trim().length;
    if (part && part.chars + 2 + len > target) flush();
    if (!part) part = { line: p.line, chars: len };
    else part.chars += 2 + len;
  }
  flush();
  return { hub: pagePath, target, strategy: "paragraphs", children };
}

function lintPageShape(page: VaultPage, fm: PageFrontmatter, body: string, now: Date, out: LintFinding[]): void {
  const chars = bodyChars(body);
  if (chars > LIMITS.bodyHardChars) {
    const f = finding("page-too-long", "error", page.path, `body is ${chars} characters (hard cap ${LIMITS.bodyHardChars})`, {
      chars,
      limit: LIMITS.bodyHardChars,
    });
    f.split = suggestSplit(page.path, body, LIMITS.bodySoftChars);
    out.push(f);
  } else if (chars > LIMITS.bodySoftChars) {
    const f = finding("page-too-long", "warning", page.path, `body is ${chars} characters (soft cap ${LIMITS.bodySoftChars})`, {
      chars,
      limit: LIMITS.bodySoftChars,
    });
    f.split = suggestSplit(page.path, body, LIMITS.bodySoftChars);
    out.push(f);
  }
  if (ATOMIC_TYPES.has(fm.type) && chars > LIMITS.atomicMaxChars) {
    const f = finding(
      "atomic-too-long",
      "error",
      page.path,
      `${fm.type} pages hold one thing: ${chars} characters (cap ${LIMITS.atomicMaxChars})`,
      { chars, limit: LIMITS.atomicMaxChars, type: fm.type },
    );
    f.split = suggestSplit(page.path, body, LIMITS.atomicMaxChars);
    out.push(f);
  }

  const summary = pageSummary(body);
  if (summary === null) {
    out.push(finding("summary-missing", "warning", page.path, "the page has no first paragraph to use as its summary"));
  } else if (summary.length > LIMITS.summaryMaxChars) {
    out.push(
      finding("summary-too-long", "error", page.path, `summary is ${summary.length} characters (cap ${LIMITS.summaryMaxChars})`, {
        chars: summary.length,
        limit: LIMITS.summaryMaxChars,
      }),
    );
  }

  if (fm.claims.length > LIMITS.maxClaims) {
    const f = finding("too-many-claims", "error", page.path, `${fm.claims.length} claims (cap ${LIMITS.maxClaims}); the page is more than one topic`, {
      claims: fm.claims.length,
      limit: LIMITS.maxClaims,
    });
    f.split = suggestSplit(page.path, body, LIMITS.bodySoftChars);
    out.push(f);
  }
  for (const claim of fm.claims) {
    if (claim.text.length > LIMITS.claimMaxChars) {
      out.push(
        finding("claim-too-long", "error", page.path, `claim ${claim.id} is ${claim.text.length} characters (cap ${LIMITS.claimMaxChars})`, {
          claimId: claim.id,
          chars: claim.text.length,
          limit: LIMITS.claimMaxChars,
        }),
      );
    }
  }

  if (fm.sources.length === 0) out.push(finding("no-sources", "error", page.path, "the page names no sources"));
  if (staleAfterPassed(fm.stale_after, now)) {
    out.push(finding("stale-after-passed", "warning", page.path, `stale_after ${fm.stale_after} has passed`, { staleAfter: fm.stale_after }));
  }
}

/**
 * The secret check alone, for a touched file that is not a knowledge page
 * (index.md): it is committed like a page, so a secret there would land in
 * history just the same.
 */
export function lintSecretsInText(rel: string, text: string): LintFinding[] {
  const kinds = scanSecrets(text);
  return kinds.length > 0 ? [finding("secret-pattern", "error", rel, `the page contains what looks like ${kinds.join(", ")}`, { kinds })] : [];
}

/** Lint a vault snapshot. */
export function lintVault(snapshot: VaultSnapshot, options: LintOptions = {}): LintReport {
  const now = options.now ?? new Date();
  const scopeSet = options.scope ? new Set(options.scope) : null;
  const inScope = (p: string) => scopeSet === null || scopeSet.has(p);
  const findings: LintFinding[] = [];

  const valid = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ page: p, fm: p.parsed.frontmatter, body: p.parsed.body }] : []));
  const index = buildClaimIndex(
    valid.map((v) => ({ path: v.page.path, frontmatter: v.fm })),
    options.ledgerRetired ?? [],
  );
  const graph = buildLinkGraph(
    snapshot.pages.map((p) => ({
      path: p.path,
      title: p.parsed.ok ? p.parsed.frontmatter.title : undefined,
      body: p.parsed.body,
    })),
    snapshot.indexBody,
  );

  let checked = 0;
  for (const page of snapshot.pages) {
    if (!inScope(page.path)) continue;
    checked++;
    const kinds = scanSecrets(page.text);
    if (kinds.length > 0) {
      findings.push(finding("secret-pattern", "error", page.path, `the page contains what looks like ${kinds.join(", ")}`, { kinds }));
    }
    if (!page.parsed.ok) {
      findings.push(
        finding("frontmatter-invalid", "error", page.path, page.parsed.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; "), {
          errors: page.parsed.errors,
        }),
      );
      continue;
    }
    const fm = page.parsed.frontmatter;
    const badIds = fm.claims.filter((c) => !isClaimId(c.id)).map((c) => c.id);
    const badRetired = fm.retiredClaimIds.filter((id) => !isClaimId(id));
    const dupOnPage = fm.claims.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
    if (badIds.length > 0 || badRetired.length > 0) {
      findings.push(
        finding("frontmatter-invalid", "error", page.path, `not a claim id (<domain>/<entity>/<fact>): ${[...badIds, ...badRetired].join(", ")}`, {
          claimIds: [...badIds, ...badRetired],
        }),
      );
    }
    if (dupOnPage.length > 0) {
      // Reported once here; the vault-wide pass below reports cross-page ones.
      findings.push(
        finding("claim-id-collision", "error", page.path, `claim id used twice on this page: ${[...new Set(dupOnPage)].join(", ")}`, {
          claimIds: [...new Set(dupOnPage)],
          pages: [page.path],
        }),
      );
    }
    lintPageShape(page, fm, page.parsed.body, now, findings);
    const inbound = graph.inbound.get(page.path);
    if ((!inbound || inbound.size === 0) && !graph.indexed.has(page.path)) {
      findings.push(finding("orphan", "warning", page.path, "no page links here and index.md does not list it"));
    }
  }

  for (const { id, locations } of claimCollisions(index)) {
    const pages = [...new Set(locations.map((l) => l.page))];
    if (pages.length < 2) continue; // same-page duplicates were reported above
    for (const p of pages) {
      if (!inScope(p)) continue;
      findings.push(
        finding("claim-id-collision", "error", p, `claim id ${id} is also used on ${pages.filter((x) => x !== p).join(", ")}`, {
          claimId: id,
          pages,
        }),
      );
    }
  }
  for (const { id, locations, retiredBy } of retiredReuse(index)) {
    for (const p of new Set(locations.map((l) => l.page))) {
      if (!inScope(p)) continue;
      findings.push(
        finding("claim-id-retired-reuse", "error", p, `claim id ${id} was retired and may not be used again`, {
          claimId: id,
          retiredBy,
        }),
      );
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || LINT_RULES.indexOf(a.rule) - LINT_RULES.indexOf(b.rule));
  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    scope: options.scope ? [...options.scope].sort() : "all",
    checked,
    findings,
    errors,
    warnings: findings.length - errors,
    ok: errors === 0,
  };
}
