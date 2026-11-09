/**
 * The external AI engine (TASK-2376), the half both sides can import: ids,
 * limits, the input rule and display names. No fs, no fetch — Settings and the
 * chat import this file, so it stays free of anything a browser bundle cannot
 * carry. The server half is `external-engine.ts`, the harness writes are
 * `external-engine-ops.ts`.
 *
 * An external engine is an OpenAI-compatible endpoint the owner runs (an
 * inference cluster, a vLLM / SGLang / llama.cpp server on the machine or the
 * LAN) that takes the place of the on-device model as the box's Local AI. It is
 * registered under ONE provider id on both harnesses, `clawext`, beside the
 * ids ClawBox already owns there (`clawai`, `clawlocal`), so a provider an
 * owner wrote by hand under any other name is never ours to touch.
 */

/** The provider id on OpenClaw (`models.providers.clawext`) and on Hermes (`providers.clawext`). */
export const EXTERNAL_ENGINE_PROVIDER = "clawext";

/** The config-store key of the record (no secret in it — the key has its own 0600 file). */
export const EXTERNAL_ENGINE_STORE_KEY = "external_engine";

/** Hermes refuses a session on a model whose window is under this (`MINIMUM_CONTEXT_LENGTH`). */
export const HERMES_MIN_CONTEXT_WINDOW = 64_000;

export const EXTERNAL_ENGINE_LIMITS = {
  contextWindowMin: 1_024,
  contextWindowMax: 10_000_000,
  maxTokensMin: 256,
  modelIdMax: 200,
  apiKeyMax: 4_096,
  baseUrlMax: 2_048,
} as const;

export const EXTERNAL_ENGINE_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

export type ExternalEngineErrorCode =
  | "invalid_base_url"
  | "invalid_model"
  | "invalid_context_window"
  | "invalid_max_tokens"
  | "invalid_api_key"
  | "context_too_small_for_hermes"
  | "unreachable"
  | "unauthorized"
  | "model_not_listed"
  | "bad_response";

/** What the owner typed, validated. The API key travels beside it, never inside it. */
export interface ExternalEngineSettings {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  imageInput: boolean;
}

export type ValidationResult =
  | { ok: true; value: ExternalEngineSettings }
  | { ok: false; code: ExternalEngineErrorCode; field: keyof ExternalEngineSettings | "apiKey"; error: string };

/** `clawext/<model id>` — the reference OpenClaw's primary and the chat picker carry. */
export function externalEngineModelRef(modelId: string): string {
  return `${EXTERNAL_ENGINE_PROVIDER}/${modelId}`;
}

/** True for a `clawext/…` reference. */
export function isExternalEngineRef(ref: unknown): boolean {
  return typeof ref === "string" && ref.startsWith(`${EXTERNAL_ENGINE_PROVIDER}/`) && ref.length > EXTERNAL_ENGINE_PROVIDER.length + 1;
}

/**
 * The model's name as the chat header and the provider list show it: the id
 * minus its provider prefix and any organisation path, so `clawext/Qwen/Qwen3-32B`
 * reads "Qwen3-32B". Only the FIRST slash is the provider's — a vLLM id keeps
 * its own slashes in the reference.
 */
export function externalEngineDisplayName(modelIdOrRef: string): string {
  const id = isExternalEngineRef(modelIdOrRef)
    ? modelIdOrRef.slice(EXTERNAL_ENGINE_PROVIDER.length + 1)
    : modelIdOrRef;
  const last = id.split("/").filter(Boolean).pop();
  return (last || id).trim();
}

/**
 * Normalize a base URL: http(s) only, no credentials, query or fragment, no
 * trailing slash. Null when it is not one. Credentials in the URL are refused
 * rather than stripped: they would be a second secret riding in a field that
 * IS shown back to the owner and written to the logs as the endpoint.
 */
export function normalizeExternalBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > EXTERNAL_ENGINE_LIMITS.baseUrlMax) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  // The box's own Local AI proxy is the on-device model: "external" pointed at
  // it would start llama.cpp through the back door this feature closes.
  if (/\/setup-api\//.test(url.pathname)) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

function intIn(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n >= min && n <= max ? n : null;
}

// Printable, no whitespace, no leading dash (it reaches CLI argv on Hermes'
// fallback path), no characters a YAML or dotted config path would read as
// structure — and no wider than Hermes' own model-id rule
// (`HERMES_MODEL_ID_RE`), so one id works on both harnesses.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/;

/** Validate the settings half of a save or a test. */
export function validateExternalEngineInput(body: Record<string, unknown>): ValidationResult {
  const baseUrl = normalizeExternalBaseUrl(body.baseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      code: "invalid_base_url",
      field: "baseUrl",
      error: "Enter the engine's base URL, starting with http:// or https:// (for example http://192.0.2.10:8000/v1), with no user name, password or query in it.",
    };
  }
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (!modelId || modelId.length > EXTERNAL_ENGINE_LIMITS.modelIdMax || !MODEL_ID_RE.test(modelId) || modelId.includes("//")) {
    return { ok: false, code: "invalid_model", field: "modelId", error: "Enter the model id exactly as the engine lists it under /models." };
  }
  const contextWindow = body.contextWindow === undefined || body.contextWindow === ""
    ? EXTERNAL_ENGINE_DEFAULTS.contextWindow
    : intIn(body.contextWindow, EXTERNAL_ENGINE_LIMITS.contextWindowMin, EXTERNAL_ENGINE_LIMITS.contextWindowMax);
  if (contextWindow === null) {
    return {
      ok: false,
      code: "invalid_context_window",
      field: "contextWindow",
      error: `The context window is a whole number of tokens between ${EXTERNAL_ENGINE_LIMITS.contextWindowMin} and ${EXTERNAL_ENGINE_LIMITS.contextWindowMax}.`,
    };
  }
  const maxTokens = body.maxTokens === undefined || body.maxTokens === ""
    ? Math.min(EXTERNAL_ENGINE_DEFAULTS.maxTokens, contextWindow)
    : intIn(body.maxTokens, EXTERNAL_ENGINE_LIMITS.maxTokensMin, contextWindow);
  if (maxTokens === null) {
    return {
      ok: false,
      code: "invalid_max_tokens",
      field: "maxTokens",
      error: `Max output tokens is a whole number between ${EXTERNAL_ENGINE_LIMITS.maxTokensMin} and the context window.`,
    };
  }
  return {
    ok: true,
    value: { baseUrl, modelId, contextWindow, maxTokens, imageInput: body.imageInput === true },
  };
}

/**
 * The API key as typed, or null when none was given. Refused (a string, not
 * null) when it is not a single printable line — a newline in a key is a
 * paste accident, and in an Authorization header it is a header injection.
 */
export function parseExternalApiKey(raw: unknown): { ok: true; key: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, key: null };
  if (typeof raw !== "string") return { ok: false, error: "The API key must be text." };
  const key = raw.trim();
  if (!key) return { ok: true, key: null };
  if (key.length > EXTERNAL_ENGINE_LIMITS.apiKeyMax || /[\u0000-\u001f\u007f\s]/.test(key)) {
    return { ok: false, error: "The API key must be one line with no spaces." };
  }
  return { ok: true, key };
}
