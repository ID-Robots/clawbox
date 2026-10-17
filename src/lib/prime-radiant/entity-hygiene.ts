/**
 * Two things wrong with an entity page that its neighbourhood tells:
 *
 *  1. DUPLICATES — two entity pages for one name: a `-2` page the connect
 *     pass made beside an existing one, or the same name in Latin and in
 *     Cyrillic ("Ivan Ivanov" / "Иван Иванов"). Names are compared by a
 *     skeleton ({@link nameSkeleton}): transliterated, accents folded, the
 *     spellings transliteration varies on (ya/ia, ts/c, kh/h, doubled letters)
 *     made one. The CANONICAL page of a group is a verified one, else one with
 *     no `-N` suffix, else the most linked; the others are suggested as merges
 *     into it (the summaries pass plans them with the merge tool, dry run).
 *  2. DOMAIN MISMATCH — an entity filed under a domain its neighbourhood says
 *     it is not in: a role its facts name ("COO" → an operations domain) when
 *     that domain exists, else the domain most of its linked pages share. A
 *     suggestion, never a move: lint warns with it.
 *
 * Pure.
 */

import { transliterateCyrillic } from "./claims";
import { isPathAlias } from "./links";
import { hasVerification, type PageFrontmatter } from "./schema";

/** Linked content pages with a domain an entity needs before their majority suggests one. */
export const DOMAIN_MIN_NEIGHBOURS = 5;
/** The share of them the suggested domain must hold. */
export const DOMAIN_MAJORITY = 0.6;
/** The most of them the page's own domain may hold for the majority to count. */
export const DOMAIN_OWN_MAX = 0.2;
/** The domain that is no domain: never suggested, never counted. */
const GENERAL = "general";

export interface HygienePage {
  path: string;
  fm: PageFrontmatter;
}

/** An entity page: typed so, or filed under entities/ — never one of the structure pass's own pages. */
export function isEntityPage(p: HygienePage): boolean {
  if (p.fm.structure !== undefined && p.fm.structure !== null) return false;
  return p.fm.type === "entity" || p.path.startsWith("entities/");
}

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A page's names: its title and the aliases that are names (a former path is where it was, not a name). */
export function pageNames(fm: PageFrontmatter): string[] {
  return [fm.title, ...stringList(fm.aliases).filter((a) => !isPathAlias(a))].map((n) => n.trim()).filter((n) => n.length > 0);
}

/**
 * A name as two spellings of it agree: Cyrillic transliterated, accents
 * folded, lowercase words, and the letters transliteration varies on made one
 * (kh→h, ts/tz→c, zh→j, ph→f, ck/q→k, w→v, x→ks, y/j→i, doubled letters once).
 */
export function nameSkeleton(name: string): string {
  return transliterateCyrillic(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/kh/g, "h")
    .replace(/t[sz]/g, "c")
    .replace(/zh/g, "j")
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/[yj]/g, "i")
    .replace(/([a-z])\1+/g, "$1");
}

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;
const SUFFIX_RE = /-(\d+)\.md$/;

export type DuplicateReason = "suffix" | "script" | "name";

export interface DuplicateGroup {
  /** Where the group's summary lives, and what the others merge into. */
  canonical: string;
  duplicates: string[];
  reason: DuplicateReason;
  /** The shared name skeleton. */
  key: string;
}

/**
 * Entity pages that are one entity under two pages. `inbound` counts the
 * content pages linking each (the most linked is the canonical one when
 * nothing else decides). Groups in canonical-path order.
 */
