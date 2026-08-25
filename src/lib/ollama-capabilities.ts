/**
 * Can THIS Ollama model think?
 *
 * Ollama refuses `reasoning_effort` on a model whose capabilities do not
 * include `thinking`, and it refuses it for every value except `none` —
 * measured on the device's own Ollama 0.32.15 with `qwen2.5:0.5b`:
 *
 *   POST /api/show {"model":"qwen2.5:0.5b"}
 *     → capabilities: ["completion","tools"]        (no "thinking")
 *   POST /v1/chat/completions … reasoning_effort=minimal|low|…|max|ultra
 *     → HTTP 400 {"error":{"message":"\"qwen2.5:0.5b\" does not support thinking"}}
 *   … reasoning_effort=none      → HTTP 200
 *   … no reasoning_effort field  → HTTP 200
 *
 * So the proxy needs one bit per model, and `/api/show` is where it lives.
 *
 * WHY A CACHE. The answer is a property of a GGUF, not of a request: it cannot
 * change while a model is loaded. Probing per turn would add a round trip to
 * the one backend whose whole selling point is that it is on this desk, and
 * `/api/show` on a cold Ollama is not free. A short TTL still lets a `pull` of
 * a same-named tag be noticed within the minute.
 *
 * WHY NULL IS A REAL ANSWER. "I could not ask" must not be collapsed into
 * "cannot think": that would silently disable thinking on a capable model every
 * time Ollama was slow to answer. Callers forward the body untouched on null —
 * see applyOllamaThinkingToChatBody.
 */

import { getOllamaBaseUrl } from "@/lib/local-ai-runtime";

const THINKING_CAPABILITY = "thinking";
const PROBE_TIMEOUT_MS = 3_000;
/** Long enough that a chat turn never pays for the probe twice, short enough
 *  that re-pulling a tag is picked up without a restart. */
export const OLLAMA_CAPABILITY_TTL_MS = 60_000;

interface CacheEntry {
  canThink: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — the cache is process-global, so a test must be able to clear it. */
export function _resetOllamaCapabilityCacheForTests(): void {
  cache.clear();
}

interface ShowPayload {
  capabilities?: unknown;
}

export type OllamaShowResult =
  /** Ollama answered for this model. `payload` is the parsed body, or null
   *  when the 200 was not JSON — which still proves the model exists. */
  | { status: "ok"; payload: unknown }
  /** Ollama answered, and it does not have this model. */
  | { status: "not-installed" }
  /** Ollama could not be asked. Never a verdict about the model. */
  | { status: "unreachable" };

/**
 * The one `/api/show` transport. Both askers — the thinking-capability probe
 * below and the save-time model check in ollama-model-context.ts — go through
 * here, so how this box addresses Ollama is decided in exactly one place.
 * Measured shape (Ollama 0.32.9, bench device): a missing model answers
 * HTTP 404 `{"error":"model '<id>' not found"}`; an installed one answers 200.
 */
export async function fetchOllamaShow(model: string, timeoutMs: number): Promise<OllamaShowResult> {
  const id = model.trim();
  if (!id) return { status: "not-installed" };

  let response: Response;
  try {
    response = await fetch(`${getOllamaBaseUrl()}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: id }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "unreachable" };
  }

  if (response.status === 404) return { status: "not-installed" };
  if (!response.ok) return { status: "unreachable" };

  try {
    return { status: "ok", payload: await response.json() };
  } catch {
    return { status: "ok", payload: null };
  }
}

/**
 * True/false when Ollama answered, null when it did not.
 *
 * A FAILED probe is not cached: the next turn should get a real answer rather
 * than inherit a minute of "unknown" from one slow moment.
 */
export async function ollamaModelCanThink(model: string): Promise<boolean | null> {
  const id = model.trim();
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < OLLAMA_CAPABILITY_TTL_MS) return hit.canThink;

  const result = await fetchOllamaShow(id, PROBE_TIMEOUT_MS);
  if (result.status !== "ok") return null;
  const payload = result.payload as ShowPayload | null;
  // An answer without a capabilities array is an Ollama too old to report
  // them. That is genuinely unknown, not "no" — an older build also predates
  // the capability CHECK that this probe exists to avoid tripping.
  if (!payload || !Array.isArray(payload.capabilities)) return null;
  const canThink = payload.capabilities.includes(THINKING_CAPABILITY);
  cache.set(id, { canThink, at: Date.now() });
  return canThink;
}
