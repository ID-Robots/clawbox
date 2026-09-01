import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { startLlamaCppServer, stopLlamaCppServer } from "@/instrumentation-node";
import { terminateByArgv } from "@/lib/process-match";
import { isOllamaExecutable } from "@/lib/local-models";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { getLocalAiProxyRootUrl } from "@/lib/local-ai-proxy-url";
import {
  getLlamaCppLaunchSpec,
  getLlamaCppProvisioningStatus,
  queryLlamaCppModels,
  resolveConfiguredLlamaCppAlias,
} from "@/lib/llamacpp-server";

export { getLocalAiProxyRootUrl } from "@/lib/local-ai-proxy-url";

const execFile = promisify(execFileCb);
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
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

export function getLocalAiProxyBaseUrl(provider: LocalAiProvider): string {
  if (provider === "llamacpp") {
    return getLlamaCppProxyBaseUrl();
  }
  return `${getLocalAiProxyRootUrl()}/setup-api/local-ai/ollama`;
}

/**
 * Where an OpenAI-compatible client must be pointed — NOT the same string as
 * the proxy's mount point above.
 *
 * The two differ for Ollama alone, and deliberately. OpenClaw addresses it
 * with `api: "ollama"`, i.e. the NATIVE surface (`/api/chat`, `/api/tags`),
 * which Ollama serves from the root — so its provider entry gets the mount
 * point unchanged. Hermes addresses it as a custom `api_mode: openai` provider
 * and appends `/chat/completions` to whatever base_url it is given, and
 * Ollama's OpenAI-compatible surface lives under `/v1`. Measured on the bench
 * device (Ollama 0.32.9): `POST /chat/completions` → 404 "404 page not found",
 * `POST /v1/chat/completions` → the OpenAI error shape; `GET /models` → 404,
 * `GET /v1/models` → 200.
 *
 * The proxy forwards the path verbatim, so the version segment has to travel
 * in the base URL the client is handed. llama.cpp needs no suffix here: its
 * proxy route is mounted at `/llamacpp/v1/[...path]`, so the version segment
 * is already part of the route.
 */
export function getLocalAiOpenAiBaseUrl(provider: LocalAiProvider): string {
  const base = getLocalAiProxyBaseUrl(provider);
  return provider === "llamacpp" ? base : `${base}/v1`;
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

// systemctl argv, verbatim, matching the Cmnd_Specs in config/clawbox-sudoers.
// sudoers matches the argument list EXACTLY, so these are literals and the unit
// carries its `.service` suffix — `ollama` and `ollama.service` are different
// strings to sudo even though they are the same unit to systemd.
const OLLAMA_ENABLE_NOW_ARGV = ["/usr/bin/systemctl", "enable", "--now", "ollama.service"];
const OLLAMA_START_ARGV = ["/usr/bin/systemctl", "start", "ollama.service"];
const OLLAMA_STOP_ARGV = ["/usr/bin/systemctl", "stop", "ollama.service"];

/**
 * Run a systemctl verb on ollama.service, through sudo first.
 *
 * The web server runs as `clawbox`, which does not own a system unit. The
 * unprivileged `systemctl start ollama` this used to issue therefore failed with
 * "Interactive authentication required" on any box whose sudoers is the shipped
 * one — which is how a device ended up with Local AI switched on in Settings and
 * ollama.service dead underneath it. Keep the unprivileged call as the fallback:
 * it is the one that works in dev shells and on boxes with a permissive polkit.
 */
async function systemctlOllama(argv: string[]): Promise<void> {
  try {
    await execFile("/usr/bin/sudo", ["-n", ...argv], { timeout: 60_000 });
    return;
  } catch (sudoErr) {
    try {
      await execFile(argv[0], argv.slice(1), { timeout: 60_000 });
    } catch {
      throw sudoErr instanceof Error ? sudoErr : new Error("systemctl call failed");
    }
  }
}

/**
 * Bring ollama.service up and, when asked, make that survive a reboot.
 *
 * `persist` is for the deliberate "turn Local AI on" action: enabling the unit
 * is what stops the choice from evaporating at the next boot. The on-demand wake
 * path leaves the unit's enabled-state alone, because Settings → Local Models
 * owns that switch and a wake must not silently undo an owner who turned it off.
 */
export async function startOllamaService(options: { persist?: boolean } = {}): Promise<void> {
  const persist = options.persist === true;
  if (!persist && (await isOllamaReachable())) {
    return;
  }

  try {
    await systemctlOllama(persist ? OLLAMA_ENABLE_NOW_ARGV : OLLAMA_START_ARGV);
  } catch (err) {
    if (!(await isOllamaReachable())) {
      throw new Error(err instanceof Error ? err.message : "Failed to start Ollama");
    }
  }

  await waitForOllamaReady();
}

async function startOllamaIfNeeded(): Promise<void> {
  await startOllamaService();
}

/**
 * Make a local provider actually runnable, for the enable path.
 *
 * Registering a model with Hermes while its runtime is down produces a device
 * that reports "configured" and 502s on the first message, so the enable path
 * waits for readiness before it writes any provider config.
 *
 * llama.cpp is only woken when its weights are already on disk. Otherwise the
 * launcher would DOWNLOAD a multi-GB GGUF inside this request — a 20-minute
 * budget the caller is an HTTP handler for. In that case the proxy provisions it
 * on first use, exactly as it does today.
 */
export async function activateLocalAiProvider(provider: LocalAiProvider): Promise<void> {
  if (provider === "ollama") {
    await startOllamaService({ persist: true });
    return;
  }
  const alias = await getConfiguredLlamaCppAlias();
  const provisioning = await getLlamaCppProvisioningStatus(alias).catch(() => null);
  if (!provisioning?.modelAvailable) return;
  await ensureLocalAiReady("llamacpp");
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
    // `stop`, never `disable`: this is also the idle-standby path, and a
    // standby that quietly un-enabled the unit would mean the model never came
    // back after a reboot.
    await systemctlOllama(OLLAMA_STOP_ARGV);
    return;
  } catch {
    // Was `pgrep -f "ollama serve"`, then SIGTERM to every hit. `-f` matches
    // the pattern anywhere in a process's full argv, and on this device a chat
    // turn runs as `hermes chat -q <the user's message>` — so a message
    // containing the words "ollama serve" put that text in a live process's
    // argv and this fallback terminated the turn. Same defect as the browser's
    // pkill, reachable from the local-AI stop endpoint and from the idle-stop
    // timer firing mid-turn.
    //
    // Select on the executable instead: argv[0] must BE ollama, and `serve`
    // must be its subcommand. That is both safe and more precise than the
    // substring match it replaces.
    await terminateByArgv(
      (argv) => isOllamaExecutable(argv[0]) && argv[1] === "serve",
      isOllamaExecutable,
    );
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
