import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
export const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
export const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 24000;

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
  agents?: {
    defaults?: {
      model?: { primary?: string };
      workspace?: string;
      compaction?: { reserveTokensFloor?: number };
    };
  };
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
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"], {
      timeout: 60000,
    });
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
  const home = process.env.HOME || "/home/clawbox";
  const candidates = [
    path.join(nodeDir, "openclaw"),
    path.join(home, ".npm-global", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  const nvmDir = path.join(home, ".nvm", "versions", "node");
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
  const home = process.env.HOME || "/home/clawbox";
  const openclawConfig = path.join(home, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fsSync.readFileSync(openclawConfig, "utf-8"));
    const workspace = config?.agents?.defaults?.workspace;
    if (typeof workspace === "string" && workspace) return workspace;
  } catch {}
  const openclawWorkspace = path.join(home, ".openclaw", "workspace");
  if (fsSync.existsSync(openclawWorkspace)) return openclawWorkspace;
  return path.join(home, "clawd");
}
