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

import os from "os";
import fs from "fs/promises";
import { accessSync, constants as fsConstants } from "fs";
import type { FileHandle } from "fs/promises";
import path from "./runtime-path";
import { DATA_DIR, getKnownMany, setMany } from "./config-store";
import { getLocalAiProxyRootUrl } from "./local-ai-proxy-url";
import {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_BATCH,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  EMBED_HF_FILE,
  EMBED_HF_REPO,
  EMBED_MODEL_ALIAS,
  EMBED_RUNTIME_SUBDIR,
  MIN_EMBED_BATCH,
  isLocalEmbeddingModelId,
  localEmbeddingModelSpec,
  localEmbeddingVariant,
  type LocalEmbeddingModelId,
  type LocalEmbeddingQuant,
} from "./embed-runtime-ids";
// Literals rather than an import of memory-shard-state.ts: that module is the
// client-safe end of the graph and this one is server only. Pinned equal by
// src/tests/unit/local-embedding-models.test.ts.
const LOCAL_MODEL_KEY = "memory_shard_local_model";
const LOCAL_QUANT_KEY = "memory_shard_local_model_quant";

export * from "./embed-runtime-ids";

const EMBED_RUNTIME_DIR = path.join(DATA_DIR, EMBED_RUNTIME_SUBDIR);
const EMBED_MODEL_DIR = path.join(EMBED_RUNTIME_DIR, "models");
const EMBED_LOG_PATH = path.join(EMBED_RUNTIME_DIR, "server.log");
const DEFAULT_LLAMACPP_BIN = "/usr/local/bin/llama-server";
// Where the Hugging Face CLI is, when HF_BIN does not say. The same resolution
// as src/lib/llamacpp-server.ts's, and the same reason: PATH holds `hf` on a PC
// whose owner installed it with anything but pipx, and naming a home path that
// holds nothing reported a missing CLI that was one directory over. The home
// fallback is the appliance's, whose unit PATH is systemd's bare default.
function defaultHfBin(): string {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    // Skip "" and any relative entry: `hf` resolved against the cwd is not the
    // host's CLI, and the cwd here is wherever the server happens to run.
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "hf");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not in this directory, or not executable by this user: keep looking.
    }
  }
  return path.join(os.homedir(), ".local", "bin", "hf");
}
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

/** Which catalog model, at which quant: what data/config.json records. */
export interface LocalEmbeddingSelection {
  id: LocalEmbeddingModelId;
  quant: LocalEmbeddingQuant;
}

/** The data/ directory every catalog GGUF lives in. */
export function getEmbedModelDir(): string {
  return EMBED_MODEL_DIR;
}

/**
 * The model the embedder runs when the index is local (TASK-2411).
 *
 * Absent, unreadable or not one of the catalog ids is the 0.6B: that is the
 * model every box ran before the choice existed, so a store that cannot be
 * read never moves a box onto a model it did not pick.
 */
export async function readActiveLocalEmbeddingModel(): Promise<LocalEmbeddingSelection> {
  const { values } = await getKnownMany([LOCAL_MODEL_KEY, LOCAL_QUANT_KEY]);
  const id = isLocalEmbeddingModelId(values[LOCAL_MODEL_KEY]) ? values[LOCAL_MODEL_KEY] : DEFAULT_LOCAL_EMBEDDING_MODEL_ID;
  return { id, quant: localEmbeddingVariant(id, values[LOCAL_QUANT_KEY] as string | undefined).quant };
}

/** Record the model the embedder runs. ONE write, so the id and its quant never disagree. */
export async function writeActiveLocalEmbeddingModel(selection: LocalEmbeddingSelection): Promise<void> {
  const quant = localEmbeddingVariant(selection.id, selection.quant).quant;
  await setMany({ [LOCAL_MODEL_KEY]: selection.id, [LOCAL_QUANT_KEY]: quant });
}

