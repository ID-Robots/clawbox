/**
 * What Ollama says about a model — asked BEFORE the model is registered.
 *
 * Registration used to be a pure write: whatever id arrived was saved, the
 * route answered `{success:true}`, and the first chat turn was where the device
 * found out. Two of those failures are decidable up front and both were logged
 * against this box:
 *
 *  - the id names nothing on this machine, so every turn 404s upstream;
 *  - the model's window is smaller than the agent can run in, so every turn is
 *    refused before it reaches the model.
 *
 * `/api/show` answers both, and it is the SAME endpoint the agent itself probes
 * at runtime — so a save this module accepts is one the runtime will also
 * accept. The resolution order below mirrors that probe exactly (Ollama
 * 0.32.9, measured on the bench device): a missing model answers HTTP 404
 * `{"error":"model '<id>' not found"}`, an installed one answers 200 with
 * `parameters` and `model_info`.
 */

import { fetchOllamaShow } from "@/lib/ollama-capabilities";

/**
 * The smallest context window the Hermes agent will run in.
 *
 * Not our number: Hermes refuses to start a session below it
 * (`MINIMUM_CONTEXT_LENGTH = 64_000` in agent/model_metadata.py, enforced in
 * agent/agent_init.py) because tool-calling workflows cannot keep enough
 * working memory in a smaller window. A device that saves a 32K model is
 * therefore not "configured with a small model" — it is configured with a
 * model that answers nothing at all, which is why this is checked at save time
 * rather than left to the first message.
 */
export const HERMES_MINIMUM_CONTEXT_TOKENS = 64_000;

/** `/api/show` on a warm Ollama is fast; this only has to survive a cold one. */
const SHOW_TIMEOUT_MS = 5_000;

export type OllamaModelProbe =
  /** Ollama answered. `contextLength` is null when it reported no window. */
  | { status: "ok"; contextLength: number | null }
  /** Ollama answered, and it does not have this model. */
  | { status: "not-installed" }
  /** Ollama could not be asked. Never treated as a verdict about the model. */
  | { status: "unreachable" };

interface ShowPayload {
  parameters?: unknown;
  model_info?: unknown;
}

/**
 * Ollama's Modelfile `parameters` block is plain text, one directive per line
 * ("num_ctx    32768"). Only the last field of a `num_ctx` line is the value.
 */
function numCtxFromParameters(parameters: unknown): number | null {
  if (typeof parameters !== "string") return null;
  for (const line of parameters.split("\n")) {
    if (!line.includes("num_ctx")) continue;
    const parts = line.trim().split(/\s+/);
    const value = Number(parts[parts.length - 1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return null;
}

/**
 * The window the model will actually run with, from an `/api/show` payload.
 *
 * `num_ctx` FIRST and `model_info.*.context_length` second, which is the order
 * the agent uses for a local server and not the intuitive one: the GGUF's
 * context_length is the model's training maximum, while `num_ctx` is what
 * Ollama allocates KV cache for. Preferring the larger number would let a
 * conversation grow past the runtime limit, where Ollama silently truncates it.
 *
 * The `model_info` key is namespaced by architecture ("qwen2.context_length",
 * "llama.context_length", …), so it is matched by suffix rather than by name.
 */
export function contextLengthFromShow(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const { parameters, model_info: modelInfo } = payload as ShowPayload;

  const numCtx = numCtxFromParameters(parameters);
  if (numCtx !== null) return numCtx;

  if (modelInfo && typeof modelInfo === "object") {
    for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
      if (!key.endsWith("context_length")) continue;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    }
  }

  return null;
}

/** Ask Ollama about one model. Never throws — the caller decides what a
 *  failed question means, and "we could not ask" is not "the model is bad".
 *  The transport is ollama-capabilities' `fetchOllamaShow`, shared with the
 *  thinking probe, so the two can never address `/api/show` differently. */
export async function probeOllamaModel(model: string): Promise<OllamaModelProbe> {
  const result = await fetchOllamaShow(model, SHOW_TIMEOUT_MS);
  if (result.status !== "ok") return result;
  // A non-JSON 200 arrives as a null payload: the model exists, we simply
  // learned nothing about its window, and an unknown window is not a rejection.
  return { status: "ok", contextLength: contextLengthFromShow(result.payload) };
}
