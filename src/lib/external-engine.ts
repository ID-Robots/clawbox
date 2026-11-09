import fs from "fs";
import path from "./runtime-path";
import { get, resolveConfigRoot } from "./config-store";
import {
  EXTERNAL_ENGINE_PROVIDER,
  EXTERNAL_ENGINE_STORE_KEY,
  externalEngineDisplayName,
  externalEngineModelRef,
  normalizeExternalBaseUrl,
  type ExternalEngineErrorCode,
  type ExternalEngineSettings,
} from "./external-engine-shared";

/**
 * The external AI engine (TASK-2376), server half: the record in the config
 * store, the API key's own file, and the `/models` probe that validates an
 * endpoint before anything is written. See external-engine-shared.ts for what
 * an external engine is; external-engine-ops.ts writes it into the harness.
 */

/** What the box was doing for Local AI before the engine was selected — restored on removal. */
export interface PreviousLocalAiState {
  /** The config-store keys exactly as they were; `null` = the key was absent. */
  store: Record<(typeof LOCAL_AI_STORE_KEYS)[number], unknown>;
  /**
   * OpenClaw: the chat primary before the save, and the fallback entries the
   * save took out (the on-device ones). Removal puts exactly those back, so a
   * fallback the owner changed in between stays as they left it.
   */
  openclaw?: { primary: string | null; removedFallbacks: string[] };
  /** Hermes: the selection, and whether the on-device model was registered there. */
  hermes?: { provider: string | null; model: string | null; localRegistered: boolean };
}

export interface ExternalEngineRecord extends ExternalEngineSettings {
  /** The provider id written into the harness — always `clawext`. */
  providerId: string;
  /** The harness the engine was applied to at the last save. */
  harness: "openclaw" | "hermes";
  savedAt: string;
  previous: PreviousLocalAiState;
}

export const LOCAL_AI_STORE_KEYS = [
  "local_ai_configured",
  "local_ai_provider",
  "local_ai_model",
  "local_ai_configured_at",
  "local_ai_was_default",
] as const;

/** What a key file holds when the engine needs no key: sent as `Bearer none`, which a keyless server ignores. */
export const NO_KEY_PLACEHOLDER = "none";

function keyPath(): string {
  return path.join(resolveConfigRoot(), "data", ".external-engine-key");
}

/** The stored API key, or null when none is on file. Never logged, never answered. */
export function readExternalEngineKey(): string | null {
  try {
    const key = fs.readFileSync(keyPath(), "utf-8").trim();
    return key ? key : null;
  } catch {
    return null;
  }
}

