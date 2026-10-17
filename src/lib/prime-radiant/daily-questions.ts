/**
 * Today's daily questions from the vault as it is: daily.ts's selection over
 * a snapshot of `main`, the open review items and the settings. Read-only —
 * nothing is created, nothing is sent (delivery is the assistant's, and only
 * when `verification.outbound` is on).
 *
 * SERVER ONLY.
 */

import { dailyOwners, DEFAULT_DAILY_LANGUAGE, pickDailyQuestions, type DailyLanguage, type DailyPage, type DailyQuestion, type DailyReviewItem } from "./daily";
import { buildLinkGraph, isContentPage } from "./links";
import { vaultDir } from "./paths";
import { listReviewItems } from "./review-store";
import { readSettings, type PrimeRadiantSettings } from "./settings";
import { stateDbExists } from "./state-db";
import { readVaultSnapshot, vaultInitialised, type VaultSnapshot } from "./vault";

export interface DailyOwnerEntry {
  owner: string;
  domains: string[];
  pages: number;
  language: DailyLanguage;
  /** Questions waiting for them today (at most the per-owner cap). */
  waiting: number;
}

export interface DailyAnswerBody {
  initialised: boolean;
  /** Whether the assistant may send the questions over chat (the owner's switch; off by default). */
  outbound: boolean;
  perOwner: number;
  owners: DailyOwnerEntry[];
  /** The owner asked about, with their questions; null when none was named. */
  owner: string | null;
  language: DailyLanguage | null;
  questions: DailyQuestion[];
}

export function languageOf(owner: string, settings: Pick<PrimeRadiantSettings, "verification">): DailyLanguage {
  return settings.verification.languages.find((l) => l.owner.toLowerCase() === owner.toLowerCase())?.language ?? DEFAULT_DAILY_LANGUAGE;
}

/** The pages with how many content pages link to each: what makes a hub. */
export function dailyPages(snapshot: VaultSnapshot): DailyPage[] {
  const graph = buildLinkGraph(
    snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, body: p.parsed.body })),
    snapshot.indexBody,
  );
  const out: DailyPage[] = [];
  for (const p of snapshot.pages) {
    if (!p.parsed.ok) continue;
    const inbound = [...(graph.inbound.get(p.path) ?? [])].filter((from) => from !== p.path && isContentPage(from)).length;
    out.push({ path: p.path, fm: p.parsed.frontmatter, inbound });
  }
  return out;
}

function openItems(vault: string): DailyReviewItem[] {
  if (!stateDbExists(vault)) return [];
  try {
    return listReviewItems(vault, { status: "open", limit: 200 }).items;
  } catch {
    return [];
  }
}

/**
 * Every owner with today's count, and — when `owner` is named — their
 * questions. An owner no page answers to gets an empty list, not an error.
 */
export async function readDailyQuestions(
  owner: string | null,
  options: { vault?: string; now?: Date; settings?: PrimeRadiantSettings } = {},
): Promise<DailyAnswerBody> {
  const vault = options.vault ?? vaultDir();
  const settings = options.settings ?? readSettings();
  const base = { outbound: settings.verification.outbound, perOwner: settings.verification.perOwner };
  if (!(await vaultInitialised(vault).catch(() => false))) {
    return { initialised: false, ...base, owners: [], owner, language: owner ? languageOf(owner, settings) : null, questions: [] };
  }
  const now = options.now ?? new Date();
  const input = { pages: dailyPages(await readVaultSnapshot(vault)), reviewItems: openItems(vault), domains: settings.domains, now };
  const ask = (o: string) => pickDailyQuestions(input, o, { perOwner: settings.verification.perOwner, language: languageOf(o, settings) });
  const owners = dailyOwners(input).map((o) => ({ ...o, language: languageOf(o.owner, settings), waiting: ask(o.owner).length }));
  const named = owner ? (owners.find((o) => o.owner.toLowerCase() === owner.toLowerCase())?.owner ?? owner) : null;
  return {
    initialised: true,
    ...base,
    owners,
    owner: named,
    language: named ? languageOf(named, settings) : null,
    questions: named ? ask(named) : [],
  };
}
