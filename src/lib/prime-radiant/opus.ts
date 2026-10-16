/**
 * The optional Opus tier of the nightly pass: a stronger model re-reads a
 * SAMPLE of the pages the Flash writer made, under hard caps.
 *
 * It is optional in every sense. Off unless the owner switches it on; when
 * it is on but no account can answer (none configured, offline, a refused
 * credential, a subscription at its usage limit), the pages it would have read
 * are marked `opus_pending: true` and the night goes on — the wiki is complete
 * without it. It never edits a fact: a claim Opus would change becomes a
 * review item (`kind: "opus"`) with the current text and Opus's text as the
 * candidates, and the page records `checked_by: opus`.
 *
 * WHO ANSWERS (opus-source.ts): an Anthropic API KEY from the box's account
 * pool first (the Messages API, below); otherwise the owner's Claude
 * SUBSCRIPTION through the `claude` CLI run headless — the way the coding
 * agent uses it, never by lifting its OAuth token into API calls.
 *
 * The queue, in order: pages already owed a check (`opus_pending`), pages the
 * night changed, pages named by an open review item, then a random share of
 * the other flash-checked pages (`sampleRate`). Verified and human-checked
 * pages are never queued.
 *
 * The caps are HARD. Pages: a night sends at most `maxPages` pages, whichever
 * account answers. Dollars (an API key only — a subscription call costs $0 at
 * the margin): before each call the worst case of that call (its prompt at the
 * input rate plus every token it may answer at the output rate) must fit under
 * what is left. The first call that does not fit ends the tier, and so does a
 * subscription at its usage limit or a coding-agent run that started (the
 * tier yields the owner's plan to it); every page still queued is marked
 * pending.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { estimateUsd, type CostRates } from "./cost-rates";
import { recordCost, type CostBasis } from "./ingest-store";
import { redactText } from "./redact";
import { addReviewItem, type ReviewItem } from "./review-store";
import { hasVerification, type PageFrontmatter } from "./schema";
import { DEFAULT_OPUS_MODEL } from "./settings";
import type { VaultPage, VaultTx } from "./vault";

export const OPUS_PAGES_PER_CALL = 4;
export const OPUS_MAX_TOKENS = 8_000;
const OPUS_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY_CHARS = 5_000;
const MAX_CLAIMS_PER_PAGE = 40;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface OpusUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
}

export interface OpusResponse {
  text: string;
  usage: OpusUsage;
  model: string;
}

export class OpusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpusUnavailableError";
  }
}

/** The subscription (or a key) answered "usage limit": nothing more tonight. */
export class OpusLimitError extends OpusUnavailableError {
  constructor(
    message: string,
    readonly resetsAt: number | null = null,
  ) {
    super(message);
    this.name = "OpusLimitError";
  }
}

/** The tier steps aside (a coding-agent run is working, the box is short of memory). */
export class OpusYieldError extends OpusUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "OpusYieldError";
  }
}

/** Which account answers: an API key, the Claude subscription, or nothing. */
export type OpusSource = "api_key" | "subscription" | "none";