export interface EmbedLaunchSpec {
  /** The catalog model this spec runs. */
  modelId: LocalEmbeddingModelId;
  /** Its vector width (the default slot's 1,024 when .env names another file). */
  dimensions: number;
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

/**
 * The launch spec for one model; with no selection, the DEFAULT slot.
 *
 * The default slot is the 0.6B as it always was, and the EMBED_* lines in .env
 * still move it (every box carries them, with the shipped values). A catalog
 * model other than the default is taken from the catalog alone — .env's
 * EMBED_MODEL/EMBED_HF_* describe the default slot and are not read for it —
 * the same rule scripts/embed-model-select.sh applies for the unit.
 */
export function getEmbedLaunchSpec(selection?: LocalEmbeddingSelection | null): EmbedLaunchSpec {
  const picked = selection && selection.id !== DEFAULT_LOCAL_EMBEDDING_MODEL_ID ? selection : null;
  const modelId = picked?.id ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID;
  const spec = localEmbeddingModelSpec(modelId);
  const hfFile = picked
    ? localEmbeddingVariant(picked.id, picked.quant).file
    : process.env.EMBED_HF_FILE?.trim() || EMBED_HF_FILE;
  return {
    modelId,
    dimensions: spec.dimensions,
    alias: picked ? picked.id : process.env.EMBED_MODEL?.trim() || EMBED_MODEL_ALIAS,
    baseUrl: getEmbedBaseUrl(),
    healthUrl: getEmbedHealthUrl(),
    hfRepo: picked ? spec.hfRepo : process.env.EMBED_HF_REPO?.trim() || EMBED_HF_REPO,
    hfFile,
    binPath: process.env.LLAMACPP_BIN?.trim() || DEFAULT_LLAMACPP_BIN,
    hfBinPath: process.env.HF_BIN?.trim() || defaultHfBin(),
    modelDir: EMBED_MODEL_DIR,
    modelPath: path.join(EMBED_MODEL_DIR, hfFile),
    logPath: EMBED_LOG_PATH,
    batch: getEmbedBatch(),
    startupTimeoutMs: Number(process.env.EMBED_STARTUP_TIMEOUT_MS || DEFAULT_STARTUP_TIMEOUT_MS),
  };
}

/** The launch spec of the model the embedder runs now. */
export async function getActiveEmbedLaunchSpec(): Promise<EmbedLaunchSpec> {
  return getEmbedLaunchSpec(await readActiveLocalEmbeddingModel().catch(() => null));
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

/** Is the model of `spec` (by default the ACTIVE one) runnable here? */
export async function getEmbedProvisioningStatus(spec?: EmbedLaunchSpec): Promise<EmbedProvisioningStatus> {
  spec ??= await getActiveEmbedLaunchSpec();
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

/** How much of the end of the embedder's log is read for the reason it stopped. */
const FAILURE_TAIL_BYTES = 16 * 1024;
const FAILURE_REASON_MAX_CHARS = 300;

/**
 * Why the memory embedder stopped, from the last line its log has: the
 * start script's own refusal (scripts/start-embed-server.sh puts the reason
 * and the fix on its LAST line — a llama-server too old for a flag, a binary
 * that does not start) or llama-server's last word. Read only for a unit that
 * has FAILED; null when there is no log or nothing in it.
 *
 * For Settings → Local AI, whose detail lines carry no paths: every absolute
 * path in the line is cut to its last component.
 */
export async function readEmbedStopReason(logPath = EMBED_LOG_PATH): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(logPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, FAILURE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return embedStopReasonFromLog(buffer.toString("utf-8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The pure half of readEmbedStopReason: the log's text in, the reason out. */
export function embedStopReasonFromLog(text: string): string | null {
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  const reason = last
    .replace(/^\[embed\]\s*/, "")
    .replace(/(^|[\s'"(=:])\/(?:[^\s'"()/]+\/)*([^\s'"()/]+)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (!reason) return null;
  return reason.length > FAILURE_REASON_MAX_CHARS
    ? `${reason.slice(0, FAILURE_REASON_MAX_CHARS - 1).trimEnd()}…`
    : reason;
}

/**
 * WHICH model the running llama-server answers as: its `--alias`, from
 * `/v1/models`. Null when it does not answer. The wake path compares this with
 * the model the box is set to, so a server still holding the model the owner
 * just switched away from is restarted rather than asked to embed — vectors
 * from two models must never land in one index.
 */
export async function embedServedAlias(baseUrl = getEmbedBaseUrl(), timeoutMs = 2_000): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const id = body?.data?.[0]?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
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
