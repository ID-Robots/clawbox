/**
 * The box's own engine as a model ClawBox's features can ask (TASK-2501 PR-C):
 * the model that holds the Local AI slot — llama.cpp or Ollama on this device,
 * or the owner's External engine (`clawext`) — asked OpenAI-style from server
 * code, the way Prime Radiant's writer and the picture describer ask ClawBox
 * AI's proxy.
 *
 * WHY THROUGH THE LOCAL AI PROXY, never the runtime's own port: the proxy is
 * what wakes a runtime the idle timer stopped, holds its lease for the length
 * of the answer (without it the idle timer can stop llama-server mid-call), and
 * folds `reasoning_effort` into each backend's own word for "thinking off"
 * (`local-ai-thinking.ts`). The memory embedder reaches its server the same
 * way. The External engine is the owner's own OpenAI-compatible server and is
 * asked directly, with the key the owner stored for it.
 *
 * WHAT ONE REQUEST MAY CARRY is part of the answer, not a guess left to the
 * caller: a model on this box has a window of tens of thousands of tokens (and
 * ClawBox's Ollama runs 4,096 unless the model sets its own), where ClawBox
 * AI's batches are sized for a far larger one. {@link LocalEngine} carries the
 * window, the longest answer and how many requests may be in flight, and
 * `token-estimate.ts` is the one conservative count every caller sizes
 * against.
 *
 * SERVER ONLY. Nothing here is logged with its key.
 */

