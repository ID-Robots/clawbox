import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

interface OpenClawConfig {
  [key: string]: unknown;
  channels?: {
    [name: string]: {
      enabled?: boolean;
      botToken?: string;
      dmPolicy?: string;
      [key: string]: unknown;
    };
  };
}

async function readConfig(): Promise<OpenClawConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmpPath, CONFIG_PATH);
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
    await exec("systemctl", ["restart", "clawbox-gateway.service"], {
      timeout: 15000,
    });
  } catch (err) {
    console.error(
      "[openclaw-config] Failed to restart gateway:",
      err instanceof Error ? err.message : err
    );
  }
}
