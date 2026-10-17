/**
 * The owner verification loop's daily questions. Pure.
 *
 * Each day every domain owner gets at most N questions (the settings'
 * `verification.perOwner`, 5 by default), in this order:
 *
 *   1. the open review items about their pages, oldest first;
 *   2. the unverified claims on their HUBS (a page five or more content pages
 *      link to, or a dated hub), METRICS and DECISIONS — one claim a page at a
 *      time, the most linked-to page first;
 *   3. their pages past the re-check day (recheck.ts), longest overdue first.
 *
 * A page's owner is its domain's owner in the settings, else the page's own
 * `owner` ("unassigned" is nobody). Each question is phrased short in the
 * owner's language (`verification.languages`), and names the tool its answer
 * goes back through — the existing verify / resolve / edit tools, so an
 * answer is a verification like any other and the question is gone from the
 * next list (any verification answers it: a claim stamped `verified` is no
 * longer unverified, and a verification restarts its page's re-check clock).
 * Nothing here sends anything: delivery is the assistant's, and only when the
 * owner turned it on (`verification.outbound`, off by default).
 */

import { recheckOf, recheckPassed } from "./recheck";
import type { PageFrontmatter } from "./schema";

export const DAILY_LANGUAGES = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"] as const;
export type DailyLanguage = (typeof DAILY_LANGUAGES)[number];
export const DEFAULT_DAILY_LANGUAGE: DailyLanguage = "en";

/** Questions an owner gets a day, by default. */
export const DEFAULT_DAILY_PER_OWNER = 5;
export const MIN_DAILY_PER_OWNER = 1;
export const MAX_DAILY_PER_OWNER = 20;
/** Content pages linking to a page that make it a hub. */
export const HUB_MIN_INBOUND = 5;
/** Nobody: a page with this owner and no domain owner gets no questions. */
export const NO_OWNER = "unassigned";
const MAX_QUOTED = 160;

export type DailyKind = "review" | "claim" | "recheck";

export interface DailyPage {
  path: string;
  fm: PageFrontmatter;
  /** Content pages linking to it (links.ts `buildLinkGraph`). */
  inbound: number;
}

export interface DailyReviewItem {
  id: string;
  kind: string;
  claimId: string | null;
  pages: readonly string[];
  candidates: ReadonlyArray<{ text: string; page: string | null }>;
  createdAt: string;
}

export interface DailyAnswer {
  /** The MCP tool the answer goes back through. */
  tool: "prime_radiant_review_resolve" | "prime_radiant_claim_verify" | "prime_radiant_page_edit";
  /** The arguments that name what is asked about. */
  args: Record<string, string>;
}

export interface DailyQuestion {
  kind: DailyKind;
  owner: string;
  domain: string;
  page: string;
  title: string;
  /** The review item asked about (kind `review`). */
  reviewId?: string;
  /** The claim asked about (kind `claim`, and a review item about one claim). */
  claimId?: string;
  /** The claim's text, or the review item's candidate answers. */
  text?: string;
  options?: string[];
  /** The page's re-check day (kind `recheck`). */
  due?: string;
  /** The question itself, short, in the owner's language. */
  question: string;
  answer: DailyAnswer;
}

export interface DailyInput {
  pages: readonly DailyPage[];
  /** OPEN review items (status `open`). */
  reviewItems: readonly DailyReviewItem[];
  domains: ReadonlyArray<{ name: string; owner: string }>;
  now: Date;
}

/** Who answers for a page: its domain's owner in the settings, else its own owner; null for nobody. */
export function pageOwner(fm: Pick<PageFrontmatter, "domain" | "owner">, domains: DailyInput["domains"]): string | null {
  const owner = domains.find((d) => d.name === fm.domain)?.owner ?? fm.owner;
  const o = typeof owner === "string" ? owner.trim() : "";
  return o === "" || o === NO_OWNER ? null : o;
}

