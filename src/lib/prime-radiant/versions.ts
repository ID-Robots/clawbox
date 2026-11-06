/**
 * Draft and final: one document, kept twice.
 *
 * A vault ingests what a person keeps, and a person keeps a document more
 * than once: the .docx draft and the .pdf that was sent, a dated copy and the
 * undated original, the "second copy" of an invoice. Each becomes a page, and
 * their claims disagree exactly where a draft and its final do ("the date
 * left blank" against "dated 18.02.2026"). Three in ten of an owner's sample
 * of open contradiction items were that. This module finds such pages,
 * VERSIONS of one document, so the contradiction pass never pairs their
 * claims and a report can list them for a person to merge (edit.ts's merge
 * helper). Nothing here deletes, merges or rewrites a page.
 *
 * Two pages are versions when their titles name the same document once the
 * file format, the dates and times and the version words ("draft", "final",
 * "copy", "v2", "signed") are taken out ({@link documentName}), and their
 * identifiers agree ({@link sameDocument}):
 *  - both titles carry references: they share one, neither has one the
 *    other lacks on both sides (one commit, two boards), and the names are
 *    the same or one is the other's plus a name ("Invoice INV-7 Acme" and
 *    "ClawBox invoice INV-7 Acme second copy") — never plus another kind of
 *    document ("Customs declaration Acme invoice INV-7" is no invoice);
 *  - otherwise the names are the same, name something beyond a document's
 *    type ("Export declaration Acme", never just "Invoice"), and one of the
 *    titles says it is a version or a format (a draft, a copy, a .pdf) or
 *    names a document type: "Acme" and "Acme 2025" are two pages, not two
 *    versions;
 *  - both titles dated, on different days, are two documents (two days'
 *    reports), never two versions of one;
 *  - one identifying title twice ("31.12.2025" and "31.12.2025", the second
 *    ingested as "-2") is one document.
 * A page may name its group itself: `version_of: <path>` in its frontmatter
 * links it to that page whatever the titles say.
 *
 * In a group the WINNER is the final one: a title that says final or signed,
 * or a format a document is sent in (pdf), beats a draft, a preview or an
 * editable format; then the more complete page (more claims); then the later
 * one; then the path.
 *
 * Pure.
 */

import { sharedReference, titleIdentifiers, withoutDates } from "./identifiers";
import { contentWords, DOCUMENT_TYPE_WORDS, FORMAT_WORDS, isFunctionWord, isTemplateWord, VERSION_WORDS } from "./subject";
import type { VaultSnapshot } from "./vault";

export interface DocumentName {
  /** The words that name the document: no format, no version word, no date, no reference. */
  words: ReadonlySet<string>;
  /** Of those, the ones beyond a document's type and its numbers: what tells this document from another of its kind. */
  core: ReadonlySet<string>;
  /** The references its title carries (invoice, declaration, order numbers). */
  refs: ReadonlySet<string>;
  /** The days and months its title names. */
  dates: ReadonlySet<string>;
  /** The title says it is a version or a format: "draft", "copy", "v2", "pdf". */
  marked: boolean;
  /** The title names a kind of document: "invoice", "export declaration". */
  typed: boolean;
  /** 2: a final (final, signed, pdf); 0: a draft (draft, preview, an editable format); 1: neither. */
  rank: number;
  /** The title as compared whole: lower case, spacing and end punctuation out. */
  normalized: string;
}

