/**
 * Synthetic Prime Radiant pages for tests. Every name here is invented
 * ("Acme Widgets Ltd", example.com) — no real company data.
 */
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import type { Claim, PageFrontmatter } from "@/lib/prime-radiant/schema";
import type { VaultPage, VaultSnapshot } from "@/lib/prime-radiant/vault";
import { parsePage } from "@/lib/prime-radiant/frontmatter";

export function claim(id: string, text = "Acme Widgets Ltd ships blue widgets.", extra: Partial<Claim> = {}): Claim {
  return {
    id,
    text,
    confidence: 0.8,
    status: "supported",
    updatedAt: "2026-01-15T10:00:00.000Z",
    evidence: [{ kind: "source", path: "sources/acme-catalogue.md" }],
    ...extra,
  };
}

export function frontmatter(extra: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    type: "concept",
    title: "Widget pricing",
    domain: "acme-sales",
    owner: "sales-team",
    status: "draft",
    generated: { at: "2026-01-15T10:00:00.000Z", by: "flash" },
    verified: null,
    stale_after: null,
    sources: ["sources/acme-catalogue.md"],
    privacy: "internal",
    checked_by: "flash",
    opus_pending: false,
    claims: [],
    retiredClaimIds: [],
    ...extra,
  };
}

export const DEFAULT_BODY = "Acme Widgets Ltd sells widgets in three sizes.\n\n## Details\n\nSee [[entities/acme-widgets]].\n";

export function pageText(extra: Partial<PageFrontmatter> = {}, body = DEFAULT_BODY): string {
  return serializePage(frontmatter(extra), body);
}

export function vaultPage(path: string, text: string): VaultPage {
  return { path, text, bytes: Buffer.byteLength(text), mtimeMs: 0, parsed: parsePage(text) };
}

export function snapshot(pages: Record<string, string>, indexBody: string | null = null): VaultSnapshot {
  return {
    vault: "/nonexistent",
    pages: Object.entries(pages).map(([p, t]) => vaultPage(p, t)),
    indexBody,
    truncated: false,
  };
}
