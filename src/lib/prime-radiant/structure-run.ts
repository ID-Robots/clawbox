/**
 * The structure pass on a vault (structure.ts is the pure plan): what it
 * reads around the pages — the open review items, the retired-id ledger, the
 * settings — and the cheap-model fallback for record types.
 *
 * The FALLBACK is capped and optional: a page that looks like one record of
 * many (identifiers.ts `recordPage`: a document word beside an identifier),
 * carries a date, and whose type the rules could not tell, may be asked of the
 * Flash model (never a verified page, which the pass does not rewrite) — at
 * most `structure.modelFallback` pages a run (settings, 0 =
 * never), in one call, titles and facts redacted first, the call recorded with
 * `recordCost`. A type it answers becomes the leaf's `record.by: model` (read
 * back from the page from then on); a page it calls none is remembered in
 * `pass_state` and not asked again until its title or facts change. A dry run
 * never asks.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import { estimateUsd, type CostRates } from "./cost-rates";
import { completeWithRetry, flashClient, type FlashClient } from "./flash-client";
import { recordPage } from "./identifiers";
import { recordCost } from "./ingest-store";
import { classifyRecord, isRecordType, readRecordFrontmatter, recordDate, RECORD_TYPES, type RecordType } from "./records";
import { redactText } from "./redact";
import { hasVerification } from "./schema";
import { listReviewItems, MAX_REVIEW_LIST } from "./review-store";
import type { PrimeRadiantSettings } from "./settings";
import { readRetiredLedger, stateDbExists, withStateDb } from "./state-db";
import { readStructureMeta, runStructurePass, type StructureReviewItem, type StructureRunResult } from "./structure";
import type { VaultPage, VaultSnapshot, VaultTx } from "./vault";

/** Facts of a page the model is shown, at most, and characters of each. */
const CLASSIFY_FACTS = 3;
const CLASSIFY_FACT_CHARS = 200;
/** Pages one call asks about: the answer (one short object a page) stays well inside one reply. */
export const CLASSIFY_BATCH = 100;

/** The answer's cap for a call of `pages` pages: about 20 tokens a `{"i": 123, "type": "bank-transfer"}`, plus slack. */
export function classifyMaxTokens(pages: number): number {
  return 256 + 24 * pages;
}
/** Pages remembered as "no record" by the model, newest kept. */
const MAX_REMEMBERED = 5_000;
const REMEMBERED_KEY = "structure_model_none";
/** Open review items read for the domain hubs, at most. */
const MAX_REVIEW_READ = 1_000;

export interface ClassifyCandidate {
  path: string;
  title: string;
  facts: string[];
  /** {@link changeKey} of what the model is shown: a change asks again. */
  key: string;
}

/**
 * What says a page changed since the model last saw it: its path and a
 * SHA-256 digest of the title and facts it would be shown. A content
 * fingerprint for change detection, kept in the box's own state database.
 */
export function changeKey(path: string, title: string, factTexts: readonly string[]): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify([title, factTexts])).digest("hex");
  return `${path}@${digest.slice(0, 16)}`;
}

