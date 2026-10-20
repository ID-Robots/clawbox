/**
 * A synthetic document-per-page vault for the structure pass: record leaves
 * of every type over a year, stub entities, topic pages in four domains and a
 * few decisions. Every name is invented (Globex, Initech, Vandelay …); the
 * numbers come from a seeded generator, so a vault of a given size is the
 * same vault on every run.
 */
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import type { Claim, PageFrontmatter } from "@/lib/prime-radiant/schema";
import { claim, frontmatter } from "./prime-radiant-fixtures";

export const COUNTERPARTIES = ["Globex Ltd", "Initech GmbH", "Vandelay Industries Ltd", "Soylent Corp", "Hooli Inc", "Wonka AG", "Tyrell Corp", "Cyberdyne Systems Ltd"];
export const OWN_COMPANY = "Acme Widgets Ltd";
export const DOMAINS = [
  { name: "finance", owner: "Finance team" },
  { name: "logistics", owner: "Warehouse lead" },
  { name: "marketing", owner: "Marketing team" },
  { name: "operations", owner: "Operations lead" },
];

/** A small deterministic generator (an LCG): the same seed, the same vault. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function slug(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
}

export function structurePage(fm: Partial<PageFrontmatter>, body: string): string {
  return serializePage(frontmatter({ generated: { at: "2026-09-20T10:00:00.000Z", by: "flash" }, ...fm }), body);
}

const KINDS = [
  { word: "Invoice", ref: (n: number) => `INV-2026-${String(n).padStart(6, "0")}`, domain: "finance", fact: "The invoice total is" },
  { word: "Credit note", ref: (n: number) => `CN-2026-${String(n).padStart(5, "0")}`, domain: "finance", fact: "The credit note total is" },
  { word: "Receipt", ref: (n: number) => `RC-${String(n).padStart(7, "0")}`, domain: "finance", fact: "The receipt total is" },
  { word: "Bank transfer", ref: (n: number) => `TR-${String(88_000_000 + n)}`, domain: "finance", fact: "The transfer amount is" },
  { word: "Waybill", ref: (n: number) => String(1_054_400_000 + n), domain: "logistics", fact: "The shipping charge is" },
  { word: "Customs declaration", ref: (n: number) => `26XX${String(n).padStart(10, "0")}`, domain: "logistics", fact: "The declared value is" },
  { word: "Ads receipt", ref: (n: number) => `AR-2026-${String(n).padStart(5, "0")}`, domain: "marketing", fact: "The ad spend total is" },
] as const;

const CURRENCIES = ["EUR", "USD", "BGN"] as const;

export interface SyntheticOptions {
  /** Share of the pages that are record leaves (the rest: topics, entities, decisions). */
  leafShare?: number;
  seed?: number;
}

/** A vault of about `n` pages: path → page text. */
export function syntheticVault(n: number, options: SyntheticOptions = {}): Record<string, string> {
  const rnd = seeded(options.seed ?? 7);
  const pages: Record<string, string> = {};
  const leafCount = Math.round(n * (options.leafShare ?? 0.8));
  const entityPaths = COUNTERPARTIES.map((c) => `entities/${slug(c)}.md`);
  for (const [i, name] of COUNTERPARTIES.entries()) {
    pages[entityPaths[i]] = structurePage({ type: "entity", title: name, domain: i % 2 ? "logistics" : "finance", sources: [`sources/${slug(name)}-profile.md`] }, `${name} is a company this wiki names.\n`);
  }
  pages[`entities/${slug(OWN_COMPANY)}.md`] = structurePage({ type: "entity", title: OWN_COMPANY, domain: "operations", sources: ["sources/acme-profile.md"] }, `${OWN_COMPANY} is the owner's company.\n`);
  for (let i = 0; i < leafCount; i++) {
    const kind = KINDS[i % KINDS.length];
    const month = 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 28);
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cp = COUNTERPARTIES[Math.floor(rnd() * COUNTERPARTIES.length)];
    const currency = CURRENCIES[Math.floor(rnd() * CURRENCIES.length)];
    const amount = (Math.floor(rnd() * 500_000) / 100).toFixed(2);
    const ref = kind.ref(i + 1);
    const title = `${kind.word} ${ref} ${cp}`;
    const path = `concepts/${slug(title)}.md`;
    const claims: Claim[] = [
      claim(`${kind.domain}/${slug(title).slice(0, 48)}/total`, `${kind.fact} ${currency} ${amount}, dated ${date}.`, { updatedAt: "2026-09-20T10:00:00.000Z" }),
      claim(`${kind.domain}/${slug(title).slice(0, 48)}/party`, `${cp} is the counterparty; VAT number XX${100_000_000 + COUNTERPARTIES.indexOf(cp)}.`, { updatedAt: "2026-09-20T10:00:00.000Z" }),
    ];
    const link = rnd() < 0.5 ? `\n\nIssued with [[${entityPaths[COUNTERPARTIES.indexOf(cp)].replace(/\.md$/, "")}]].` : "";
    pages[path] = structurePage({ type: "reference", title, domain: kind.domain, sources: [`sources/${slug(title)}.pdf`], claims }, `${title}.${link}\n`);
  }
  const topics = Math.max(0, n - leafCount - COUNTERPARTIES.length - 1);
  const decisions = Math.max(2, Math.round(topics * 0.05));
  for (let i = 0; i < topics; i++) {
    const domain = DOMAINS[i % DOMAINS.length].name;
    const cp = COUNTERPARTIES[i % COUNTERPARTIES.length];
    if (i < decisions) {
      const date = `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`;
      const title = `Decision ${i + 1}: work with ${cp} on ${domain}`;
      pages[`concepts/${slug(title)}.md`] = structurePage(
        { type: "decision", title, domain, sources: [`sources/minutes-${i + 1}.md`], date, decider: i % 2 ? "Board" : "Managing director" } as Partial<PageFrontmatter>,
        `We decided to work with [[${entityPaths[i % COUNTERPARTIES.length].replace(/\.md$/, "")}]].\n`,
      );
      continue;
    }
    const title = `${domain} topic ${i + 1}`;
    const claims = [
      claim(`${domain}/${slug(title)}/fact`, `The ${domain} topic ${i + 1} concerns ${cp}.`, {
        updatedAt: "2026-09-20T10:00:00.000Z",
        ...(i % 9 === 0 ? { verified: { at: "2026-09-21", by: "owner" }, status: "verified" as const } : {}),
      }),
    ];
    pages[`concepts/${slug(title)}.md`] = structurePage({ type: "concept", title, domain, sources: [`sources/notes-${i + 1}.md`], claims }, `${title} in short; see [[${entityPaths[i % COUNTERPARTIES.length].replace(/\.md$/, "")}]].\n`);
  }
  return pages;
}