const DRAFT_MARKS = new Set(["draft", "preview", "wip", "unsigned", "proposed", "docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "чернова"]);
const FINAL_MARKS = new Set(["final", "signed", "pdf", "sent", "issued", "окончателен", "окончателна", "подписан", "подписана"]);

/** What a page's title says about the document it is a version of. */
export function documentName(title: string): DocumentName {
  const ids = titleIdentifiers(title);
  // A reference is the document's identity, compared on its own; out of the name.
  let rest = withoutDates(title);
  for (const raw of rest.split(/[\s,;:()[\]{}"'“”]+/)) {
    const tok = raw.replace(/^[#№]/, "").replace(/[.]+$/, "");
    const digits = (tok.match(/\d/g) ?? []).length;
    if (digits >= 5 || (/[A-Za-z]/.test(tok) && digits >= 3 && /^[A-Za-z0-9/-]+$/.test(tok))) rest = rest.replace(raw, " ");
  }
  const all = [...contentWords(rest)];
  const words = new Set(
    all.filter((w) => !isFunctionWord(w) && !FORMAT_WORDS.has(w) && !VERSION_WORDS.has(w) && !/^(?:v|rev)\d{1,3}$/.test(w) && !/^\d{1,2}:\d{2}z?$/.test(w)),
  );
  const core = new Set([...words].filter((w) => !isTemplateWord(w) && !/^\d+$/.test(w) && !/^(?:19|20)\d{2}$/.test(w)));
  const titleWords = [...contentWords(title)];
  const marked = titleWords.some((w) => FORMAT_WORDS.has(w) || VERSION_WORDS.has(w) || /^(?:v|rev)\d{1,3}$/.test(w));
  const typed = titleWords.some((w) => DOCUMENT_TYPE_WORDS.has(w));
  const rank = titleWords.some((w) => DRAFT_MARKS.has(w)) ? 0 : titleWords.some((w) => FINAL_MARKS.has(w)) ? 2 : 1;
  const normalized = title.toLowerCase().replace(/\s+/g, " ").replace(/[\s.,;:!?…]+$/, "").trim();
  return { words, core, refs: ids.ref, dates: new Set([...ids.date, ...ids.month]), marked, typed, rank, normalized };
}

function equal(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Whether `a` holds a reference that names nothing in `b`. */
function unmatched(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (!sharedReference(new Set([x]), b)) return true;
  return false;
}

function subsetOf(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  for (const x of small) if (!large.has(x)) return false;
  return true;
}

/** Both titles dated, and no date of one is a date (or the month) of the other: two documents. */
function datesClash(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const meet = (x: string, y: string) => x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
  for (const x of a) for (const y of b) if (meet(x, y)) return false;
  return true;
}

/** Whether two pages' titles name one document: two versions of it (see the module comment). */
export function sameDocument(a: DocumentName, b: DocumentName): boolean {
  if (datesClash(a.dates, b.dates)) return false;
  // One title twice ("31.12.2025" and "31.12.2025", one ingested as "-2"): one document, when the title names one.
  if (a.normalized !== "" && a.normalized === b.normalized && a.refs.size + a.dates.size + a.core.size > 0) return true;
  if (a.refs.size > 0 && b.refs.size > 0) {
    if (!sharedReference(a.refs, b.refs)) return false;
    // Each with a reference the other lacks (one commit, two boards; one order, two invoices): two documents.
    if (unmatched(a.refs, b.refs) && unmatched(b.refs, a.refs)) return false;
    if (equal(a.words, b.words)) return true;
    const [small, large] = a.words.size <= b.words.size ? [a, b] : [b, a];
    // "Invoice INV-7 Acme" in "ClawBox invoice INV-7 Acme second copy": the smaller name must still name someone,
    // and the larger may add a name ("ClawBox") but no other kind of document ("Customs declaration … invoice INV-7").
    return small.core.size >= 1 && subsetOf(small.words, large.words) && ![...large.words].some((w) => !small.words.has(w) && DOCUMENT_TYPE_WORDS.has(w));
  }
  if (!equal(a.words, b.words) || a.core.size === 0) return false;
  return a.marked || b.marked || a.typed || b.typed;
}

export interface VersionPage {
  path: string;
  title: string;
  /** Claims on the page: the more complete version wins a tie. */
  claims?: number;
  /** When the page was written (its `generated.at`): the later version wins a tie. */
  generatedAt?: string | null;
  /** The page this one is a version of, as its frontmatter names it (`version_of`). */
  versionOf?: string | null;
}

export interface VersionGroup {
  /** The version that wins: the final, the more complete, the later. */
  winner: string;
  /** Every page of the group, the winner first. */
  pages: string[];
}

/** The digits of a reference a bucket is keyed by: one reference written two ways lands in one bucket. */
function refKey(ref: string): string {
  const digits = ref.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 6 ? `d:${digits.slice(-6)}` : `r:${ref}`;
}

/**
 * The groups of pages that are versions of one document, two pages or more
 * each, the winner first. Pages are compared only within a bucket (a shared
 * reference, or the same name), so a vault of thousands costs little.
 */
export function versionGroups(pages: readonly VersionPage[]): VersionGroup[] {
  const names = pages.map((p) => documentName(p.title));
  const parent = pages.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  const buckets = new Map<string, number[]>();
  names.forEach((n, i) => {
    const keys = n.refs.size > 0 ? [...n.refs].map(refKey) : [`w:${[...n.words].sort().join(" ")}`];
    for (const k of new Set(keys)) {
      const list = buckets.get(k) ?? [];
      list.push(i);
      buckets.set(k, list);
    }
  });
  for (const list of buckets.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        if (pages[list[x]].path !== pages[list[y]].path && sameDocument(names[list[x]], names[list[y]])) union(list[x], list[y]);
      }
    }
  }
  const at = new Map(pages.map((p, i) => [p.path, i]));
  pages.forEach((p, i) => {
    const j = p.versionOf ? at.get(p.versionOf) : undefined;
    if (j !== undefined && j !== i) union(i, j);
  });
  const groups = new Map<number, number[]>();
  pages.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const out: VersionGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(
      (x, y) =>
        names[y].rank - names[x].rank ||
        (pages[y].claims ?? 0) - (pages[x].claims ?? 0) ||
        (pages[y].generatedAt ?? "").localeCompare(pages[x].generatedAt ?? "") ||
        pages[x].path.localeCompare(pages[y].path),
    );
    out.push({ winner: pages[ordered[0]].path, pages: ordered.map((i) => pages[i].path) });
  }
  return out.sort((a, b) => a.winner.localeCompare(b.winner));
}

/** Page path → the version group it belongs to (its winner's path); pages that are no one's version are absent. */
export function versionIndex(groups: readonly VersionGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) for (const p of g.pages) out.set(p, g.winner);
  return out;
}

/** The version pages of a snapshot: every valid page's title, claims, date and `version_of`. */
export function versionPages(snapshot: Pick<VaultSnapshot, "pages">): VersionPage[] {
  const out: VersionPage[] = [];
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    out.push({
      path: p.path,
      title: fm.title,
      claims: fm.claims.length,
      generatedAt: fm.generated?.at ?? null,
      versionOf: typeof fm.version_of === "string" ? fm.version_of : null,
    });
  }
  return out;
}
