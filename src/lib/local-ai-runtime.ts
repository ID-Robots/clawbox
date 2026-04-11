import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { startLlamaCppServer, stopLlamaCppServer } from "@/instrumentation-node";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import {
  getConfiguredLlamaCppModelAlias,
  getLlamaCppLaunchSpec,
  queryLlamaCppModels,
} from "@/lib/llamacpp-server";
import { readConfig } from "@/lib/openclaw-config";

const execFile = promisify(execFileCb);
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LOCAL_AI_PROXY_ROOT_URL = "http://127.0.0.1";
const DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OLLAMA_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export type LocalAiProvider = "llamacpp" | "ollama";

interface RuntimeState {
  activeRequests: number;
  idleTimer: NodeJS.Timeout | null;
  lastUsedAt: number | null;
  startPromise: Promise<void> | null;
}

const runtimeStates: Record<LocalAiProvider, RuntimeState> = {
  llamacpp: {
    activeRequests: 0,
    idleTimer: null,
    lastUsedAt: null,
    startPromise: null,
  },
  ollama: {
    activeRequests: 0,
    idleTimer: null,
    lastUsedAt: null,
    startPromise: null,
  },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, "");
}

export function getOllamaBaseUrl(): string {
  return normalizeBaseUrl(process.env.OLLAMA_HOST || DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL);
}

export function getLocalAiProxyRootUrl(): string {
  return normalizeBaseUrl(
    process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL || DEFAULT_LOCAL_AI_PROXY_ROOT_URL,
    DEFAULT_LOCAL_AI_PROXY_ROOT_URL,
  );
}

export function getLocalAiProxyBaseUrl(provider: LocalAiProvider): string {
  if (provider === "llamacpp") {
    return getLlamaCppProxyBaseUrl();
  }
  return `${getLocalAiProxyRootUrl()}/setup-api/local-ai/ollama`;
}

export function getLocalAiIdleTimeoutMs(): number {
  const raw = Number(process.env.LOCAL_AI_IDLE_TIMEOUT_MS || DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS;
}

async function getConfiguredLlamaCppAlias(): Promise<string> {
  const config = await readConfig();
  return getConfiguredLlamaCppModelAlias(config) || getDefaultLlamaCppModel();
}

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${getOllamaBaseUrl()}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForLlamaCppReady(alias: string): Promise<void> {
  const spec = getLlamaCppLaunchSpec(alias);
  const deadline = Date.now() + spec.startupTimeoutMs;

  while (Date.now() < deadline) {
    const models = await queryLlamaCppModels(spec.baseUrl);
    if (models.includes(alias) || models.length > 0) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for llama.cpp (${alias}) to become ready`);
}

async function waitForOllamaReady(): Promise<void> {
  const deadline = Date.now() + Number(process.env.OLLAMA_STARTUP_TIMEOUT_MS || DEFAULT_OLLAMA_STARTUP_TIMEOUT_MS);

  while (Date.now() < deadline) {
    if (await isOllamaReachable()) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for Ollama to become ready");
}

function clearIdleTimer(provider: LocalAiProvider) {
  const state = runtimeStates[provider];
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function scheduleIdleStop(provider: LocalAiProvider) {
  const idleTimeoutMs = getLocalAiIdleTimeoutMs();
  if (idleTimeoutMs <= 0) return;

  const state = runtimeStates[provider];
  clearIdleTimer(provider);
  state.idleTimer = setTimeout(() => {
    if (state.activeRequests > 0) {
      return;
    }
    void stopLocalAiProvider(provider).catch((err) => {
      console.warn(
        `[local-ai-runtime] Failed to stop ${provider} after idle timeout:`,
        err instanceof Error ? err.message : err,
      );
    });
  }, idleTimeoutMs);
  state.idleTimer.unref?.();
}

export function beginLocalAiUse(provider: LocalAiProvider) {
  const state = runtimeStates[provider];
  clearIdleTimer(provider);
  state.activeRequests += 1;
  state.lastUsedAt = Date.now();
}

export function endLocalAiUse(provider: LocalAiProvider) {
  const state = runtimeStates[provider];
  state.activeRequests = Math.max(0, state.activeRequests - 1);
  state.lastUsedAt = Date.now();
  if (state.activeRequests === 0) {
    scheduleIdleStop(provider);
  }
}

async function startOllamaIfNeeded(): Promise<void> {
  if (await isOllamaReachable()) {
    return;
  }

  try {
    await execFile("/usr/bin/systemctl", ["start", "ollama"], { timeout: 60_000 });
  } catch (err) {
    if (!(await isOllamaReachable())) {
      throw new Error(err instanceof Error ? err.message : "Failed to start Ollama");
    }
  }

  await waitForOllamaReady();
}

export async function ensureLocalAiReady(provider: LocalAiProvider): Promise<void> {
  clearIdleTimer(provider);

  const state = runtimeStates[provider];
  if (state.startPromise) {
    await state.startPromise;
    return;
  }

  const startPromise = (async () => {
    if (provider === "llamacpp") {
      const alias = await getConfiguredLlamaCppAlias();
      await startLlamaCppServer();
      await waitForLlamaCppReady(alias);
      return;
    }

    await startOllamaIfNeeded();
  })();

  state.startPromise = startPromise;

  try {
    await startPromise;
  } finally {
    if (state.startPromise === startPromise) {
      state.startPromise = null;
    }
  }
}

async function stopOllama(): Promise<void> {
  try {
    await execFile("/usr/bin/systemctl", ["stop", "ollama"], { timeout: 30_000 });
    return;
  } catch {
    const pgrep = await execFile("pgrep", ["-f", "ollama serve"], { timeout: 5_000 }).catch(() => null);
    const pids = pgrep?.stdout?.trim().split("\n").filter(Boolean) ?? [];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Best effort.
      }
    }
  }
}

export async function stopLocalAiProvider(provider: LocalAiProvider): Promise<void> {
  const state = runtimeStates[provider];
  clearIdleTimer(provider);
  state.activeRequests = 0;

  if (provider === "llamacpp") {
    await stopLlamaCppServer();
  } else {
    await stopOllama();
  }
}

export function getLocalAiRuntimeSnapshot(provider: LocalAiProvider) {
  const state = runtimeStates[provider];
  return {
    activeRequests: state.activeRequests,
    idleTimeoutMs: getLocalAiIdleTimeoutMs(),
    lastUsedAt: state.lastUsedAt,
    proxyBaseUrl: provider === "llamacpp" ? getLlamaCppProxyBaseUrl() : getLocalAiProxyBaseUrl(provider),
    upstreamBaseUrl: provider === "llamacpp" ? getLlamaCppBaseUrl() : getOllamaBaseUrl(),
  };
}
