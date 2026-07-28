// Which Codex model should a freshly-signed-in ChatGPT account default to?
//
// We can't answer that from a catalog. `openclaw models list --provider codex
// --all --json` returns the plugin's STATIC list — the same five ids for every
// account, entitled or not. gpt-5.6-{sol,terra,luna} are plan-gated upstream,
// and picking one the account can't use is not a soft failure: the upstream
// 400 is a surface error with no failover, so every single turn dies. That
// exact mistake pinned a session to gpt-5.6-sol on 2026-07-13 and broke it
// completely.
//
// Only the gpt-5.6 generation is gated. gpt-5.5 runs on every ChatGPT tier
// including Free, so it is the floor we fall back to rather than a candidate.
//
// So we ask the account itself. One cheap request per candidate, newest first,
// stopping at the first that answers. Deliberately biased toward the safe
// answer: we only upgrade off the fallback on a POSITIVE signal, and any
// ambiguity (auth trouble, rate limit, network, 5xx) leaves the caller on the
// universally-available default.

/** Newest first. gpt-5.5 is not here — it is the fallback everyone can use. */
export const CODEX_MODEL_PREFERENCE = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

/**
 * Available on every ChatGPT tier including Free; what we keep when the probe
 * can't improve on it. Only the gpt-5.6 generation is plan-gated, so there is
 * nothing to gain from probing gpt-5.5 — it would spend a round-trip during
 * setup to confirm a floor we already hold.
 */
export const CODEX_FALLBACK_MODEL = "gpt-5.5";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_PER_PROBE_TIMEOUT_MS = 6000;
const DEFAULT_TOTAL_BUDGET_MS = 15_000;

export type ProbeVerdict = "available" | "unavailable" | "indeterminate";

// Upstream's ways of saying "not this model, not this account". Kept broad on
// purpose: a false "unavailable" only costs the user a newer model, while a
// false "available" costs them a box where nothing works.
const MODEL_REJECTION_RE = new RegExp(
  [
    "requires a newer version",
    "model[_ ]not[_ ]found",
    "unsupported[_ ]model",
    "not supported",
    "unknown model",
    "do(?:es)? not have access",
    "not available",
    "no access",
    "upgrade",
    "plan",
    "subscription",
    "entitle",
  ].join("|"),
  "i",
);

/**
 * Classify a probe response.
 *
 * The subtle case is 400. Upstream validates the request body as well as the
 * model, so a 400 complaining about our payload shape (e.g. "Input must be a
 * list") means the model itself was accepted — that counts as available. A 400
 * naming the model or the plan does not.
 */
export function classifyProbeResponse(status: number, body: string): ProbeVerdict {
  if (status >= 200 && status < 300) return "available";
  if (status === 403 || status === 404) return "unavailable";
  if (status === 400) return MODEL_REJECTION_RE.test(body) ? "unavailable" : "available";
  // 401 (bad/expired token), 429 (rate limited), 5xx (upstream trouble): tells
  // us nothing about entitlement.
  return "indeterminate";
}

/** chatgpt_account_id from an OAuth access/id token, or null if unreadable. */
export function extractChatGptAccountId(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const auth = claims["https://api.openai.com/auth"] || {};
    return auth.chatgpt_account_id || auth.account_id || null;
  } catch {
    return null;
  }
}

function buildProbeBody(model: string): string {
  return JSON.stringify({
    model,
    // Smallest well-formed Responses request we can send. If the shape is ever
    // wrong upstream answers 400 with a payload complaint, which
    // classifyProbeResponse reads as "the model was fine".
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
    max_output_tokens: 16,
    stream: false,
    store: false,
  });
}

export interface ProbeOptions {
  accessToken: string;
  accountId?: string | null;
  candidates?: readonly string[];
  fetchImpl?: typeof fetch;
  perProbeTimeoutMs?: number;
  totalBudgetMs?: number;
  now?: () => number;
  onDiagnostic?: (message: string) => void;
}

export async function probeCodexModel(
  model: string,
  options: ProbeOptions,
): Promise<ProbeVerdict> {
  const {
    accessToken,
    accountId,
    fetchImpl = fetch,
    perProbeTimeoutMs = DEFAULT_PER_PROBE_TIMEOUT_MS,
  } = options;

  try {
    const res = await fetchImpl(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        // The app-server sends both; without the account header upstream can
        // reject with a 401 that has nothing to do with the model.
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        originator: "codex_cli_rs",
      },
      body: buildProbeBody(model),
      signal: AbortSignal.timeout(perProbeTimeoutMs),
    });
    const body = await res.text().catch(() => "");
    return classifyProbeResponse(res.status, body);
  } catch {
    // Timeout, DNS, offline box mid-setup — say nothing rather than guess.
    return "indeterminate";
  }
}

/**
 * Newest model this account can actually use, or null to keep the caller's
 * default. Stops at the first candidate that answers; gives up early on an
 * auth failure, since every later probe would fail the same way.
 */
export async function resolveEntitledCodexModel(options: ProbeOptions): Promise<string | null> {
  const {
    accessToken,
    candidates = CODEX_MODEL_PREFERENCE,
    totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
    now = Date.now,
    onDiagnostic,
  } = options;

  if (!accessToken?.trim()) return null;

  const accountId = options.accountId ?? extractChatGptAccountId(accessToken);
  const deadline = now() + totalBudgetMs;
  let sawIndeterminate = false;

  for (const model of candidates) {
    if (now() >= deadline) {
      onDiagnostic?.(`codex probe: budget exhausted before ${model}`);
      break;
    }
    const verdict = await probeCodexModel(model, { ...options, accountId });
    onDiagnostic?.(`codex probe: ${model} -> ${verdict}`);
    if (verdict === "available") return model;
    if (verdict === "indeterminate") {
      // One flaky probe is worth stepping past; two means the account or the
      // network is the problem, not entitlement, and further probes are noise.
      if (sawIndeterminate) break;
      sawIndeterminate = true;
    }
  }

  return null;
}
