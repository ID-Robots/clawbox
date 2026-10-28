// ── Ask the provider, before the chat is moved: can THIS account run that model? ──
//
// THE FAILURE (xAI, a test box, 2026-10). Grok 4.7 answered at 16:20; at 17:00
// the same account's quota ran out and xAI answered it with a 429 stating
// `Requests per Minute (actual/limit): 0/0`. The fallback confirmed it and
// moved the chat to the next newest model, Grok 4.6 — which had answered the
// same account with the same 0/0 earlier that day. The box moved the owner from
// one dead model onto another, and only the next refusal said so.
//
// A mark the box wrote down is one guard (src/lib/provider-model-availability.ts),
// but a mark is a record with an expiry, and a model nobody has tried on this
// account yet carries none. So before the fallback moves the chat onto a model
// with no live mark, it asks the provider once: one request, one output token,
// to that model with the credential the gateway would use. A zero limit is
// written down and the next model is asked; only a model that answers — or one
// the probe could not decide, which is what the fallback did before — is where
// the chat goes.
//
// WHY NOT THE HARNESS. The pinned core (2026.10.7) has `models.probe`, and it
// tries only the provider's CONFIGURED primary — the model that has just
// failed — and reports a stated limit of zero as a plain `rate_limit`. No core
// RPC asks about one chosen model while the gateway runs, so this asks the
// provider's own public API directly, with the credential read by
// `readGatewayProviderSecret` (src/lib/openclaw-auth-store.ts), and keeps
// nothing: no log line carries the credential or the provider's answer body.
//
// Wired for xAI only — the one provider whose models fall back
// (src/lib/provider-newest-model.ts). Server-only.

import { readGatewayProviderSecret } from "@/lib/openclaw-auth-store";
import { statesZeroRateLimit } from "@/lib/zero-quota";

/** What one probe proved about one model on this account. */
export type ModelProbeVerdict = "ok" | "zero_quota" | "not_found" | "unknown";

/** Each provider's OpenAI-compatible chat endpoint, the cheapest call that is held to the model's own limit. */
const PROBE_ENDPOINTS: Readonly<Record<string, string>> = {
  xai: "https://api.x.ai/v1/chat/completions",
};

/** A probe answers within this, or it decided nothing. */
export const PROBE_TIMEOUT_MS = 5_000;

/** How much of a refusal is read: enough for the provider's sentence, never a stream. */
const BODY_CAP = 4_000;

export function canProbeProvider(provider: string | null | undefined): boolean {
  const id = provider?.trim().toLowerCase();
  return !!id && Object.hasOwn(PROBE_ENDPOINTS, id);
}

/**
 * The provider's answer, read as a verdict. Narrow on purpose: only a 2xx is
 * "ok", only a refusal that STATES a zero limit is "zero_quota" (an ordinary
 * throttle proves the account has quota, and is not a reason to skip the
 * model — but it is not an answer either), only a 404 or a refusal naming an
 * unknown model is "not_found". Everything else is "unknown".
 */
export function classifyProbeAnswer(status: number, body: string): ModelProbeVerdict {
  if (status >= 200 && status < 300) return "ok";
  // The status goes in front: a body that does not repeat it still reads as a 429.
  if (status === 429 && statesZeroRateLimit(`429 ${body}`)) return "zero_quota";
  if (status === 404) return "not_found";
  if (status === 400 && /model[^.]{0,80}\b(does not exist|not found|is not available)|\bmodel_not_found\b/i.test(body)) return "not_found";
  return "unknown";
}

export interface ModelProbeDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readSecret?: (provider: string) => string | null;
  timeoutMs?: number;
}

/**
 * Ask `provider` whether this account can run `modelId`: one request, one
 * output token. Never throws; "unknown" when it cannot be asked (no endpoint,
 * no credential the box can spend, the network) or the answer decides nothing.
 */
export async function probeProviderModel(provider: string, modelId: string, deps: ModelProbeDeps = {}): Promise<ModelProbeVerdict> {
  const id = provider.trim().toLowerCase();
  const endpoint = Object.hasOwn(PROBE_ENDPOINTS, id) ? PROBE_ENDPOINTS[id] : null;
  if (!endpoint || !modelId) return "unknown";
  const secret = (deps.readSecret ?? ((p: string) => readGatewayProviderSecret(p)))(id);
  if (!secret) return "unknown";
  try {
    const res = await (deps.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) {
      // The one token is not wanted, only the status: let the socket go.
      await res.body?.cancel().catch(() => undefined);
      return "ok";
    }
    return classifyProbeAnswer(res.status, (await res.text().catch(() => "")).slice(0, BODY_CAP));
  } catch {
    return "unknown";
  }
}
