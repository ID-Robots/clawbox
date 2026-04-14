import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import {
  CLAWBOX_HOME,
  CLAWBOX_NPM_PREFIX,
  DATA_DIR,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_HOME,
  getClawboxRuntimeEnv,
} from "@/lib/runtime-paths";

const exec = promisify(execFile);
export const CONFIG_PATH = OPENCLAW_CONFIG_PATH;
export const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 24000;
const GATEWAY_SERVICE = "clawbox-gateway.service";
const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const GATEWAY_LOG_PATH = path.join(DATA_DIR, "openclaw-gateway.log");

function getRuntimeHome(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome !== "/root") return envHome;
  return CLAWBOX_HOME;
}

export interface OpenClawConfig {
  [key: string]: unknown;
  channels?: {
    [name: string]: {
      enabled?: boolean;
      botToken?: string;
      dmPolicy?: string;
      [key: string]: unknown;
    };
  };
  tools?: {
    profile?: string;
    web?: { search?: { enabled?: boolean } };
  };
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string }>;
  };
  models?: {
    mode?: string;
    providers?: Record<string, {
      models?: Array<{ id?: string; name?: string }>;
      [key: string]: unknown;
    }>;
  };
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      workspace?: string;
      compaction?: { reserveTokensFloor?: number };
    };
  };
}

const DEFAULT_LOCAL_AI_PROXY_ROOT_URL = "http://127.0.0.1";

function getOllamaProxyBaseUrl(): string {
  const root = (process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL || DEFAULT_LOCAL_AI_PROXY_ROOT_URL).trim().replace(/\/+$/, "");
  return `${root}/setup-api/local-ai/ollama`;
}

function normalizeLocalProvider(provider: string | null | undefined): "llamacpp" | "ollama" | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  if (normalized.startsWith("ollama")) return "ollama";
  return null;
}

function toLocalModel(provider: "llamacpp" | "ollama", modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  return `${provider}/${trimmed}`;
}

export function inferConfiguredLocalModel(config: OpenClawConfig): { provider: "llamacpp" | "ollama"; model: string } | null {
  const modelDefaults = config.agents?.defaults?.model;
  const localCandidates = [
    ...(Array.isArray(modelDefaults?.fallbacks) ? modelDefaults.fallbacks : []),
    modelDefaults?.primary,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => {
      const [provider, ...rest] = value.split("/");
      const normalizedProvider = normalizeLocalProvider(provider);
      if (!normalizedProvider || rest.length === 0) return null;
      return { provider: normalizedProvider, model: value };
    })
    .filter((value): value is { provider: "llamacpp" | "ollama"; model: string } => value !== null);

  if (localCandidates.length > 0) {
    return localCandidates[0];
  }

  const providerDefs = config.models?.providers ?? {};
  for (const provider of ["llamacpp", "ollama"] as const) {
    const candidate = toLocalModel(provider, providerDefs[provider]?.models?.[0]?.id);
    if (candidate) {
      return { provider, model: candidate };
    }
  }

  return null;
}

export async function readConfig(): Promise<OpenClawConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmpPath, CONFIG_PATH);
}

export async function ensureLocalAiProxyUrls(): Promise<boolean> {
  const config = await readConfig();
  const providers = config.models?.providers;
  if (!providers) {
    return false;
  }

  let changed = false;

  const llamaProvider = providers.llamacpp;
  if (llamaProvider && llamaProvider.baseUrl !== getLlamaCppProxyBaseUrl()) {
    llamaProvider.baseUrl = getLlamaCppProxyBaseUrl();
    changed = true;
  }

  const ollamaProvider = providers.ollama;
  if (ollamaProvider && ollamaProvider.baseUrl !== getOllamaProxyBaseUrl()) {
    ollamaProvider.baseUrl = getOllamaProxyBaseUrl();
    changed = true;
  }

  if (changed) {
    await writeConfig(config);
  }

  return changed;
}

export async function ensureCompactionReserveFloor(
  reserveTokensFloor = DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR
): Promise<void> {
  const config = await readConfig();
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.compaction ??= {};
  if (
    typeof config.agents.defaults.compaction.reserveTokensFloor !== "number" ||
    config.agents.defaults.compaction.reserveTokensFloor < reserveTokensFloor
  ) {
    config.agents.defaults.compaction.reserveTokensFloor = reserveTokensFloor;
    await writeConfig(config);
  }
}

/**
 * Set the OpenClaw gateway control-UI allowed origins to include the given
 * mDNS hostname. Always preserves the standard local origins so the device
 * remains reachable via IP and the AP captive portal even after a rename.
 */
