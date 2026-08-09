import path from "path";
import fs from "fs";

export const CONFIG_ROOT = process.env.CLAWBOX_ROOT || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
export const DATA_DIR = path.join(CONFIG_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// Simple JSON file-based key-value store — works with both Node.js and Bun

function readConfig(): Record<string, unknown> {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(data: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0o600: config.json holds real secrets (clawai portal token, telegram bot
  // token). writeFileSync only applies mode when *creating* the file, so an
  // existing file left 0644 by an older build keeps its perms — re-harden
  // explicitly, matching the auth-profiles/session-secret/mcp-token stores.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best-effort; a failed chmod must not break config writes
  }
}

export async function get(key: string): Promise<unknown> {
  const config = readConfig();
  return config[key];
}

export async function set(key: string, value: unknown): Promise<void> {
  const config = readConfig();
  if (value === undefined) {
    delete config[key];
  } else {
    config[key] = value;
  }
  writeConfig(config);
}

export async function setMany(entries: Record<string, unknown>): Promise<void> {
  const config = readConfig();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  }
  writeConfig(config);
}

export async function getAll(): Promise<Record<string, unknown>> {
  return readConfig();
}
