import { execFile as execFileCb } from "child_process";
import fs from "fs/promises";
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
import {
  EMBED_UNIT,
  getEmbedBaseUrl,
  getEmbedLaunchSpec,
  getEmbedProvisioningStatus,
  getEmbedProxyBaseUrl,
  isEmbedHealthy,
  isLlamaServerExecutable,
  isEmbeddingServerArgv,
  type EmbedLaunchSpec,
} from "@/lib/embed-server";

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
// client timeout. The embedder's cold load measured 4 s and shares the budget.
const DEFAULT_LLAMACPP_WAKE_TIMEOUT_MS = 180_000;
// The embedder predicts ~2.0 GB resident on the GPU (embed-server.ts). Waking
// it into less than that plus a working margin does not fail the wake — it
// pushes whatever else is resident into swap and, on the day the build was
// OOM-killed at 1.6 GB, would have taken the build with it. Below this much
// MemAvailable the wake is refused; OpenClaw retries three times and answers
// the search keyword-only, which is the right outcome on a box that full.
const DEFAULT_EMBED_WAKE_MIN_AVAILABLE_MB = 2_300;

export type LocalAiProvider = "llamacpp" | "ollama" | "embed";

interface RuntimeState {
  activeRequests: number;
  idleTimer: NodeJS.Timeout | null;
  lastUsedAt: number | null;
  startPromise: Promise<void> | null;
}

function freshState(): RuntimeState {
  return { activeRequests: 0, idleTimer: null, lastUsedAt: null, startPromise: null };
}