function sameOwner(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

export function isHub(page: Pick<DailyPage, "fm" | "inbound">): boolean {
  return page.inbound >= HUB_MIN_INBOUND || (!!page.fm.hub && typeof page.fm.hub === "object");
}

function unverified(c: PageFrontmatter["claims"][number]): boolean {
  return !c.verified && c.status !== "verified" && c.historical !== true;
}

const quote = (s: string) => (s.length > MAX_QUOTED ? `${s.slice(0, MAX_QUOTED - 1)}…` : s);

// ── wording ────────────────────────────────────────────────────────────────

interface Wording {
  review: string;
  reviewOpen: string;
  claim: string;
  recheck: string;
}

/** Short on purpose: one line each, for a chat message. `{title}`, `{text}`, `{date}` are filled in. */
export const DAILY_WORDING: Readonly<Record<DailyLanguage, Wording>> = Object.freeze({
  en: {
    review: "Which is right about “{title}”?",
    reviewOpen: "A question about “{title}” is waiting for you.",
    claim: "Still true? “{text}” ({title})",
    recheck: "Is “{title}” still current? Its re-check was due {date}.",
  },
  bg: {
    review: "Кое е вярно за „{title}“?",
    reviewOpen: "Чака ви въпрос за „{title}“.",
    claim: "Още ли е вярно? „{text}“ ({title})",
    recheck: "Актуално ли е още „{title}“? Проверката беше за {date}.",
  },
  de: {
    review: "Was stimmt bei „{title}“?",
    reviewOpen: "Eine Frage zu „{title}“ wartet auf Sie.",
    claim: "Stimmt das noch? „{text}“ ({title})",
    recheck: "Ist „{title}“ noch aktuell? Die Prüfung war am {date} fällig.",
  },
  es: {
    review: "¿Qué es correcto sobre «{title}»?",
    reviewOpen: "Hay una pregunta sobre «{title}» esperándote.",
    claim: "¿Sigue siendo cierto? «{text}» ({title})",
    recheck: "¿Sigue vigente «{title}»? Su revisión vencía el {date}.",
  },
  fr: {
    review: "Qu’est-ce qui est juste pour « {title} » ?",
    reviewOpen: "Une question sur « {title} » vous attend.",
    claim: "Toujours vrai ? « {text} » ({title})",
    recheck: "« {title} » est-il encore à jour ? Sa vérification était prévue le {date}.",
  },
  it: {
    review: "Cosa è giusto su «{title}»?",
    reviewOpen: "Una domanda su «{title}» ti aspetta.",
    claim: "È ancora vero? «{text}» ({title})",
    recheck: "«{title}» è ancora attuale? La verifica era prevista il {date}.",
  },
  ja: {
    review: "「{title}」について正しいのはどれですか？",
    reviewOpen: "「{title}」についての質問があります。",
    claim: "今も正しいですか？「{text}」（{title}）",
    recheck: "「{title}」は今も最新ですか？再確認の期限は{date}でした。",
  },
  nl: {
    review: "Wat klopt er bij ‘{title}’?",
    reviewOpen: "Er wacht een vraag over ‘{title}’ op je.",
    claim: "Klopt dit nog? ‘{text}’ ({title})",
    recheck: "Is ‘{title}’ nog actueel? De controle stond op {date}.",
  },
  sv: {
    review: "Vad stämmer om ”{title}”?",
    reviewOpen: "En fråga om ”{title}” väntar på dig.",
    claim: "Stämmer det fortfarande? ”{text}” ({title})",
    recheck: "Är ”{title}” fortfarande aktuell? Kontrollen skulle göras {date}.",
  },
  zh: {
    review: "关于“{title}”，哪个是对的？",
    reviewOpen: "有一个关于“{title}”的问题等你回答。",
    claim: "仍然正确吗？“{text}”（{title}）",
    recheck: "“{title}”仍然是最新的吗？复查日期是{date}。",
  },
});

export function isDailyLanguage(v: unknown): v is DailyLanguage {
  return typeof v === "string" && (DAILY_LANGUAGES as readonly string[]).includes(v);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

// ── selection ──────────────────────────────────────────────────────────────

/** The owners who answer for at least one page, with their domains, sorted by name. */
export function dailyOwners(input: Pick<DailyInput, "pages" | "domains">): Array<{ owner: string; domains: string[]; pages: number }> {
  const byOwner = new Map<string, { owner: string; domains: Set<string>; pages: number }>();
  for (const p of input.pages) {
    const owner = pageOwner(p.fm, input.domains);
    if (!owner) continue;
    const key = [...byOwner.keys()].find((k) => sameOwner(k, owner)) ?? owner;
    const entry = byOwner.get(key) ?? { owner: key, domains: new Set<string>(), pages: 0 };
    entry.domains.add(p.fm.domain);
    entry.pages++;
    byOwner.set(key, entry);
  }
  for (const d of input.domains) {
    const o = d.owner.trim();
    if (o === "" || o === NO_OWNER) continue;
    const key = [...byOwner.keys()].find((k) => sameOwner(k, o)) ?? o;
    const entry = byOwner.get(key) ?? { owner: key, domains: new Set<string>(), pages: 0 };
    entry.domains.add(d.name);
    byOwner.set(key, entry);
  }
  return [...byOwner.values()]
    .map((e) => ({ owner: e.owner, domains: [...e.domains].sort(), pages: e.pages }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

/**
 * Today's questions for `owner`, at most `perOwner`, in the order the module
 * header gives, phrased in `language`. Deterministic for a given vault and
 * day: the same list until something is answered.
 */
export function pickDailyQuestions(input: DailyInput, owner: string, options: { perOwner?: number; language?: DailyLanguage } = {}): DailyQuestion[] {
  const cap = Math.max(MIN_DAILY_PER_OWNER, Math.min(MAX_DAILY_PER_OWNER, Math.floor(options.perOwner ?? DEFAULT_DAILY_PER_OWNER)));
  const words = DAILY_WORDING[options.language ?? DEFAULT_DAILY_LANGUAGE] ?? DAILY_WORDING.en;
  const mine = input.pages.filter((p) => p.fm.status !== "deprecated" && (() => {
    const o = pageOwner(p.fm, input.domains);
    return o !== null && sameOwner(o, owner);
  })());
  const byPath = new Map(mine.map((p) => [p.path, p]));
  const out: DailyQuestion[] = [];
  const askedClaims = new Set<string>();
  const askedPages = new Set<string>();

  // 1. open review items about their pages, oldest first
  const items = [...input.reviewItems].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));
  for (const item of items) {
    if (out.length >= cap) break;
    const page = item.pages.map((p) => byPath.get(p)).find(Boolean) ?? item.candidates.map((c) => (c.page ? byPath.get(c.page) : undefined)).find(Boolean);
    if (!page) continue;
    const options = item.candidates.map((c) => quote(c.text)).filter((t) => t !== "");
    out.push({
      kind: "review",
      owner,
      domain: page.fm.domain,
      page: page.path,
      title: page.fm.title,
      reviewId: item.id,
      ...(item.claimId ? { claimId: item.claimId } : {}),
      ...(options.length > 0 ? { options } : {}),
      question: fill(options.length > 1 ? words.review : words.reviewOpen, { title: quote(page.fm.title) }),
      answer: { tool: "prime_radiant_review_resolve", args: { id: item.id } },
    });
    if (item.claimId) askedClaims.add(item.claimId);
  }

  // 2. unverified claims on hubs, metrics and decisions — one claim a page a round
  const important = mine
    .filter((p) => p.fm.type === "metric" || p.fm.type === "decision" || isHub(p))
    .sort((a, b) => b.inbound - a.inbound || a.path.localeCompare(b.path));
  const queues = important.map((p) => ({ page: p, claims: p.fm.claims.filter((c) => unverified(c) && !askedClaims.has(c.id)) }));
  for (let round = 0; out.length < cap && queues.some((q) => q.claims.length > round); round++) {
    for (const q of queues) {
      if (out.length >= cap) break;
      const c = q.claims[round];
      if (!c) continue;
      askedClaims.add(c.id);
      askedPages.add(q.page.path);
      out.push({
        kind: "claim",
        owner,
        domain: q.page.fm.domain,
        page: q.page.path,
        title: q.page.fm.title,
        claimId: c.id,
        text: c.text,
        question: fill(words.claim, { text: quote(c.text), title: quote(q.page.fm.title) }),
        answer: { tool: "prime_radiant_claim_verify", args: { id: c.id } },
      });
    }
  }

  // 3. pages past their re-check day, longest overdue first
  const overdue = mine
    .filter((p) => !askedPages.has(p.path) && recheckPassed(p.fm, input.now))
    .map((p) => ({ p, due: recheckOf(p.fm).date as string }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.p.path.localeCompare(b.p.path)));
  for (const { p, due } of overdue) {
    if (out.length >= cap) break;
    out.push({
      kind: "recheck",
      owner,
      domain: p.fm.domain,
      page: p.path,
      title: p.fm.title,
      due,
      question: fill(words.recheck, { title: quote(p.fm.title), date: due }),
      answer: { tool: "prime_radiant_page_edit", args: { path: p.path } },
    });
  }
  return out;
}