/** Pages the rules could not type that look like records and carry a date, path order. */
export function modelCandidates(pages: readonly VaultPage[], remembered: ReadonlySet<string> = new Set()): ClassifyCandidate[] {
  const out: ClassifyCandidate[] = [];
  for (const p of pages) {
    if (!p.parsed.ok) continue;
    const fm = p.parsed.frontmatter;
    if (readStructureMeta(fm) || readRecordFrontmatter(fm) || !recordPage(fm.title, fm.type)) continue;
    // A verified page is never rewritten (structure.ts), so a type the model gave it would never be kept: asking again every night would spend the cap on it.
    if (hasVerification(fm)) continue;
    if (classifyRecord(p.path, fm) || !recordDate(fm).month) continue;
    const shownTitle = fm.title.slice(0, 200);
    const shownFacts = fm.claims.slice(0, CLASSIFY_FACTS).map((c) => c.text.slice(0, CLASSIFY_FACT_CHARS));
    const key = changeKey(p.path, shownTitle, shownFacts);
    if (remembered.has(key)) continue;
    // Redacted only now, for the call: the change key above is the page's own, kept on the box.
    const title = redactText(shownTitle).text;
    const facts = shownFacts.map((t) => redactText(t).text);
    out.push({ path: p.path, title, facts, key });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function buildClassifyPrompt(items: readonly ClassifyCandidate[]): { system: string; user: string } {
  return {
    system: "You sort business documents by kind. Answer with a JSON array only, no prose.",
    user: [
      `Kinds: ${RECORD_TYPES.join(", ")}, none.`,
      "invoice = an invoice or proforma; credit-note = a credit or debit note; receipt = a receipt or till slip; bank-transfer = a bank transfer or payment order;",
      "shipment = a waybill, parcel or delivery; customs = a customs or export declaration; ad-receipt = an advertising platform's receipt or invoice; none = anything else.",
      'For every item answer {"i": <its i>, "type": "<kind>"}.',
      "ITEMS (JSON):",
      JSON.stringify(items.map((it, i) => ({ i, title: it.title, facts: it.facts }))),
    ].join("\n"),
  };
}

/** Every `{i, type}` the answer holds wherever it sits; an index out of range, an unknown kind or one answered twice is dropped. */
export function parseClassifyResponse(text: string, count: number): Map<number, RecordType | "none"> {
  const out = new Map<number, RecordType | "none">();
  const twice = new Set<number>();
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    let o: unknown;
    try {
      o = JSON.parse(m[0]);
    } catch {
      continue;
    }
    const r = o as { i?: unknown; type?: unknown };
    if (typeof r.i !== "number" || !Number.isInteger(r.i) || r.i < 0 || r.i >= count) continue;
    const type = typeof r.type === "string" ? r.type.trim().toLowerCase() : "";
    if (type !== "none" && !isRecordType(type)) continue;
    if (out.has(r.i) && out.get(r.i) !== type) twice.add(r.i);
    out.set(r.i, type as RecordType | "none");
  }
  for (const i of twice) out.delete(i);
  return out;
}

function readRemembered(stateVault: string): string[] {
  if (!stateDbExists(stateVault)) return [];
  try {
    return withStateDb(stateVault, (db) => {
      const row = db.prepare("SELECT value FROM pass_state WHERE key = ?").get(REMEMBERED_KEY) as { value?: unknown } | undefined;
      const parsed = typeof row?.value === "string" ? JSON.parse(row.value) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    });
  } catch {
    return [];
  }
}

function saveRemembered(stateVault: string, keys: readonly string[], at: string): void {
  withStateDb(stateVault, (db) => {
    db.prepare(`INSERT INTO pass_state (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`).run(
      REMEMBERED_KEY,
      JSON.stringify(keys.slice(-MAX_REMEMBERED)),
      at,
    );
  });
}

export interface ModelFallbackResult {
  assigned: Map<string, RecordType>;
  candidates: number;
  asked: number;
  calls: number;
  usdEstimate: number;
  skipped?: string;
}

/**
 * Ask the cheap model for the types the rules could not tell, at most `cap`
 * pages, {@link CLASSIFY_BATCH} a call, each call's answer capped by its size
 * ({@link classifyMaxTokens}). A call that fails stops the rest (they are
 * asked another night); `asked` counts only the pages of calls that answered.
 * Never throws.
 */
export async function classifyWithModel(
  snapshot: Pick<VaultSnapshot, "pages">,
  options: { stateVault: string; cap: number; client?: FlashClient; rates: CostRates; runId?: string | null; now?: () => Date; dryRun?: boolean },
): Promise<ModelFallbackResult> {
  const now = options.now ?? (() => new Date());
  const remembered = readRemembered(options.stateVault);
  const candidates = modelCandidates(snapshot.pages, new Set(remembered));
  const result: ModelFallbackResult = { assigned: new Map(), candidates: candidates.length, asked: 0, calls: 0, usdEstimate: 0 };
  if (candidates.length === 0) return { ...result, skipped: "nothing_to_ask" };
  if (options.cap <= 0) return { ...result, skipped: "disabled" };
  if (options.dryRun) return { ...result, skipped: "dry_run" };
  const items = candidates.slice(0, options.cap);
  const client = options.client ?? flashClient();
  const none: string[] = [];
  for (let at = 0; at < items.length; at += CLASSIFY_BATCH) {
    const batch = items.slice(at, at + CLASSIFY_BATCH);
    try {
      const { response } = await completeWithRetry(client, { ...buildClassifyPrompt(batch), maxTokens: classifyMaxTokens(batch.length) });
      result.calls += 1;
      result.asked += batch.length;
      const usd = estimateUsd(response.model, response.usage, options.rates);
      result.usdEstimate += usd;
      try {
        recordCost(options.stateVault, {
          runId: options.runId ?? null,
          operation: "structure-classify",
          model: response.model,
          tokensIn: response.usage.promptTokens,
          tokensOut: response.usage.completionTokens,
          usdEstimate: usd,
          at: now().toISOString(),
        });
      } catch {
        /* the answer still counts */
      }
      for (const [i, type] of parseClassifyResponse(response.text, batch.length)) {
        if (type === "none") none.push(batch[i].key);
        else result.assigned.set(batch[i].path, type);
      }
    } catch (err) {
      result.skipped = err instanceof Error ? `failed: ${err.message.slice(0, 120)}` : "failed";
      break;
    }
  }
  if (none.length > 0) {
    const fresh = new Set(none);
    saveRemembered(options.stateVault, [...remembered.filter((k) => !fresh.has(k)), ...none], now().toISOString());
  }
  return result;
}

function openReviewItems(stateVault: string): StructureReviewItem[] {
  if (!stateDbExists(stateVault)) return [];
  const out: StructureReviewItem[] = [];
  try {
    for (let offset = 0; offset < MAX_REVIEW_READ; offset += MAX_REVIEW_LIST) {
      const page = listReviewItems(stateVault, { status: "open", limit: MAX_REVIEW_LIST, offset });
      out.push(...page.items.map((i) => ({ id: i.id, kind: i.kind, pages: i.pages, claimId: i.claimId ?? null })));
      if (page.items.length < MAX_REVIEW_LIST) break;
    }
  } catch {
    /* the hubs say what they can */
  }
  return out;
}

function retiredLedger(stateVault: string): string[] {
  if (!stateDbExists(stateVault)) return [];
  try {
    return readRetiredLedger(stateVault);
  } catch {
    return [];
  }
}

export interface StructureNowResult extends StructureRunResult {
  model: Omit<ModelFallbackResult, "assigned"> & { assigned: number };
}

/**
 * Plan and write the structure layer over `snapshot` (the nightly branch's,
 * or `main`'s for the maintenance action), each commit through `run`.
 */
export async function runStructure(
  snapshot: Pick<VaultSnapshot, "pages" | "indexBody">,
  run: (message: string, fn: (tx: VaultTx) => Promise<void>) => Promise<{ commit: string | null }>,
  options: {
    stateVault: string;
    settings: PrimeRadiantSettings;
    rates: CostRates;
    client?: FlashClient;
    /** Whether ClawBox AI can be asked: the fallback is skipped when not. */
    online: boolean;
    runId?: string | null;
    now?: () => Date;
    dryRun?: boolean;
  },
): Promise<StructureNowResult> {
  const now = options.now ?? (() => new Date());
  const s = options.settings.structure;
  const model = options.online
    ? await classifyWithModel(snapshot, { stateVault: options.stateVault, cap: s.modelFallback, client: options.client, rates: options.rates, runId: options.runId, now, dryRun: options.dryRun })
    : { assigned: new Map<string, RecordType>(), candidates: 0, asked: 0, calls: 0, usdEstimate: 0, skipped: "offline" };
  const result = await runStructurePass(snapshot, run, {
    now: now(),
    domains: options.settings.domains,
    company: s.company,
    enrichTop: s.enrichTop,
    reviewItems: openReviewItems(options.stateVault),
    ledgerRetired: retiredLedger(options.stateVault),
    assigned: model.assigned,
    dryRun: options.dryRun,
  });
  return { ...result, model: { ...model, assigned: model.assigned.size } };
}