/** Write the key 0600, atomically (temp + rename), so a crash never leaves half a key. */
export function writeExternalEngineKey(key: string): void {
  const target = keyPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

export function deleteExternalEngineKey(): void {
  try {
    fs.unlinkSync(keyPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** The record from a store snapshot, or null when it is absent or not one ClawBox wrote. */
export function externalEngineFromState(state: Record<string, unknown> | null | undefined): ExternalEngineRecord | null {
  const raw = state?.[EXTERNAL_ENGINE_STORE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ExternalEngineRecord>;
  const baseUrl = normalizeExternalBaseUrl(r.baseUrl);
  if (!baseUrl || typeof r.modelId !== "string" || !r.modelId) return null;
  if (!isPositiveInt(r.contextWindow) || !isPositiveInt(r.maxTokens)) return null;
  const previous = r.previous && typeof r.previous === "object" ? r.previous as PreviousLocalAiState : { store: {} as PreviousLocalAiState["store"] };
  return {
    baseUrl,
    modelId: r.modelId,
    contextWindow: r.contextWindow,
    maxTokens: r.maxTokens,
    imageInput: r.imageInput === true,
    providerId: EXTERNAL_ENGINE_PROVIDER,
    harness: r.harness === "hermes" ? "hermes" : "openclaw",
    savedAt: typeof r.savedAt === "string" ? r.savedAt : "",
    previous: { ...previous, store: previous.store ?? ({} as PreviousLocalAiState["store"]) },
  };
}

/** Is an engine selected in this store snapshot? The rule every start gate applies. */
export function externalEngineSelectedIn(state: Record<string, unknown> | null | undefined): boolean {
  return externalEngineFromState(state) !== null;
}

/** The selected engine, or null. A store that cannot be read is "none selected" — the appliance default. */
export async function readExternalEngine(): Promise<ExternalEngineRecord | null> {
  try {
    return externalEngineFromState({ [EXTERNAL_ENGINE_STORE_KEY]: await get(EXTERNAL_ENGINE_STORE_KEY) });
  } catch {
    return null;
  }
}

/** Is an external engine the box's Local AI right now? The gate every llama.cpp / Ollama start asks. */
export async function externalEngineSelected(): Promise<boolean> {
  return (await readExternalEngine()) !== null;
}

/**
 * The engine as the status surfaces report it (setup/status, local-models,
 * llamacpp/status, the agent's `local_ai_status`): which model answers and
 * where. Null when none is selected. Never the key.
 */
export function externalEngineSummary(record: ExternalEngineRecord | null) {
  if (!record) return null;
  return {
    selected: true as const,
    providerId: record.providerId,
    modelRef: externalEngineModelRef(record.modelId),
    model: record.modelId,
    displayName: externalEngineDisplayName(record.modelId),
    baseUrl: record.baseUrl,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    imageInput: record.imageInput,
    harness: record.harness,
  };
}

/** The answer GET gives: everything but the key, and the key only as "one is on file". */
export function externalEngineView(record: ExternalEngineRecord | null) {
  if (!record) return { configured: false as const };
  const key = readExternalEngineKey();
  return {
    configured: true as const,
    providerId: record.providerId,
    modelRef: externalEngineModelRef(record.modelId),
    displayName: externalEngineDisplayName(record.modelId),
    baseUrl: record.baseUrl,
    modelId: record.modelId,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    imageInput: record.imageInput,
    apiKeySet: key !== null && key !== NO_KEY_PLACEHOLDER,
    harness: record.harness,
    savedAt: record.savedAt,
  };
}

/** The OpenClaw provider block (`models.providers.clawext`). */
export function openclawExternalProviderDefinition(settings: ExternalEngineSettings, apiKey: string | null) {
  return {
    baseUrl: settings.baseUrl,
    api: "openai-completions",
    apiKey: apiKey || NO_KEY_PLACEHOLDER,
    models: [
      {
        id: settings.modelId,
        name: externalEngineDisplayName(settings.modelId),
        reasoning: false,
        input: settings.imageInput ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: settings.contextWindow,
        maxTokens: settings.maxTokens,
      },
    ],
  };
}

// ── The /models probe ───────────────────────────────────────────────────────

export const PROBE_TIMEOUT_MS = 8_000;

export type ProbeResult =
  | { ok: true; models: string[]; latencyMs: number }
  | { ok: false; code: ExternalEngineErrorCode; error: string; status?: number; models?: string[] };

function networkCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  return e?.cause?.code || e?.code || e?.cause?.name || e?.name || "";
}

function modelIdsOf(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { data?: unknown; models?: unknown };
  const list = Array.isArray(p.data) ? p.data : Array.isArray(p.models) ? p.models : null;
  if (!list) return null;
  const ids: string[] = [];
  for (const entry of list) {
    const id = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? ((entry as { id?: unknown; model?: unknown; name?: unknown }).id
          ?? (entry as { model?: unknown }).model
          ?? (entry as { name?: unknown }).name)
        : null;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

/**
 * `GET {base}/models`, bounded, with the key as a bearer when there is one.
 *
 * Redirects are NOT followed: a 3xx to another host would carry the bearer
 * along, and the endpoint the owner typed is the one that gets written.
 * Errors name the endpoint and the status, never the key.
 */
export async function probeExternalEngine(options: {
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const url = `${options.baseUrl}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey && options.apiKey !== NO_KEY_PLACEHOLDER) headers.Authorization = `Bearer ${options.apiKey}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const code = networkCode(err);
    const timedOut = code === "TimeoutError" || code === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT";
    return {
      ok: false,
      code: "unreachable",
      error: timedOut
        ? `The engine at ${options.baseUrl} did not answer within ${Math.round(timeoutMs / 1000)} s.`
        : `Could not reach ${options.baseUrl}${code ? ` (${code})` : ""}. Check the address and that the engine is running and reachable from this box.`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      code: "unauthorized",
      status: res.status,
      error: `The engine refused the API key (HTTP ${res.status}). Check the key, or leave it empty if the engine needs none.`,
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      code: "bad_response",
      status: res.status,
      error: `The engine answered with a redirect (HTTP ${res.status}). Enter the address it redirects to.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "bad_response",
      status: res.status,
      error: res.status === 404
        ? `No model list at ${url} (HTTP 404). The base URL of an OpenAI-compatible server usually ends in /v1.`
        : `The engine answered HTTP ${res.status} to GET /models.`,
    };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, code: "bad_response", status: res.status, error: `The engine's /models answer is not JSON — is ${options.baseUrl} an OpenAI-compatible API?` };
  }
  const models = modelIdsOf(payload);
  if (!models) {
    return { ok: false, code: "bad_response", status: res.status, error: "The engine's /models answer has no model list (expected {\"data\": [{\"id\": …}]})." };
  }
  if (!models.includes(options.modelId)) {
    return {
      ok: false,
      code: "model_not_listed",
      status: res.status,
      models: models.slice(0, 50),
      error: models.length
        ? `The engine does not list "${options.modelId}". It lists: ${models.slice(0, 8).join(", ")}${models.length > 8 ? ", …" : ""}.`
        : `The engine lists no models, so "${options.modelId}" cannot be used.`,
    };
  }
  return { ok: true, models: models.slice(0, 50), latencyMs: Date.now() - started };
}