export async function setControlUiAllowedOrigins(hostname: string): Promise<void> {
  const config = await readConfig();
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(controlUi.allowedOrigins)
    ? (controlUi.allowedOrigins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const origins = new Set<string>([
    ...existing,
    `http://${hostname}.local`,
    "http://localhost",
    "http://127.0.0.1",
    "http://10.42.0.1",
    "http://10.43.0.1", // alt subnet when home network collides with 10.42.0.0/24
  ]);
  controlUi.allowedOrigins = Array.from(origins);
  gateway.controlUi = controlUi;
  config.gateway = gateway;
  await writeConfig(config);
}

export async function setTelegramToken(botToken: string): Promise<void> {
  const config = await readConfig();
  if (!config.channels) {
    config.channels = {};
  }
  config.channels.telegram = {
    ...config.channels.telegram,
    enabled: true,
    botToken,
    dmPolicy: "open",
    allowFrom: ["*"],
  };
  await writeConfig(config);
}

export async function restartGateway(): Promise<void> {
  try {
    if (shouldUseSystemdGateway()) {
      await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", GATEWAY_SERVICE], {
        timeout: 60000,
      });
      return;
    }

    await restartDetachedGateway();
  } catch (err) {
    console.error(
      "[openclaw-config] Failed to restart gateway:",
      err instanceof Error ? err.message : err
    );
    throw err;
  }
}

/** Send SIGUSR1 to the gateway process so it hot-reloads skills without a full restart. */
export async function reloadGateway(): Promise<void> {
  try {
    const { stdout } = await exec("pgrep", ["-f", "openclaw-gateway"], { timeout: 5_000 });
    const pidStr = stdout.trim().split("\n")[0];
    const pid = parseInt(pidStr, 10);
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, "SIGUSR1");
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.warn("[openclaw-config] reloadGateway failed:", err instanceof Error ? err.message : err);
    }
  }
}

/** Find the openclaw binary — checks common locations including nvm, caches result. */
let _openclawBinCache: string | null = null;
export function findOpenclawBin(): string {
  if (_openclawBinCache) return _openclawBinCache;
  const nodeDir = path.dirname(process.execPath);
  const runtimeHome = getRuntimeHome();
  const candidates = [
    path.join(nodeDir, "openclaw"),
    path.join(runtimeHome, ".npm-global", "bin", "openclaw"),
    path.join(CLAWBOX_NPM_PREFIX, "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  const nvmDir = path.join(runtimeHome, ".nvm", "versions", "node");
  try {
    const versions = fsSync.readdirSync(nvmDir) as string[];
    for (const v of versions.sort().reverse()) {
      candidates.push(path.join(nvmDir, v, "bin", "openclaw"));
    }
  } catch {}
  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      _openclawBinCache = p;
      return p;
    }
  }
  return "openclaw";
}

/** Resolve the OpenClaw workspace/skills directory from config or well-known paths. */
export function getSkillsDir(): string {
  const runtimeHome = getRuntimeHome();
  const runtimeOpenclawConfig = path.join(runtimeHome, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fsSync.readFileSync(runtimeOpenclawConfig, "utf-8"));
    const workspace = config?.agents?.defaults?.workspace;
    if (typeof workspace === "string" && workspace) return workspace;
  } catch {}
  const openclawWorkspace = path.join(runtimeHome, ".openclaw", "workspace");
  if (fsSync.existsSync(openclawWorkspace)) return openclawWorkspace;
  return path.join(runtimeHome, "clawd");
}

function shouldUseSystemdGateway(): boolean {
  if (process.env.CLAWBOX_USE_SYSTEMD === "0") return false;
  if (process.env.CLAWBOX_USE_SYSTEMD === "1") return true;
  return hasSystemdUnit(GATEWAY_SERVICE);
}

function hasSystemdUnit(unit: string): boolean {
  return [
    path.join("/etc/systemd/system", unit),
    path.join("/lib/systemd/system", unit),
  ].some((candidate) => fsSync.existsSync(candidate));
}

async function restartDetachedGateway(): Promise<void> {
  const openclawBin = findOpenclawBin();
  const gatewayPath = `${path.dirname(openclawBin)}:${process.env.PATH || ""}`;

  await exec("pkill", ["-f", "openclaw.*gateway"], { timeout: 5000 }).catch(() => {});

  fsSync.mkdirSync(path.dirname(GATEWAY_LOG_PATH), { recursive: true });
  const logFd = fsSync.openSync(GATEWAY_LOG_PATH, "a");
  const child = spawn(
    openclawBin,
    ["gateway", "--allow-unconfigured", "--bind", process.env.CLAWBOX_GATEWAY_BIND || "loopback"],
    {
      cwd: CLAWBOX_HOME,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: getClawboxRuntimeEnv({
        PATH: gatewayPath,
        NODE_ENV: process.env.NODE_ENV || "production",
        BUN_ENV: process.env.BUN_ENV || "production",
      }),
    },
  );
  child.unref();
  fsSync.closeSync(logFd);

  await waitForGatewayReady();
}

async function waitForGatewayReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  const url = `http://127.0.0.1:${GATEWAY_PORT}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status < 500) {
        return;
      }
    } catch {
      // Keep polling until the gateway comes up or times out.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Gateway did not become ready on port ${GATEWAY_PORT}`);
}
