/**
 * The rates Prime Radiant prices its model calls with — ONE object, so the
 * Costs view, a job's running total and the nightly cap all read the same
 * numbers, and the owner can replace them in the settings file.
 *
 * Every figure computed from these is an ESTIMATE (`basis: "estimate"`): the
 * upstream model's public list rates per million tokens, used to put an order
 * of magnitude on a job. What the account is actually charged is the ClawBox
 * AI plan's business, not this table's.
 *
 * Pure.
 */

export interface ModelRate {
  /** USD per million prompt tokens not served from the provider's cache. */
  input: number;
  /** USD per million prompt tokens served from the cache. */
  cachedInput: number;
  /** USD per million completion tokens. */
  output: number;
}

export interface CostRates {
  basis: "estimate";
  currency: "USD";
  unit: "per-million-tokens";
  models: Readonly<Record<string, ModelRate>>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
}

export const DEFAULT_COST_RATES: CostRates = Object.freeze({
  basis: "estimate",
  currency: "USD",
  unit: "per-million-tokens",
  models: Object.freeze({
    "deepseek-v4-flash": Object.freeze({ input: 0.14, cachedInput: 0.0028, output: 0.28 }),
    // The optional nightly Opus tier: the provider's public list rates.
    "claude-opus-5-5": Object.freeze({ input: 4, cachedInput: 0.2, output: 20 }),
  }),
});

/** Model ids a rate may be filed under. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_RATE = 10_000;
const MAX_MODELS = 32;

function rateNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_RATE ? v : null;
}

/**
 * An owner's override (`{ [model]: { input, cachedInput?, output } }`) read
 * strictly: a malformed one is refused whole with the reason, never repaired.
 */
export function readRateOverrides(raw: unknown): { ok: true; models: Record<string, ModelRate> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, models: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "costRates must be an object of model rates." };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_MODELS) return { ok: false, error: `costRates holds at most ${MAX_MODELS} models.` };
  const models: Record<string, ModelRate> = {};
  for (const [model, value] of entries) {
    if (!MODEL_ID_RE.test(model)) return { ok: false, error: `"${model.slice(0, 40)}" is not a model id.` };
    const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const input = rateNumber(v.input);
    const output = rateNumber(v.output);
    const cachedInput = v.cachedInput === undefined ? input : rateNumber(v.cachedInput);
    if (input === null || output === null || cachedInput === null) {
      return { ok: false, error: `The rate for ${model} needs input and output as numbers from 0 to ${MAX_RATE}.` };
    }
    models[model] = { input, cachedInput, output };
  }
  return { ok: true, models };
}

/** The defaults with an owner's overrides laid over them, model by model. */
export function mergeCostRates(overrides: Readonly<Record<string, ModelRate>> = {}): CostRates {
  return { ...DEFAULT_COST_RATES, models: { ...DEFAULT_COST_RATES.models, ...overrides } };
}

/**
 * The estimated USD of one call. A model with no rate is priced at 0 rather
 * than at another model's rate: an unpriced call is an unknown, and borrowing
 * a cheap model's rate would understate it without saying so.
 */
export function estimateUsd(model: string, usage: TokenUsage, rates: CostRates = DEFAULT_COST_RATES): number {
  const rate = rates.models[model];
  if (!rate) return 0;
  const miss = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const usd = (miss * rate.input + usage.cacheHitTokens * rate.cachedInput + usage.completionTokens * rate.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