const runtimeStates: Record<LocalAiProvider, RuntimeState> = {
  llamacpp: freshState(),
  ollama: freshState(),
  embed: freshState(),
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
  return PROVIDERS[provider].proxyBaseUrl();
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
 * in the base URL the client is handed. llama.cpp and the embedder need no
 * suffix here: their proxy routes are mounted at `/<engine>/v1/[...path]`, so
 * the version segment is already part of the route.
 */
export function getLocalAiOpenAiBaseUrl(provider: LocalAiProvider): string {
  const base = getLocalAiProxyBaseUrl(provider);
  return provider === "ollama" ? `${base}/v1` : base;
}

export function getLocalAiIdleTimeoutMs(): number {
  const raw = Number(process.env.LOCAL_AI_IDLE_TIMEOUT_MS || DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_LOCAL_AI_IDLE_TIMEOUT_MS;
}

export function getEmbedWakeMinAvailableMb(): number {
  const raw = Number(process.env.EMBED_WAKE_MIN_AVAILABLE_MB ?? DEFAULT_EMBED_WAKE_MIN_AVAILABLE_MB);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_EMBED_WAKE_MIN_AVAILABLE_MB;
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

async function isLlamaCppUp(): Promise<boolean> {
  const alias = await getConfiguredLlamaCppAlias();
  return (await queryLlamaCppModels(getLlamaCppLaunchSpec(alias).baseUrl)).length > 0;
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

/**
 * Arm the idle stop for a runtime that is already up — the one case the
 * request path never sees.
 *
 * The timer lives in this process. The embedder is a system unit, so it
 * outlives a web-server restart (every update restarts the web server) and
 * comes back into a process that has never heard of it: no request, no timer,
 * 2 GB resident until the next search happens to arm one. Called at boot for
 * the system-unit runtimes. Returns whether a timer was armed.
 */
export async function armIdleStopIfRunning(provider: LocalAiProvider): Promise<boolean> {
  const state = runtimeStates[provider];
  if (state.activeRequests > 0 || state.idleTimer) return false;
  if (!(await PROVIDERS[provider].isUp())) return false;
  scheduleIdleStop(provider);
  return true;
}

// systemctl argv, verbatim, matching the Cmnd_Specs in config/clawbox-sudoers.
// sudoers matches the argument list EXACTLY, so these are literals and the unit
// carries its `.service` suffix — `ollama` and `ollama.service` are different
// strings to sudo even though they are the same unit to systemd.
const OLLAMA_ENABLE_NOW_ARGV = ["/usr/bin/systemctl", "enable", "--now", "ollama.service"];
const OLLAMA_START_ARGV = ["/usr/bin/systemctl", "start", "ollama.service"];
const OLLAMA_STOP_ARGV = ["/usr/bin/systemctl", "stop", "ollama.service"];
const EMBED_START_ARGV = ["/usr/bin/systemctl", "start", "clawbox-embed.service"];
const EMBED_STOP_ARGV = ["/usr/bin/systemctl", "stop", "clawbox-embed.service"];

/**
 * Run a systemctl verb on a system unit, through sudo first.
 *
 * The web server runs as `clawbox`, which does not own a system unit. The
 * unprivileged `systemctl start ollama` this used to issue therefore failed with
 * "Interactive authentication required" on any box whose sudoers is the shipped
 * one — which is how a device ended up with Local AI switched on in Settings and
 * ollama.service dead underneath it. Keep the unprivileged call as the fallback:
 * it is the one that works in dev shells and on boxes with a permissive polkit.
 */
async function systemctlUnit(argv: string[]): Promise<void> {
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
    await systemctlUnit(persist ? OLLAMA_ENABLE_NOW_ARGV : OLLAMA_START_ARGV);
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

async function startLlamaCppAndWait(): Promise<void> {
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
}

async function memAvailableMb(): Promise<number | null> {
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf-8");
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** Has the unit gone to `failed` — i.e. is polling for readiness pointless? */
async function unitHasFailed(unit: string): Promise<boolean> {
  try {
    // Read-only and unprivileged; exit 0 means "failed".
    await execFile("/usr/bin/systemctl", ["is-failed", "--quiet", unit], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function lastLogLine(logPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.at(-1) ?? "";
  } catch {
    return "";
  }
}

async function waitForEmbedReady(spec: EmbedLaunchSpec): Promise<void> {
  let budgetMs: number | null = null;
  let deadline = Infinity;
  let polls = 0;

  while (Date.now() < deadline) {
    if (await isEmbedHealthy(spec.healthUrl)) return;
    if (budgetMs === null) {
      // GGUF on disk → a wake (4 s measured); missing → the start script is
      // downloading 640 MB and only the provisioning budget is honest.
      const provisioning = await getEmbedProvisioningStatus().catch(() => null);
      budgetMs = provisioning?.modelAvailable ? getLlamaCppWakeTimeoutMs() : spec.startupTimeoutMs;
      deadline = Date.now() + budgetMs;
    }
    polls += 1;
    // A unit that died (missing binary, bad flag) would otherwise be polled
    // for the whole budget. The reason is the last line of its log.
    if (polls % 5 === 0 && (await unitHasFailed(EMBED_UNIT))) {
      const reason = await lastLogLine(spec.logPath);
      throw new Error(`The memory embedder stopped while starting${reason ? `: ${reason}` : ""}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out after ${Math.round((budgetMs ?? 0) / 1000)}s waiting for the memory embedder to become ready`,
  );
}

/**
 * Wake clawbox-embed.service, or confirm it is already answering.
 *
 * `start`, never `enable`: the unit has no boot preference to keep. The
 * memory check comes before the start because the unit's own cgroup cap only
 * protects the box from the EMBEDDER — it cannot stop a wake from squeezing
 * the gateway or a running build; see DEFAULT_EMBED_WAKE_MIN_AVAILABLE_MB.
 */
async function startEmbedIfNeeded(): Promise<void> {
  const spec = getEmbedLaunchSpec();
  if (await isEmbedHealthy(spec.healthUrl)) return;

  const minMb = getEmbedWakeMinAvailableMb();
  if (minMb > 0) {
    const available = await memAvailableMb();
    if (available !== null && available < minMb) {
      throw new Error(
        `Not enough free memory to wake the memory embedder (${available} MB available, ${minMb} MB needed)`,
      );
    }
  }

  try {
    await systemctlUnit(EMBED_START_ARGV);
  } catch (err) {
    if (!(await isEmbedHealthy(spec.healthUrl))) {
      throw new Error(err instanceof Error ? err.message : "Failed to start the memory embedder");
    }
  }

  await waitForEmbedReady(spec);
}

async function stopEmbed(): Promise<void> {
  try {
    // `stop`, never `disable`: there is nothing to disable, and this is the
    // idle-standby path.
    await systemctlUnit(EMBED_STOP_ARGV);
    return;
  } catch {
    // Same shape as stopOllama's fallback: select on the executable AND the
    // one flag only the embedder carries, so the Gemma instance of the same
    // binary — and any process merely mentioning it — is never a match.
    await terminateByArgv(
      (argv) => isLlamaServerExecutable(argv[0]) && isEmbeddingServerArgv(argv),
      isLlamaServerExecutable,
    );
  }
}

async function stopOllama(): Promise<void> {
  try {
    // `stop`, never `disable`: this is also the idle-standby path, and a
    // standby that quietly un-enabled the unit would mean the model never came
    // back after a reboot.
    await systemctlUnit(OLLAMA_STOP_ARGV);
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

/**
 * One row per runtime: how to bring it up, take it down, tell whether it is
 * up, and where it is reached. Every lifecycle function below reads this table
 * rather than branching on the provider name, so a fourth runtime is a row
 * here and nothing else.
 */
interface ProviderOps {
  start(): Promise<void>;
  stop(): Promise<void>;
  isUp(): Promise<boolean>;
  proxyBaseUrl(): string;
  upstreamBaseUrl(): string;
}

const PROVIDERS: Record<LocalAiProvider, ProviderOps> = {
  llamacpp: {
    start: startLlamaCppAndWait,
    stop: stopLlamaCppServer,
    isUp: isLlamaCppUp,
    proxyBaseUrl: getLlamaCppProxyBaseUrl,
    upstreamBaseUrl: getLlamaCppBaseUrl,
  },
  ollama: {
    start: startOllamaIfNeeded,
    stop: stopOllama,
    isUp: isOllamaReachable,
    proxyBaseUrl: () => `${getLocalAiProxyRootUrl()}/setup-api/local-ai/ollama`,
    upstreamBaseUrl: getOllamaBaseUrl,
  },
  embed: {
    start: startEmbedIfNeeded,
    stop: stopEmbed,
    isUp: () => isEmbedHealthy(),
    proxyBaseUrl: getEmbedProxyBaseUrl,
    upstreamBaseUrl: getEmbedBaseUrl,
  },
};

/**
 * Make a local provider actually runnable, for the enable path.
 *
 * Registering a model with Hermes while its runtime is down produces a device
 * that reports "configured" and 502s on the first message, so the enable path
 * waits for readiness before it writes any provider config.
 *
 * llama.cpp and the embedder are only woken when their weights are already on
 * disk. Otherwise the launcher would DOWNLOAD a GGUF inside this request — a
 * 20-minute budget the caller is an HTTP handler for. In that case the proxy
 * provisions it on first use, exactly as it does today.
 */
export async function activateLocalAiProvider(provider: LocalAiProvider): Promise<void> {
  if (provider === "ollama") {
    await startOllamaService({ persist: true });
    return;
  }
  if (provider === "embed") {
    const provisioning = await getEmbedProvisioningStatus().catch(() => null);
    if (!provisioning?.modelAvailable) return;
    await ensureLocalAiReady("embed");
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

  const startPromise = PROVIDERS[provider].start();
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

export async function stopLocalAiProvider(provider: LocalAiProvider): Promise<void> {
  const state = runtimeStates[provider];
  clearIdleTimer(provider);
  state.activeRequests = 0;
  await PROVIDERS[provider].stop();
}

export function getLocalAiRuntimeSnapshot(provider: LocalAiProvider) {
  const state = runtimeStates[provider];
  return {
    activeRequests: state.activeRequests,
    idleTimeoutMs: getLocalAiIdleTimeoutMs(),
    lastUsedAt: state.lastUsedAt,
    proxyBaseUrl: PROVIDERS[provider].proxyBaseUrl(),
    upstreamBaseUrl: PROVIDERS[provider].upstreamBaseUrl(),
  };
}
