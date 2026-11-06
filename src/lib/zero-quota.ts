// ── A rate limit that is not a rate limit: the account's limit is ZERO ─────
//
// A real box, xAI (2026-10): `429 Too many requests for team … and model
// grok-4.6. Your team's rate limit is — Requests per Minute (actual/limit):
// 0/0. Your rate limit tier is determined based on your historical API
// spend…`. The core read it as a temporary throttle and retried the same model
// nine times over more than a minute, then said "The AI service needs a short
// break". No wait helps: the account has no quota for that model at all until
// the owner adds credit or picks another model. A 429 that merely says "too
// many" is still a throttle and keeps the normal retry; only a stated limit of
// zero is this.
//
// Matched on the providers' own wording, like every predicate in
// chat-error-text.ts, and narrow in both directions: the text must read as a
// rate-limit or quota refusal at all, AND state the limit as 0. Pure and
// client-safe — the chat's sentence and the server's confirmation (which reads
// the gateway's log line for the turn, src/lib/provider-model-fallback.ts) ask
// the same question of the same words.

/** The text reads as a rate-limit or quota refusal. */
const RATE_LIMIT_CONTEXT_RE = /(^|[^0-9])429([^0-9]|$)|too many requests|rate[ _-]?limit|resource[_ -]?exhausted|\bquota\b/i;

/**
 * The limit, stated as zero, in each provider's own shape. A digit, or a
 * decimal point with a digit after it, right after the 0 is a different number
 * (`0/60`, `limit: 0.5`); the full stop that ends the provider's sentence is not.
 */
const ZERO_LIMIT_RES: readonly RegExp[] = [
  // xAI: "Requests per Minute (actual/limit): 0/0" — the limit is the second.
  /\(\s*actual\s*\/\s*limit\s*\)\s*:?\s*\d+\s*\/\s*0(?!\d|\.\d)/i,
  // Google: "Quota exceeded for metric: …free_tier_requests, limit: 0".
  /\blimit\s*[:=]\s*0(?!\d|\.\d)/i,
  // OpenAI: "on requests per min (RPM): Limit 0, Used 0, Requested 1".
  /\blimit\s+0\s*,\s*used\b/i,
];

/** Does this refusal state that the account's limit for the model is zero? */
export function statesZeroRateLimit(text: string | null | undefined): boolean {
  const value = typeof text === "string" ? text : "";
  if (!value || !RATE_LIMIT_CONTEXT_RE.test(value)) return false;
  return ZERO_LIMIT_RES.some((re) => re.test(value));
}

/** The console where each provider's owner adds API credit, for the sentence that says to. */
const CREDIT_CONSOLES: Readonly<Record<string, string>> = {
  xai: "console.x.ai",
  openai: "platform.openai.com",
  google: "aistudio.google.com",
  anthropic: "console.anthropic.com",
};

export function creditConsoleFor(provider: string | null | undefined): string | null {
  const id = provider?.trim().toLowerCase();
  return id && Object.hasOwn(CREDIT_CONSOLES, id) ? CREDIT_CONSOLES[id] : null;
}
