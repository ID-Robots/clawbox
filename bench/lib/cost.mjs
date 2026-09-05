// Money for a run, from the per-model usage the capture already sums and a
// pricing table the OWNER fills in (bench/pricing.json). The product records
// no cost by decision; the bench prices its own runs so "cost per task" can
// be a number the loop watches, and it never guesses: a model the table does
// not list is reported as unpriced, not as free.
import fs from "node:fs";

const PER_MILLION = 1_000_000;

/** Read the pricing table; a missing or broken file is an empty table (everything unpriced). */
export function loadPricing(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { currency: raw.currency ?? "USD", models: raw.models && typeof raw.models === "object" ? raw.models : {} };
  } catch {
    return { currency: "USD", models: {} };
  }
}

/** A model's rates, with the cache rates falling back to input's. Null when unlisted. */
export function ratesFor(pricing, model) {
  const row = pricing?.models?.[model];
  if (!row || typeof row !== "object") return null;
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
  const input = num(row.input, null);
  const output = num(row.output, null);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: num(row.cacheRead, input), cacheWrite: num(row.cacheWrite, input) };
}

/**
 * Price a run's usage: `byModel` is capture's shape — { model: { input,
 * output, cacheRead, cacheWrite, messages } }. Answers the total, the split
 * by model, and the models that could not be priced (their tokens are still
 * counted in `tokens`).
 */
export function costOfUsage(byModel, pricing) {
  const out = { totalUsd: 0, byModel: {}, unpriced: [], tokens: 0 };
  if (!byModel || typeof byModel !== "object") return out;
  for (const [model, u] of Object.entries(byModel)) {
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    out.tokens += input + output + cacheRead + cacheWrite;
    const rates = ratesFor(pricing, model);
    if (!rates) {
      out.unpriced.push(model);
      out.byModel[model] = { usd: null, priced: false, tokens: input + output + cacheRead + cacheWrite };
      continue;
    }
    const usd = (input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) / PER_MILLION;
    out.byModel[model] = { usd: round6(usd), priced: true, tokens: input + output + cacheRead + cacheWrite };
    out.totalUsd += usd;
  }
  out.totalUsd = round6(out.totalUsd);
  return out;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** "$0.0132" / "$1.20" — money as the report prints it. */
export function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