export interface OpusClient {
  readonly model: string;
  /** Absent reads as `api_key` (priced, held to the dollar cap). */
  readonly source?: OpusSource;
  /** Throws {@link OpusUnavailableError} when no provider can answer. */
  complete(request: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<OpusResponse>;
}

/** Where the Opus tier's key comes from: the pool's first usable API key, or null. */
export type OpusKeyReader = () => Promise<string | null>;

async function poolApiKey(): Promise<string | null> {
  try {
    const { readUsableApiKey } = await import("@/lib/anthropic-accounts");
    return await readUsableApiKey();
  } catch {
    return null;
  }
}

/**
 * The owner's Anthropic API KEY from the box's provider config, and nothing
 * else: a background pass that spends unattended must never draw on a
 * connected Claude subscription (its OAuth token) or the `claude` terminal
 * sign-in. No key means unavailable, and the tier leaves its pages
 * `opus_pending`.
 */
export function createAnthropicOpusClient(
  model: string = DEFAULT_OPUS_MODEL,
  fetchImpl: typeof fetch = fetch,
  readKey: OpusKeyReader = poolApiKey,
): OpusClient {
  return {
    model,
    source: "api_key",
    async complete(request) {
      const key = await readKey().catch(() => null);
      if (!key) throw new OpusUnavailableError("no Anthropic API key is configured");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": key,
      };
      let res: Response;
      try {
        res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers,
          redirect: "manual",
          body: JSON.stringify({
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            output_config: { effort: "medium" },
            messages: [{ role: "user", content: request.user }],
          }),
          signal: AbortSignal.any([AbortSignal.timeout(OPUS_TIMEOUT_MS), ...(request.signal ? [request.signal] : [])]),
        });
      } catch (err) {
        throw new OpusUnavailableError(`Anthropic could not be reached (${err instanceof Error ? err.name : "error"})`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 429) throw new OpusLimitError("Anthropic answered 429");
        throw new OpusUnavailableError(`Anthropic answered ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new OpusUnavailableError("Anthropic answered something that is not JSON");
      }
      const b = (body ?? {}) as { content?: Array<{ type?: unknown; text?: unknown }>; usage?: Record<string, unknown>; stop_reason?: unknown };
      if (b.stop_reason === "refusal") throw new OpusUnavailableError("Opus declined the request");
      const text = (b.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.trim() === "") throw new OpusUnavailableError("Opus answered with no text");
      const u = b.usage ?? {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      const cacheRead = num(u.cache_read_input_tokens);
      return {
        text,
        model,
        usage: { promptTokens: num(u.input_tokens) + cacheRead, completionTokens: num(u.output_tokens), cacheHitTokens: cacheRead },
      };
    },
  };
}

const store = processStore("prime-radiant:opus-client", () => ({ override: null as OpusClient | null }));

/** Install the client the Opus tier uses instead of the API-key one (tests). `null` removes it. */
export function setOpusClientOverride(client: OpusClient | null): void {
  store.override = client;
}

/** The client a test installed, or null. */
export function opusClientOverride(): OpusClient | null {
  return store.override;
}

export function opusClient(model: string = DEFAULT_OPUS_MODEL): OpusClient {
  return store.override ?? createAnthropicOpusClient(model);
}

// ── the queue (pure) ──────────────────────────────────────────────────────

export type OpusReason = "pending" | "changed" | "review" | "sample";

export interface OpusQueueEntry {
  path: string;
  reason: OpusReason;
}

/** Pages Opus may read: valid, not verified, not already settled by a person. */
export function opusEligible(fm: PageFrontmatter): boolean {
  return fm.checked_by !== "human" && !hasVerification(fm);
}

export function buildOpusQueue(
  pages: readonly VaultPage[],
  options: { changed: ReadonlySet<string>; reviewPages: ReadonlySet<string>; sampleRate: number; random?: () => number },
): OpusQueueEntry[] {
  const random = options.random ?? Math.random;
  const out: OpusQueueEntry[] = [];
  const taken = new Set<string>();
  const add = (path: string, reason: OpusReason) => {
    if (taken.has(path)) return;
    taken.add(path);
    out.push({ path, reason });
  };
  const eligible = pages.filter((p) => p.parsed.ok && opusEligible(p.parsed.frontmatter));
  for (const p of eligible) if (p.parsed.ok && p.parsed.frontmatter.opus_pending) add(p.path, "pending");
  for (const p of eligible) if (options.changed.has(p.path)) add(p.path, "changed");
  for (const p of eligible) if (options.reviewPages.has(p.path)) add(p.path, "review");
  for (const p of eligible) if (p.parsed.ok && p.parsed.frontmatter.checked_by === "flash" && random() < options.sampleRate) add(p.path, "sample");
  return out;
}

// ── prompt and answer ─────────────────────────────────────────────────────

export const OPUS_SYSTEM_PROMPT = [
  "You are the senior reviewer of a company wiki written by a cheaper model.",
  "For each page, read its claims against its own body. Flag a claim that the body does not support, that is wrong as written, or that contradicts another claim on the page.",
  'Answer with a JSON array only: [{"k": <n>, "verdict": "ok" | "edit", "claims": [{"id": "<claim id>", "text": "<your corrected text, or empty to remove>", "why": "<at most 20 words>"}], "note": "<at most 25 words>"}].',
  "List ONLY claims you would change. Never invent ids. Never write secret values; placeholders like [REDACTED:IBAN] stand for removed ones.",
  "A person decides every change: you propose, never resolve.",
].join("\n");

export interface OpusPageInput {
  k: number;
  title: string;
  claims: Array<{ id: string; text: string }>;
  body: string;
}

export function buildOpusPrompt(pages: readonly OpusPageInput[]): { system: string; user: string } {
  return { system: OPUS_SYSTEM_PROMPT, user: `PAGES (JSON):\n${JSON.stringify(pages)}` };
}

export interface OpusPageVerdict {
  verdict: "ok" | "edit";
  claims: Array<{ id: string; text: string; why: string }>;
  note: string;
}

export function parseOpusResponse(text: string, count: number): Map<number, OpusPageVerdict> {
  const out = new Map<number, OpusPageVerdict>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  const line = (v: unknown, max: number) => (typeof v === "string" ? redactText(v.replace(/\s+/g, " ").trim().slice(0, max)).text : "");
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const k = r.k;
    if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= count || out.has(k)) continue;
    if (r.verdict !== "ok" && r.verdict !== "edit") continue;
    const claims = Array.isArray(r.claims)
      ? r.claims.flatMap((c) => {
          if (!c || typeof c !== "object") return [];
          const o = c as Record<string, unknown>;
          return typeof o.id === "string" ? [{ id: o.id, text: line(o.text, 240), why: line(o.why, 200) }] : [];
        })
      : [];
    out.set(k, { verdict: r.verdict, claims: claims.slice(0, MAX_CLAIMS_PER_PAGE), note: line(r.note, 240) });
  }
  return out;
}

// ── the tier ──────────────────────────────────────────────────────────────

export type OpusStop = "unavailable" | "cap" | "pages" | "limit" | "busy";

export interface OpusTierResult {
  queued: number;
  reviewed: number;
  /** Pages left `opus_pending` (provider absent, a cap reached, a failed call). */
  pending: number;
  calls: number;
  usdEstimate: number;
  capUsd: number;
  /** The most pages this night could send. */
  maxPages: number;
  /** Who answered (or would have). */
  source: OpusSource;
  reviewItems: ReviewItem[];
  /**
   * Why the tier stopped short, when it did: `unavailable` (no account, a
   * failed call), `cap` (dollars), `pages` (the nightly page cap), `limit`
   * (the account's usage limit), `busy` (it yielded to a coding-agent run).
   */
  stopped: OpusStop | null;
  notes: string[];
}

export interface OpusTierOptions {
  stateVault: string;
  capUsd: number;
  /** The nightly page cap (default: no page cap beyond the queue). */
  maxPages?: number;
  rates: CostRates;
  client: OpusClient;
  runId?: string | null;
  signal?: AbortSignal;
  now?: () => Date;
}

/** The worst case of one call, in USD: every prompt token uncached plus every answer token allowed. */
export function worstCaseUsd(model: string, promptChars: number, rates: CostRates): number {
  const promptTokens = Math.ceil(promptChars / 3) + 500;
  return estimateUsd(model, { promptTokens, completionTokens: OPUS_MAX_TOKENS, cacheHitTokens: 0 }, rates);
}

function pageInput(page: VaultPage, k: number): OpusPageInput | null {
  if (!page.parsed.ok) return null;
  const fm = page.parsed.frontmatter;
  return {
    k,
    title: redactText(fm.title).text,
    claims: fm.claims.slice(0, MAX_CLAIMS_PER_PAGE).map((c) => ({ id: c.id, text: redactText(c.text).text })),
    body: redactText(page.parsed.body.slice(0, MAX_BODY_CHARS)).text,
  };
}

/**
 * Run the tier inside one vault operation (`tx`, on the night's branch): the
 * pages it read get `checked_by: opus`, the ones it could not reach get
 * `opus_pending: true`. Never throws for the model; a write failure is the
 * operation's to report.
 */
export async function runOpusTier(tx: VaultTx, queue: readonly OpusQueueEntry[], options: OpusTierOptions): Promise<OpusTierResult> {
  const now = options.now ?? (() => new Date());
  const source: OpusSource = options.client.source ?? "api_key";
  const priced = source !== "subscription";
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const result: OpusTierResult = {
    queued: queue.length,
    reviewed: 0,
    pending: 0,
    calls: 0,
    usdEstimate: 0,
    capUsd: options.capUsd,
    maxPages: Number.isFinite(maxPages) ? maxPages : queue.length,
    source,
    reviewItems: [],
    stopped: null,
    notes: [],
  };
  const model = options.client.model;
  let sent = 0;
  if (queue.length > 0 && priced && !options.rates.models[model]) {
    // No rate means no way to keep the cap: the tier does not start.
    result.stopped = "cap";
    result.notes.push(`There is no cost rate for ${model}, so the cap cannot be kept; add one in the settings.`);
  }
  const markPending = async (pages: readonly VaultPage[]) => {
    for (const p of pages) {
      if (!p.parsed.ok) continue;
      if (!p.parsed.frontmatter.opus_pending) await tx.writePage(p.path, { ...p.parsed.frontmatter, opus_pending: true }, p.parsed.body);
      result.pending += 1;
    }
  };

  for (let at = 0; at < queue.length; at += OPUS_PAGES_PER_CALL) {
    const pages = (await Promise.all(queue.slice(at, at + OPUS_PAGES_PER_CALL).map((q) => tx.read(q.path)))).filter(
      (p): p is VaultPage => !!p && p.parsed.ok,
    );
    if (pages.length === 0) continue;
    if (result.stopped || options.signal?.aborted) {
      await markPending(pages);
      continue;
    }
    if (sent + pages.length > maxPages) {
      result.stopped = "pages";
      result.notes.push(`The nightly limit of ${result.maxPages} pages for the second opinion was reached; the rest wait for the next night.`);
      await markPending(pages);
      continue;
    }
    const inputs = pages.map((p, k) => pageInput(p, k)).filter((x): x is OpusPageInput => !!x);
    const { system, user } = buildOpusPrompt(inputs);
    if (priced && result.usdEstimate + worstCaseUsd(model, system.length + user.length, options.rates) > options.capUsd) {
      result.stopped = "cap";
      result.notes.push(`The Opus cap of $${options.capUsd} was reached.`);
      await markPending(pages);
      continue;
    }
    let verdicts: Map<number, OpusPageVerdict>;
    try {
      sent += pages.length;
      const response = await options.client.complete({ system, user, maxTokens: OPUS_MAX_TOKENS, signal: options.signal });
      // A subscription call's tokens are real; its marginal cost is $0.
      const basis: CostBasis = priced ? "estimate" : "subscription";
      const usd = priced ? estimateUsd(response.model, response.usage, options.rates) : 0;
      result.calls += 1;
      result.usdEstimate += usd;
      try {
        recordCost(options.stateVault, {
          runId: options.runId ?? null,
          operation: "opus-review",
          model: response.model,
          tokensIn: response.usage.promptTokens,
          tokensOut: response.usage.completionTokens,
          usdEstimate: usd,
          at: now().toISOString(),
          basis,
        });
      } catch {
        /* a record, not a gate */
      }
      verdicts = parseOpusResponse(response.text, inputs.length);
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 120) : "error";
      if (err instanceof OpusLimitError) {
        result.stopped = "limit";
        result.notes.push(`The ${source === "subscription" ? "Claude subscription" : "Anthropic account"} reached its usage limit (${why}); the second opinion stops for tonight and its pages wait.`);
      } else if (err instanceof OpusYieldError) {
        result.stopped = "busy";
        result.notes.push(`The second opinion stepped aside (${why}); its pages wait for the next night.`);
      } else {
        result.stopped = "unavailable";
        result.notes.push(`Opus was not available (${why}); its pages wait.`);
      }
      await markPending(pages);
      continue;
    }
    for (let k = 0; k < pages.length; k++) {
      const page = pages[k];
      if (!page.parsed.ok) continue;
      const fm = page.parsed.frontmatter;
      const v = verdicts.get(k);
      if (!v) {
        await markPending([page]);
        continue;
      }
      result.reviewed += 1;
      await tx.writePage(page.path, { ...fm, checked_by: "opus", opus_pending: false }, page.parsed.body);
      if (v.verdict !== "edit") continue;
      for (const proposal of v.claims) {
        const current = fm.claims.find((c) => c.id === proposal.id);
        if (!current) continue; // an invented id
        const remove = proposal.text === "";
        const why = proposal.why || v.note;
        try {
          const { item } = addReviewItem(
            options.stateVault,
            {
              kind: "opus",
              claimId: current.id,
              pages: [page.path],
              // A removal has no second answer to pick: the item asks whether the
              // claim as written stands (pick it) or goes (dismiss and edit).
              candidates: [
                { text: current.text, page: page.path, claimId: current.id, evidence: [{ kind: "claim", page: page.path }] },
                ...(remove ? [] : [{ text: proposal.text, page: page.path, evidence: [{ kind: "opus-review", note: why, source: model }] }]),
              ],
              evidence: [{ kind: remove ? "opus-remove" : "opus-review", note: why, source: model }],
              dedupeKey: `opus:${current.id}:${remove ? "remove" : proposal.text.slice(0, 80)}`,
              runId: options.runId ?? null,
            },
            now().toISOString(),
          );
          result.reviewItems.push(item);
        } catch {
          result.notes.push("A review item could not be saved.");
        }
      }
    }
  }
  result.usdEstimate = Math.round(result.usdEstimate * 1e6) / 1e6;
  return result;
}
