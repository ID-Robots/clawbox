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
 *  2. DOMAIN MISMATCH — an entity filed under a domain its OWN facts say it
 *     is not in: a role a fact gives it as what it is ("Maria Ivanova is the
 *     COO of Acme" → an operations domain) when that domain exists. A role
 *     word anywhere else ("Acme's accountant is …", "the Developer Kit is a
 *     developer board") and the domains of its linked pages decide nothing:
 *     on a real vault both were wrong far more often than right. A
 *     suggestion, never a move: lint warns with it.
 *
 * Pure.
 */

import { transliterateCyrillic } from "./claims";
import { isPathAlias } from "./links";
import { hasVerification, type PageFrontmatter } from "./schema";

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

/** What may follow a role that is the whole complement: the sentence's end, a clause, or "of Acme", "at Globex", "since 2024". */
const ROLE_END_RE = /^(?:$|\s*[.,;:()]|\s+[\u2013\u2014-]|\s+(?:of|at|for|in|and|since|from|with|to|on|до|на|в|от|и)(?![\p{L}\p{N}]))/iu;

/**
 * The role a role phrase opens with, as written: the whole complement, never
 * the first word of a longer noun ("developer board"); an acronym counts only
 * in capitals (a "Coo" is no COO).
 */
function roleWord(re: RegExp, text: string): string | null {
  const m = new RegExp(`^(?:${re.source})`, re.flags.replace("g", "")).exec(text);
  if (!m) return null;
  const hit = m[0];
  if (/^[A-Z]{2,5}$/i.test(hit) && hit !== hit.toUpperCase()) return null;
  return ROLE_END_RE.test(text.slice(hit.length)) ? hit : null;
}

/** "is the", "serves as our", "е" …: what says the subject IS the role that follows. */
const ROLE_PREDICATE_RE = /^\s*(?:,\s*)?(?:is|serves as|works as|acts as|е|работи като)\s+(?:(?:the|our|their|its|a|an|acting|interim|senior|chief|lead)\s+)*/iu;

/**
 * The role phrase of a fact said of the entity — it opens with one of its
 * `names` and goes on "is the …" — or null: "Maria Ivanova is the COO of Acme"
 * gives "COO of Acme"; "Acme's accountant is Jane Roe" gives nothing.
 */
export function rolePhrase(text: string, names: readonly string[]): string | null {
  const hay = text.trim();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 3 || hay.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const m = ROLE_PREDICATE_RE.exec(hay.slice(name.length));
    if (m) return hay.slice(name.length + m[0].length);
  }
  return null;
}

export interface DomainSuggestion {
  suggested: string;
  reason: "role";
  /** What says so, as a clause: `its role "COO" points to operations`. */
  evidence: string;
}

/**
 * The domain an entity's own facts say it belongs in, when that is not the
 * one it is filed under; null when nothing says so clearly. `roleTexts`: the
 * role phrases of its facts ({@link rolePhrase}: "COO of Acme Widgets Ltd.")
 * — a role that maps to ONE domain that exists decides. `known`: the domains
 * that exist (configured, else the ones pages use).
 */
export function suggestDomain(current: string, roleTexts: readonly string[], known: ReadonlySet<string>): DomainSuggestion | null {
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
  if (roles.length === 0 || (roles.length > 1 && roles[0][1].n === roles[1][1].n)) return null;
  const [domain, { word }] = roles[0];
  if (domain === current) return null;
  return { suggested: domain, reason: "role", evidence: `its role "${word}" points to ${domain}` };
}

/** The domains that exist: the configured ones, else every domain at least three pages use (never `general`). */
export function knownDomains(pages: readonly HygienePage[], configured: readonly string[] = []): Set<string> {
  if (configured.length > 0) return new Set(configured.filter((d) => d !== GENERAL));
  const c = new Map<string, number>();
  for (const p of pages) c.set(p.fm.domain, (c.get(p.fm.domain) ?? 0) + 1);
  return new Set([...c.entries()].filter(([d, n]) => n >= 3 && d !== GENERAL).map(([d]) => d));
}

export interface DomainMismatch extends DomainSuggestion {
  path: string;
  domain: string;
}

/**
 * The entity pages filed under a domain their own facts disagree with (see
 * {@link suggestDomain}); only `paths` are judged (all entities when absent).
 */
export function domainMismatches(pages: readonly HygienePage[], options: { configured?: readonly string[]; paths?: ReadonlySet<string> } = {}): DomainMismatch[] {
  const known = knownDomains(pages, options.configured ?? []);
  if (known.size < 2) return [];
  const out: DomainMismatch[] = [];
  for (const p of pages) {
    if (!isEntityPage(p) || (options.paths && !options.paths.has(p.path))) continue;
    const names = pageNames(p.fm);
    // Only its own facts, and only what they say it IS: a neighbour's fact, or a role word elsewhere, is no evidence.
    const roleTexts = p.fm.claims.filter((c) => c.status !== "contested" && c.historical !== true).flatMap((c) => rolePhrase(c.text, names) ?? []);
    const s = suggestDomain(p.fm.domain, roleTexts, known);
    if (s) out.push({ path: p.path, domain: p.fm.domain, ...s });
  }
  return out;
}
