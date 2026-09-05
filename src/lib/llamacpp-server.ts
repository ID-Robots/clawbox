import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import { CONFIG_ROOT, DATA_DIR, getAll } from "./config-store";
import {
  getDefaultLlamaCppFile,
  getDefaultLlamaCppModel,
  getDefaultLlamaCppRepo,
  getLlamaCppBaseUrl,
  getLlamaCppServerContextSize,
} from "./llamacpp";
import { inferConfiguredLocalModel, readConfig, type OpenClawConfig } from "./openclaw-config";

const LLAMACPP_RUNTIME_DIR = path.join(DATA_DIR, "llamacpp");
const LLAMACPP_PID_PATH = path.join(LLAMACPP_RUNTIME_DIR, "server.pid");
const LLAMACPP_LOG_PATH = path.join(LLAMACPP_RUNTIME_DIR, "server.log");
const DEFAULT_LLAMACPP_BIN = "/usr/local/bin/llama-server";
const DEFAULT_HF_BIN = "/home/clawbox/.local/bin/hf";
const DEFAULT_STARTUP_TIMEOUT_MS = 20 * 60 * 1000;

export interface LlamaCppLaunchSpec {
  alias: string;
  baseUrl: string;
  host: string;
  port: number;
  hfRepo: string;
  hfFile: string;
  binPath: string;
  hfBinPath: string;
  scriptPath: string;
  pidPath: string;
  logPath: string;
  modelDir: string;
  modelPath: string;
  contextWindow: number;
  startupTimeoutMs: number;
}

export interface LlamaCppProvisioningStatus {
  alias: string;
  binPath: string;
  modelPath: string;
  binaryAvailable: boolean;
  modelAvailable: boolean;
  installed: boolean;
}

/**
 * The alias recorded in ClawBox's own config store when the customer enabled
 * the local model, or null when they didn't.
 *
 * This is the edition-independent record. The OpenClaw config below can only
 * answer the question on editions that ship OpenClaw; on the others it is
 * silent, which is what used to make the local model unstartable.
 */
export function getLocalAiConfigStoreAlias(state: Record<string, unknown>): string | null {
  if (state["local_ai_configured"] !== true) return null;
  if (state["local_ai_provider"] !== "llamacpp") return null;
  const stored = state["local_ai_model"];
  // Stored fully-qualified ("llamacpp/gemma4-e2b-it-q4_0"); callers want the
  // bare alias. An empty or malformed value falls back to the default rather
  // than launching with a blank --alias.
  const bare = typeof stored === "string" ? stored.replace(/^llamacpp\//, "").trim() : "";
  return bare || getDefaultLlamaCppModel();
}

/**
 * Which llama.cpp model this device is configured to run, across every
 * edition — OpenClaw's agent config first (unchanged, so the OpenClaw/dual
 * SKUs keep their existing behaviour), then ClawBox's own config store.
 *
 * Both the on-demand wake path and the launcher resolve through here, so they
 * cannot disagree about which model to start. They previously did: the wake
 * path fell back to the *default* alias on editions where the OpenClaw config
 * is silent, so a device configured with a non-default local model woke the
 * wrong one.
 */
export async function resolveConfiguredLlamaCppAlias(): Promise<string | null> {
  const [config, state] = await Promise.all([
    readConfig().catch(() => ({} as OpenClawConfig)),
    getAll().catch(() => ({} as Record<string, unknown>)),
  ]);
  return getConfiguredLlamaCppModelAlias(config) ?? getLocalAiConfigStoreAlias(state);
}

export function getConfiguredLlamaCppModelAlias(config: OpenClawConfig): string | null {
  const primaryModel = config.agents?.defaults?.model?.primary?.trim();
  if (primaryModel && primaryModel.startsWith("llamacpp/")) {
    const alias = primaryModel.slice("llamacpp/".length).trim();
    return alias || getDefaultLlamaCppModel();
  }

  const localFallback = inferConfiguredLocalModel(config);
  if (localFallback?.provider === "llamacpp") {
    return localFallback.model.replace(/^llamacpp\//, "") || getDefaultLlamaCppModel();
  }

  return null;
}

export function getLlamaCppLaunchSpec(alias = getDefaultLlamaCppModel()): LlamaCppLaunchSpec {
  const baseUrl = getLlamaCppBaseUrl();
  const url = new URL(baseUrl);
  const hfRepo = getDefaultLlamaCppRepo();
  const hfFile = getDefaultLlamaCppFile();

  return {
    alias,
    baseUrl,
    host: url.hostname,
    port: Number(url.port || 80),
    hfRepo,
    hfFile,
    binPath: process.env.LLAMACPP_BIN?.trim() || DEFAULT_LLAMACPP_BIN,
    hfBinPath: process.env.HF_BIN?.trim() || DEFAULT_HF_BIN,
    // The checkout, not the cwd. In production the cwd is `.next/standalone`
    // (Next's standalone server.js chdirs there), so this resolved to a path
    // whose only occupant is whatever @vercel/nft happened to trace in — a
    // build artefact that refreshes on a full rebuild and not before. Every
    // other path in this spec already comes from CONFIG_ROOT via DATA_DIR;
    // the launcher script was the one that did not, so the script and the
    // runtime files it writes could come from two different trees.
    // src/instrumentation-node.ts resolves scripts/terminal-server.mjs the
    // same way, for the same reason.
    scriptPath: path.join(CONFIG_ROOT, "scripts", "start-llamacpp.sh"),
    pidPath: LLAMACPP_PID_PATH,
    logPath: LLAMACPP_LOG_PATH,
    modelDir: path.join(LLAMACPP_RUNTIME_DIR, "models"),
    modelPath: path.join(LLAMACPP_RUNTIME_DIR, "models", hfFile),
    contextWindow: getLlamaCppServerContextSize(),
    startupTimeoutMs: Number(process.env.LLAMACPP_STARTUP_TIMEOUT_MS || DEFAULT_STARTUP_TIMEOUT_MS),
  };
}

export async function ensureLlamaCppRuntimeDir() {
  await fs.mkdir(LLAMACPP_RUNTIME_DIR, { recursive: true });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function getLlamaCppProvisioningStatus(alias = getDefaultLlamaCppModel()): Promise<LlamaCppProvisioningStatus> {
  const spec = getLlamaCppLaunchSpec(alias);
  const [binaryAvailable, modelAvailable] = await Promise.all([
    pathExists(spec.binPath),
    pathExists(spec.modelPath),
  ]);

  return {
    alias,
    binPath: spec.binPath,
    modelPath: spec.modelPath,
    binaryAvailable,
    modelAvailable,
    installed: binaryAvailable && modelAvailable,
  };
}

export async function readLlamaCppPid(pidPath = LLAMACPP_PID_PATH): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidPath, "utf-8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writeLlamaCppPid(pid: number, pidPath = LLAMACPP_PID_PATH) {
  await fs.writeFile(pidPath, `${pid}\n`, "utf-8");
}

export async function clearLlamaCppPid(pidPath = LLAMACPP_PID_PATH) {
  await fs.unlink(pidPath).catch(() => {});
}

export function isLlamaCppPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function tailLlamaCppLog(logPath = LLAMACPP_LOG_PATH, maxBytes = 8192): Promise<string> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(logPath, "r");
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = Math.max(0, stat.size - start);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf-8").trim();
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function queryLlamaCppModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];

    const data = await res.json();
    return Array.isArray(data?.data)
      ? data.data
        .map((model: { id?: string }) => model?.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}