import { getAll } from "@/lib/config-store";
import { externalEngineFromState, readExternalEngineKey, NO_KEY_PLACEHOLDER } from "@/lib/external-engine";
import { EXTERNAL_ENGINE_PROVIDER } from "@/lib/external-engine-shared";
import { getLlamaCppContextWindow, getLlamaCppMaxTokens, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { getLocalAiProxyRootUrl } from "@/lib/local-ai-proxy-url";
import { getLocalAiToken } from "@/lib/local-ai-token";
import type { OllamaShowResult } from "@/lib/ollama-capabilities";

// The llama.cpp launcher's config reader and the Ollama transport (which pulls
// the runtime supervisor) are loaded only when an engine is resolved: a module
// that merely asks a model — the picture describer, Prime Radiant — does not
// load a process manager to do it.
async function configuredLlamaCppAlias(): Promise<string | null> {
  const { resolveConfiguredLlamaCppAlias } = await import("@/lib/llamacpp-server");
  return await resolveConfiguredLlamaCppAlias();
}

async function ollamaShow(model: string): Promise<OllamaShowResult> {
  try {
    const { fetchOllamaShow } = await import("@/lib/ollama-capabilities");
    return await fetchOllamaShow(model, SHOW_TIMEOUT_MS);
  } catch {
    return { status: "unreachable" };
  }
}

export type LocalEngineKind = "llamacpp" | "ollama" | "clawext";

/** The model refs a cost row or a log names a local answer by: `<kind>/<model>`. */
export const LOCAL_ENGINE_REF_PREFIXES: readonly string[] = Object.freeze(["llamacpp/", "ollama/", `${EXTERNAL_ENGINE_PROVIDER}/`]);

/** Is `model` (as a cost row records it) one the box's own engine answered? */
export function isLocalEngineRef(model: unknown): boolean {
  return typeof model === "string" && LOCAL_ENGINE_REF_PREFIXES.some((p) => model.startsWith(p) && model.length > p.length);
}

export interface LocalEngine {
  kind: LocalEngineKind;
  /** What the request body names. */
  model: string;
  /** `<kind>/<model>`: what a cost row, a run's record and a log line say answered. */
  modelRef: string;
  /** Exactly where the POST goes. */
  chatUrl: string;
  /** The Authorization header's value. Never logged, never answered. */
  authorization: string;
  /** The window one request must fit in, prompt and answer together, in tokens. */
  contextTokens: number;
  /** The longest answer this engine is asked for, in tokens. */
  maxOutputTokens: number;
  /**
   * Requests in flight at once. One: the on-box runtimes serve the owner's chat
   * from the same slots, and a pass that filled them would stall it.
   */
  parallel: number;
  /**
   * Whether the model can look at a picture: the owner's own answer for an
   * External engine, null where it has to be asked (Ollama), false where the
   * runtime cannot (llama.cpp is launched with `--no-mmproj`).
   */
  imageInput: boolean | null;
}

/**
 * ClawBox's Ollama runs every model at this window unless the model sets its
 * own `num_ctx`: `CLAWBOX_OLLAMA_CONTEXT_LENGTH` in `scripts/optimize-ollama.sh`.
 * The OpenAI surface cannot ask for more per request, so this is the window.
 */
export const OLLAMA_DEFAULT_CONTEXT_TOKENS = 4_096;
/** The longest answer asked of Ollama: half its window, at most this. */
export const OLLAMA_MAX_OUTPUT_TOKENS = 4_096;
const SHOW_TIMEOUT_MS = 5_000;

function bare(stored: unknown, prefix: string): string {
  return typeof stored === "string" && stored.startsWith(prefix) ? stored.slice(prefix.length).trim() : "";
}

/**
 * The engine in the Local AI slot right now, or null when none is set up.
 *
 * An External engine wins: while one is selected the on-device chat runtimes
 * stay down (the proxy refuses to start them). Otherwise Local AI must be
 * switched on (`local_ai_configured`) with llama.cpp or Ollama. An unreadable
 * store is "none", like every other device setting.
 */
export async function resolveLocalEngine(): Promise<LocalEngine | null> {
  let state: Record<string, unknown>;
  try {
    state = await getAll();
  } catch {
    return null;
  }

  const external = externalEngineFromState(state);
  if (external) {
    const key = readExternalEngineKey() ?? NO_KEY_PLACEHOLDER;
    return {
      kind: "clawext",
      model: external.modelId,
      modelRef: `${EXTERNAL_ENGINE_PROVIDER}/${external.modelId}`,
      chatUrl: `${external.baseUrl}/chat/completions`,
      authorization: `Bearer ${key}`,
      contextTokens: external.contextWindow,
      maxOutputTokens: Math.min(external.maxTokens, external.contextWindow),
      parallel: 1,
      imageInput: external.imageInput,
    };
  }

  if (state.local_ai_configured !== true) return null;
  const proxyAuth = `Bearer ${getLocalAiToken()}`;

  if (state.local_ai_provider === "llamacpp") {
    const alias = (await configuredLlamaCppAlias().catch(() => null)) ?? (bare(state.local_ai_model, "llamacpp/") || null);
    if (!alias) return null;
    const contextTokens = getLlamaCppContextWindow();
    return {
      kind: "llamacpp",
      model: alias,
      modelRef: `llamacpp/${alias}`,
      chatUrl: `${getLlamaCppProxyBaseUrl()}/chat/completions`,
      authorization: proxyAuth,
      contextTokens,
      maxOutputTokens: getLlamaCppMaxTokens(),
      parallel: 1,
      imageInput: false,
    };
  }

  if (state.local_ai_provider === "ollama") {
    const model = bare(state.local_ai_model, "ollama/");
    if (!model) return null;
    // The model's own num_ctx when its Modelfile sets one; ClawBox's Ollama default otherwise.
    const show = await ollamaShow(model);
    // Ollama answered that it does not have the model: no engine to write with.
    // Unreachable is no verdict about the model (the proxy starts Ollama on the call).
    if (show.status === "not-installed") return null;
    const { ollamaServedContext } = await import("@/lib/ollama-model-context");
    const contextTokens = (show.status === "ok" ? ollamaServedContext(show.payload) : null) ?? OLLAMA_DEFAULT_CONTEXT_TOKENS;
    return {
      kind: "ollama",
      model,
      modelRef: `ollama/${model}`,
      chatUrl: `${getLocalAiProxyRootUrl()}/setup-api/local-ai/ollama/v1/chat/completions`,
      authorization: proxyAuth,
      contextTokens,
      maxOutputTokens: Math.min(OLLAMA_MAX_OUTPUT_TOKENS, Math.floor(contextTokens / 2)),
      parallel: 1,
      imageInput: null,
    };
  }

  return null;
}

/**
 * Can the engine look at a picture? The External engine's answer is the
 * owner's; Ollama is asked for the model's `vision` capability (unreachable is
 * "no" — a picture sent to a model that cannot read it is only a refusal);
 * llama.cpp runs without its vision projector.
 */
export async function localEngineSeesPictures(engine: LocalEngine): Promise<boolean> {
  if (engine.imageInput !== null) return engine.imageInput;
  if (engine.kind !== "ollama") return false;
  const show = await ollamaShow(engine.model);
  if (show.status !== "ok" || !show.payload || typeof show.payload !== "object") return false;
  const caps = (show.payload as { capabilities?: unknown }).capabilities;
  return Array.isArray(caps) && caps.includes("vision");
}

export interface LocalChatMessage {
  role: "system" | "user";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

export interface LocalChatBody {
  messages: LocalChatMessage[];
  max_tokens: number;
  temperature?: number;
}

/**
 * POST one chat completion to the engine and hand back its Response, unread:
 * the caller reads the answer (or the refusal) in its own words, as the
 * ClawBox AI clients do.
 *
 * Thinking is asked OFF on the box's own runtimes (`reasoning_effort: none`,
 * which the proxy turns into llama.cpp's template switch, or keeps for an
 * Ollama model that thinks and drops for one that cannot): a pass wants the
 * answer, and a small model's thinking spends the window it needs for it. The
 * External engine is sent no such field — an OpenAI-compatible server is free
 * to refuse one it does not know.
 */
export async function postLocalChat(
  engine: LocalEngine,
  body: LocalChatBody,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const payload: Record<string, unknown> = {
    model: engine.model,
    stream: false,
    ...body,
  };
  if (engine.kind !== "clawext") payload.reasoning_effort = "none";
  return await (options.fetchImpl ?? fetch)(engine.chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: engine.authorization },
    body: JSON.stringify(payload),
    cache: "no-store",
    // Never followed: a redirect would resend the owner's text to wherever it
    // points (an https engine answering 307 to an http address). A 3xx is an
    // answer the caller refuses like any other non-OK one.
    redirect: "manual",
    signal: options.signal,
  });
}
