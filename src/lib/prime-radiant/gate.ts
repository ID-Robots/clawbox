/**
 * The verified gate: nothing a person verified changes without a person.
 *
 * A branch (a nightly `dream/…` branch) is compared with the base it left
 * (`main`, three-dot: what the branch did since they diverged). A page counts
 * as TOUCHED when the branch changed its frontmatter or its body AND the page
 * as the base has it carries a verification — on the page or on any claim.
 * Bookkeeping never counts: `.openclaw-wiki/`, `log.md`, `log.jsonl`,
 * `index.md`, `_views/` and everything else that is not a knowledge page (a
 * branch that only re-indexed is not a branch that edited a verified fact).
 *
 * A change git sees but the page's meaning does not (the same frontmatter and
 * body re-serialised) is not a touch either: frontmatter and body are compared
 * PARSED.
 *
 * SERVER ONLY.
 */

import { parsePage } from "./frontmatter";
import { changedPaths, git, showFileAt } from "./git";
import { isKnowledgePage } from "./paths";
import { hasVerification, type Claim } from "./schema";

/** The bookkeeping paths the gate never looks at (on top of every non-page path). */
const GATE_IGNORE_RE = /(^|\/)(\.openclaw-wiki\/|_views\/)|(^|\/)(log\.md|log\.jsonl|index\.md)$/;

export function gateIgnores(rel: string): boolean {
  return GATE_IGNORE_RE.test(rel) || !isKnowledgePage(rel);
}

export interface VerifiedClaimChange {
  claimId: string;
  /** The verified text on the base. */
  before: string;
  /** The branch's text, or null when the branch removed the claim. */
  after: string | null;
}

export interface VerifiedTouch {
  path: string;
  /** The branch deleted the page. */
  deleted: boolean;
  /** The page itself (not only a claim) is verified on the base. */
  pageVerified: boolean;
  /** Verified claims the branch changed or removed. */
  claims: VerifiedClaimChange[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare one page's two versions. Null when the page is not touched. */
export function judgeTouch(path: string, baseText: string | null, headText: string | null): VerifiedTouch | null {
  if (baseText === null) return null; // a new page cannot have been verified
  const base = parsePage(baseText);
  if (!base.ok || !hasVerification(base.frontmatter)) return null;
  const pageVerified = !!base.frontmatter.verified;
  const verifiedClaims = base.frontmatter.claims.filter((c) => !!c.verified);
  if (headText === null) {
    return {
      path,
      deleted: true,
      pageVerified,
      claims: verifiedClaims.map((c) => ({ claimId: c.id, before: c.text, after: null })),
    };
  }
  const head = parsePage(headText);
  if (head.ok && sameJson(head.frontmatter, base.frontmatter) && head.body === base.body) return null;
  const headClaims = new Map<string, Claim>((head.ok ? head.frontmatter.claims : []).map((c) => [c.id, c]));
  const claims: VerifiedClaimChange[] = [];
  for (const c of verifiedClaims) {
    const now = headClaims.get(c.id);
    if (!now) claims.push({ claimId: c.id, before: c.text, after: null });
    else if (!sameJson(now, c)) claims.push({ claimId: c.id, before: c.text, after: now.text });
  }
  return { path, deleted: false, pageVerified, claims };
}

/**
 * Every verified page `head` touched since it left `base`, in path order.
 * The base side of each page is the MERGE BASE — the page as the branch found
 * it — so a verification made on `base` after the branch left is not read as
 * something the branch undid. Reads the repository only; never writes.
 */
export async function verifiedTouches(vault: string, base: string, head: string): Promise<VerifiedTouch[]> {
  const mb = await git(vault, ["merge-base", base, head], { allowFail: true });
  const from = mb.code === 0 && mb.stdout.trim() !== "" ? mb.stdout.trim() : base;
  const out: VerifiedTouch[] = [];
  for (const rel of (await changedPaths(vault, base, head)).sort()) {
    if (gateIgnores(rel)) continue;
    const touch = judgeTouch(rel, await showFileAt(vault, from, rel), await showFileAt(vault, head, rel));
    if (touch) out.push(touch);
  }
  return out;
}