export function findDuplicateEntities(pages: readonly HygienePage[], inbound: (path: string) => number = () => 0): DuplicateGroup[] {
  const entities = pages.filter(isEntityPage);
  // Union-find over pages sharing a skeleton of any of their names.
  const parent = new Map<string, string>(entities.map((p) => [p.path, p.path]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const byKey = new Map<string, string>();
  const keyOf = new Map<string, string>();
  for (const p of entities) {
    for (const name of pageNames(p.fm)) {
      const key = nameSkeleton(name);
      // Two letters or a number is no name to tie pages by.
      if (key.replace(/[^a-z]/g, "").length < 3) continue;
      if (!keyOf.has(p.path)) keyOf.set(p.path, key);
      const other = byKey.get(key);
      if (other === undefined) byKey.set(key, p.path);
      else if (find(other) !== find(p.path)) parent.set(find(p.path), find(other));
    }
  }
  const groups = new Map<string, HygienePage[]>();
  for (const p of entities) {
    const root = find(p.path);
    const list = groups.get(root) ?? [];
    list.push(p);
    groups.set(root, list);
  }
  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const paths = new Set(members.map((m) => m.path));
    const suffixOf = (p: string) => {
      const m = SUFFIX_RE.exec(p);
      return m && paths.has(p.replace(SUFFIX_RE, ".md")) ? Number(m[1]) : 0;
    };
    const ranked = [...members].sort(
      (a, b) =>
        Number(hasVerification(b.fm)) - Number(hasVerification(a.fm)) ||
        Number(suffixOf(a.path) > 0) - Number(suffixOf(b.path) > 0) ||
        Number(a.fm.generated?.by === "connect") - Number(b.fm.generated?.by === "connect") ||
        inbound(b.path) - inbound(a.path) ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
    const titles = members.map((m) => m.fm.title);
    const reason: DuplicateReason = members.some((m) => suffixOf(m.path) > 0)
      ? "suffix"
      : titles.some((t) => CYRILLIC.test(t)) && titles.some((t) => LATIN.test(t) && !CYRILLIC.test(t))
        ? "script"
        : "name";
    out.push({ canonical: ranked[0].path, duplicates: ranked.slice(1).map((m) => m.path).sort(), reason, key: keyOf.get(ranked[0].path) ?? "" });
  }
  return out.sort((a, b) => a.canonical.localeCompare(b.canonical));
}

// ── domains ─────────────────────────────────────────────────────────────────

/**
 * Roles that place a person or a team in a domain: the domain names it may go
 * by (the first that exists in the vault is suggested) and the words that say
 * it. Whole words, any case; acronyms upper case only.
 */
const ROLE_DOMAINS: ReadonlyArray<{ domains: readonly string[]; words: RegExp }> = [
  {
    domains: ["finance", "accounting", "finances"],
    words: /\b(?:CFO|chief financial officer|accountant|bookkeeper|treasurer|controller|head of finance|finance (?:manager|director|lead))\b|счетоводител|финансов директор/iu,
  },
  {
    domains: ["operations", "ops", "logistics"],
    words: /\b(?:COO|chief operating officer|head of operations|operations (?:manager|director|lead)|logistics (?:manager|lead|coordinator))\b|оперативен директор/iu,
  },
  {
    domains: ["engineering", "tech", "technology", "development", "rnd", "r-and-d"],
    words: /\b(?:CTO|chief technology officer|head of engineering|(?:software|hardware|firmware|electronics|mechanical) engineer|developer|engineering (?:manager|lead))\b|разработчик|инженер/iu,
  },
  {
    domains: ["sales", "business-development", "bizdev"],
    words: /\b(?:head of sales|sales (?:manager|director|lead|representative|rep)|account (?:manager|executive)|business development (?:manager|lead))\b|търговски директор/iu,
  },
  {
    domains: ["marketing"],
    words: /\b(?:CMO|chief marketing officer|head of marketing|marketing (?:manager|director|lead|specialist))\b/iu,
  },
  {
    domains: ["hr", "people", "human-resources"],
    words: /\b(?:CHRO|HR (?:manager|director|lead)|head of people|recruiter|human resources)\b/iu,
  },
  {
    domains: ["legal"],
    words: /\b(?:general counsel|legal counsel|lawyer|attorney)\b|юрист|адвокат/iu,
  },
];

/** The role words a text holds, as written; an acronym counts only in capitals (a "Coo" is no COO). */
function roleWord(re: RegExp, text: string): string | null {
  const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(all)) {
    const hit = m[0];
    if (!/^[A-Z]{2,5}$/i.test(hit) || hit === hit.toUpperCase()) return hit;
  }
  return null;
}

export interface DomainSuggestion {
  suggested: string;
  reason: "role" | "neighbours";
  /** What says so, as a clause: `its role "COO" points to operations`, `4 of 5 linked pages are in finance`. */
  evidence: string;
}

/**
 * The domain an entity's neighbourhood says it belongs in, when that is not
 * the one it is filed under; null when nothing says so clearly.
 *  - `roleTexts`: what is said about the entity with it as the subject (a
 *    fact that opens with its name: "Maria Ivanova is the COO …", never
 *    "… is the COO of Acme") — a role there that maps to ONE domain that
 *    exists decides;
 *  - `neighbourDomains`: the domains of the content pages linked with it
 *    (either way) — a clear majority decides when no role does.
 * `known`: the domains that exist (configured, else the ones pages use).
 */
export function suggestDomain(
  current: string,
  roleTexts: readonly string[],
  neighbourDomains: readonly string[],
  known: ReadonlySet<string>,
): DomainSuggestion | null {
  const hits = new Map<string, { n: number; word: string }>();
  for (const role of ROLE_DOMAINS) {
    const domain = role.domains.find((d) => known.has(d));
    if (!domain) continue;
    for (const t of roleTexts) {
      const word = roleWord(role.words, t);
      if (!word) continue;
      const h = hits.get(domain) ?? { n: 0, word };
      h.n++;
      hits.set(domain, h);
    }
  }
  const roles = [...hits.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  if (roles.length > 0 && (roles.length === 1 || roles[0][1].n > roles[1][1].n)) {
    const [domain, { word }] = roles[0];
    if (domain === current) return null;
    return { suggested: domain, reason: "role", evidence: `its role "${word}" points to ${domain}` };
  }
  const counted = neighbourDomains.filter((d) => d !== GENERAL && d !== "");
  if (counted.length < DOMAIN_MIN_NEIGHBOURS) return null;
  const c = new Map<string, number>();
  for (const d of counted) c.set(d, (c.get(d) ?? 0) + 1);
  const [top, n] = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (top === current || !known.has(top)) return null;
  if (n / counted.length < DOMAIN_MAJORITY || (c.get(current) ?? 0) / counted.length > DOMAIN_OWN_MAX) return null;
  return { suggested: top, reason: "neighbours", evidence: `${n} of ${counted.length} linked pages are in ${top}` };
}

/** The domains that exist: the configured ones, else every domain at least three pages use (never `general`). */
export function knownDomains(pages: readonly HygienePage[], configured: readonly string[] = []): Set<string> {
  if (configured.length > 0) return new Set(configured.filter((d) => d !== GENERAL));
  const c = new Map<string, number>();
  for (const p of pages) c.set(p.fm.domain, (c.get(p.fm.domain) ?? 0) + 1);
  return new Set([...c.entries()].filter(([d, n]) => n >= 3 && d !== GENERAL).map(([d]) => d));
}

/** Whether `text` opens with one of `names` (any case): the fact is said of it, it is the subject. */
export function opensWith(text: string, names: readonly string[]): boolean {
  const hay = text.trim().toLowerCase();
  return names.some((raw) => {
    const name = raw.trim().toLowerCase();
    return name.length >= 3 && hay.startsWith(name) && !/[\p{L}\p{N}]/u.test(hay.charAt(name.length));
  });
}

export interface DomainMismatch extends DomainSuggestion {
  path: string;
  domain: string;
}

/**
 * The entity pages filed under a domain their neighbourhood disagrees with.
 * `linked(path)`: the pages linked with a page either way (content pages);
 * only `paths` are judged (all entities when absent).
 */
export function domainMismatches(
  pages: readonly HygienePage[],
  linked: (path: string) => Iterable<string>,
  options: { configured?: readonly string[]; paths?: ReadonlySet<string> } = {},
): DomainMismatch[] {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const known = knownDomains(pages, options.configured ?? []);
  if (known.size < 2) return [];
  const out: DomainMismatch[] = [];
  for (const p of pages) {
    if (!isEntityPage(p) || (options.paths && !options.paths.has(p.path))) continue;
    const names = pageNames(p.fm);
    const neighbours = [...new Set(linked(p.path))].map((x) => byPath.get(x)).filter((x): x is HygienePage => !!x && x.path !== p.path);
    // What is said of it, its name the subject: its own facts and its neighbours'.
    const roleTexts = [p, ...neighbours].flatMap((n) => n.fm.claims.filter((c) => c.status !== "contested" && opensWith(c.text, names)).map((c) => c.text));
    const s = suggestDomain(p.fm.domain, roleTexts, neighbours.filter((n) => !isStructurePage(n)).map((n) => n.fm.domain), known);
    if (s) out.push({ path: p.path, domain: p.fm.domain, ...s });
  }
  return out;
}

function isStructurePage(p: HygienePage): boolean {
  return p.fm.structure !== undefined && p.fm.structure !== null;
}
