/**
 * The memory-search embedder: Qwen3-Embedding-0.6B on llama.cpp, run as the
 * system unit clawbox-embed.service.
 *
 * OpenClaw's memory search needs an embedding model on the box. Ollama used to
 * host it and launched its bundled llama.cpp with a 2,048-token batch, which
 * on this model reserves a 1.2 GB compute buffer for inputs that never come
 * (the largest measured across 153 real calls was 484 tokens) — 2.8 GB
 * resident, every time the agent was in use. The same weights on ClawBox's own
 * llama.cpp build, with the batch sized for the traffic and a cgroup cap,
 * predict ~2.0 GB on the GPU and measured 1.4 GB (697 MB anonymous) CPU-only,
 * with identical vectors (cosine 0.9995 against ollama's).
 *
 * The names and numbers live in embed-runtime-ids.ts (no imports, so the
 * inventory and its tests can use them); this module is the part that reads
 * the filesystem and the network. `scripts/start-embed-server.sh` carries the
 * same defaults as environment fallbacks and
 * `src/tests/unit/embed-server-pin.test.ts` pins the two together.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./config-store";
import { getLocalAiProxyRootUrl } from "./local-ai-proxy-url";
import {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_BATCH,
  EMBED_HF_FILE,
  EMBED_HF_REPO,
  EMBED_MODEL_ALIAS,
  EMBED_RUNTIME_SUBDIR,
  MIN_EMBED_BATCH,
} from "./embed-runtime-ids";

export * from "./embed-runtime-ids";

const EMBED_RUNTIME_DIR = path.join(DATA_DIR, EMBED_RUNTIME_SUBDIR);
const EMBED_MODEL_DIR = path.join(EMBED_RUNTIME_DIR, "models");
const EMBED_LOG_PATH = path.join(EMBED_RUNTIME_DIR, "server.log");
const DEFAULT_LLAMACPP_BIN = "/usr/local/bin/llama-server";
const DEFAULT_HF_BIN = "/home/clawbox/.local/bin/hf";
/** A first start with no GGUF on disk downloads ~640 MB inside the unit. */
const DEFAULT_STARTUP_TIMEOUT_MS = 20 * 60 * 1000;

function normalizeV1BaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return fallback;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fallback;
  }
  return url.pathname.split("/").filter(Boolean).at(-1) === "v1" ? trimmed : `${trimmed}/v1`;
}

/** Where llama-server listens, ending in `/v1` — the proxy appends the path. */
export function getEmbedBaseUrl(): string {
  return normalizeV1BaseUrl(process.env.EMBED_BASE_URL || DEFAULT_EMBED_BASE_URL, DEFAULT_EMBED_BASE_URL);
}

/** The server root: `/health`, `/tokenize` and `/detokenize` live outside `/v1`. */
export function getEmbedRootUrl(): string {
  return getEmbedBaseUrl().replace(/\/v1$/, "");
}

export function getEmbedHealthUrl(): string {
  return `${getEmbedRootUrl()}/health`;
}

/** What OpenClaw is pointed at: the bearer-authenticated wake-on-request proxy. */
export function getEmbedProxyBaseUrl(): string {
  return `${getLocalAiProxyRootUrl()}/setup-api/local-ai/embed/v1`;
}

/** The batch the unit will run with — the same rule the start script applies. */
export function getEmbedBatch(): number {
  const raw = Number(process.env.EMBED_BATCH || DEFAULT_EMBED_BATCH);
  return Number.isInteger(raw) && raw >= MIN_EMBED_BATCH ? raw : DEFAULT_EMBED_BATCH;
}

export interface EmbedLaunchSpec {
  alias: string;
  baseUrl: string;
  healthUrl: string;
  hfRepo: string;
  hfFile: string;
  binPath: string;
  hfBinPath: string;
  modelDir: string;
  modelPath: string;
  logPath: string;
  batch: number;
  startupTimeoutMs: number;
}

export function getEmbedLaunchSpec(): EmbedLaunchSpec {
  const hfFile = process.env.EMBED_HF_FILE?.trim() || EMBED_HF_FILE;
  return {
    alias: process.env.EMBED_MODEL?.trim() || EMBED_MODEL_ALIAS,
    baseUrl: getEmbedBaseUrl(),
    healthUrl: getEmbedHealthUrl(),
    hfRepo: process.env.EMBED_HF_REPO?.trim() || EMBED_HF_REPO,
    hfFile,
    binPath: process.env.LLAMACPP_BIN?.trim() || DEFAULT_LLAMACPP_BIN,
    hfBinPath: process.env.HF_BIN?.trim() || DEFAULT_HF_BIN,
    modelDir: EMBED_MODEL_DIR,
    modelPath: path.join(EMBED_MODEL_DIR, hfFile),
    logPath: EMBED_LOG_PATH,
    batch: getEmbedBatch(),
    startupTimeoutMs: Number(process.env.EMBED_STARTUP_TIMEOUT_MS || DEFAULT_STARTUP_TIMEOUT_MS),
  };
}

export interface EmbedProvisioningStatus {
  binPath: string;
  modelPath: string;
  binaryAvailable: boolean;
  modelAvailable: boolean;
  installed: boolean;
  /** Size of the GGUF on disk, or null when it is not there. */
  modelBytes: number | null;
}

export async function getEmbedProvisioningStatus(): Promise<EmbedProvisioningStatus> {
  const spec = getEmbedLaunchSpec();
  const [binaryAvailable, modelStat] = await Promise.all([
    fs.stat(spec.binPath).then(() => true, () => false),
    fs.stat(spec.modelPath).catch(() => null),
  ]);
  const modelAvailable = modelStat !== null && modelStat.isFile();
  return {
    binPath: spec.binPath,
    modelPath: spec.modelPath,
    binaryAvailable,
    modelAvailable,
    installed: binaryAvailable && modelAvailable,
    modelBytes: modelAvailable ? modelStat.size : null,
  };
}

/**
 * Is llama-server up AND finished loading the model? `/health` answers 503
 * while the weights are still being read and 200 `{"status":"ok"}` after —
 * a listening socket alone is not readiness, which is what the ollama-era
 * `/api/tags` probe got wrong for a cold start.
 */
export async function isEmbedHealthy(healthUrl = getEmbedHealthUrl(), timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === "ok";
  } catch {
    return false;
  }
}
