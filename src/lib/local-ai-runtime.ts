import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { startLlamaCppServer, stopLlamaCppServer } from "@/instrumentation-node";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import {
  getLlamaCppLaunchSpec,
  getLlamaCppProvisioningStatus,
  queryLlamaCppModels,
  resolveConfiguredLlamaCppAlias,
} from "@/lib/llamacpp-server";

const execFile = promisify(execFileCb);
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LOCAL_AI_PROXY_ROOT_URL = "http://127.0.0.1";
const DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OLLAMA_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
// Waking a model that is already on disk is a different operation from
// provisioning one that isn't. `spec.startupTimeoutMs` (20 min) is a *download*
// budget — sized for pulling a multi-GB GGUF over a slow link. Applying it to a
// wake meant a runtime that failed to start held the request open for 20
// minutes instead of erroring. Cold load of Gemma 4 E2B Q4_0 measured ~18 s on
// Jetson Orin, so 180 s is ~10x headroom and still fails inside any sane
// client timeout.
const DEFAULT_LLAMACPP_WAKE_TIMEOUT_MS = 180_000;

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
  // Resolves across every edition — see resolveConfiguredLlamaCppAlias. Reading
  // the OpenClaw config alone meant that on editions where it is silent this
  // always fell through to the default alias, so a device configured with a
  // non-default local model woke the wrong one.
  return (await resolveConfiguredLlamaCppAlias()) || getDefaultLlamaCppModel();
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

export function getLlamaCppWakeTimeoutMs(): number {
  const raw = Number(process.env.LLAMACPP_WAKE_TIMEOUT_MS || DEFAULT_LLAMACPP_WAKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LLAMACPP_WAKE_TIMEOUT_MS;
}

async function waitForLlamaCppReady(alias: string): Promise<void> {
  const spec = getLlamaCppLaunchSpec(alias);
  // Resolved lazily, only once the first poll misses. `ensureLocalAiReady` runs
  // on every proxied inference request, and when the runtime is already warm
  // the first poll returns immediately — so deciding the budget up front spent
  // two filesystem stats per request to compute a number nothing would read.
  let budgetMs: number | null = null;
  let deadline = Infinity;

  while (Date.now() < deadline) {
    const models = await queryLlamaCppModels(spec.baseUrl);
    if (models.includes(alias) || models.length > 0) {
      return;
    }
    if (budgetMs === null) {
      // Model already on disk → this is a wake, not a download. Only when the
      // GGUF is missing does start-llamacpp.sh fetch it, and only then is the
      // long provisioning budget the right one.
      const provisioning = await getLlamaCppProvisioningStatus(alias).catch(() => null);
      budgetMs = provisioning?.modelAvailable ? getLlamaCppWakeTimeoutMs() : spec.startupTimeoutMs;
      deadline = Date.now() + budgetMs;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out after ${Math.round((budgetMs ?? 0) / 1000)}s waiting for llama.cpp (${alias}) to become ready`,
  );
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
      // Pass the alias explicitly: reaching this function means a caller asked
      // for the local runtime, so the launcher must not re-derive whether it is
      // "configured" from a config file that belongs to another harness.
      const status = await startLlamaCppServer(alias);
      if (status === "skipped-disabled") {
        throw new Error("Local AI is turned off on this device. Enable Gemma 4 in Settings to use it.");
      }
      if (status === "skipped-not-configured") {
        // Defensive: with an explicit alias the launcher should never report
        // this. Failing here beats polling for a server nobody started.
        throw new Error(`llama.cpp did not start for ${alias} (no local model configured)`);
      }
      await waitForLlamaCppReady(alias);
      return;
    }

    await startOllamaIfNeeded();
  })();

  state.startPromise = startPromise;

  try {
    await startPromise;
  } finally {
    // Clear on BOTH paths. A failed attempt that stayed parked here made every
    // later request join a doomed wait, so the failure outlived its cause.
    if (state.startPromise === startPromise) {
      state.startPromise = null;
    }
    // Re-arm the idle-stop timer for callers that don't go through
    // begin/endLocalAiUse (the ollama pull/delete routes only call
    // ensureLocalAiReady). Without this, a pull/delete leaves a big model
    // resident forever on the 8GB Jetson. When activeRequests > 0 an
    // in-flight proxy request owns the lifecycle, so we leave it alone —
    // beginLocalAiUse will have cleared this timer anyway.
    if (state.activeRequests === 0) {
      scheduleIdleStop(provider);
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
