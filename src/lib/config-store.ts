import fs from "fs/promises";
import path from "path";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const CONFIG_PATH = path.join(CONFIG_ROOT, "data", "config.json");

interface Config {
  [key: string]: unknown;
}

let writeLock: Promise<void> = Promise.resolve();

async function readConfig(): Promise<Config> {
  try {
    const data = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return {};
    }
    console.error("[config-store] Failed to read config:", err);
    return {};
  }
}

async function writeConfig(config: Config): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  await fs.rename(tmpPath, CONFIG_PATH);
}

export async function get(key: string): Promise<unknown> {
  const config = await readConfig();
  return config[key];
}

export async function set(key: string, value: unknown): Promise<void> {
  const prev = writeLock;
  writeLock = (async () => {
    await prev;
    const config = await readConfig();
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
    await writeConfig(config);
  })();
  await writeLock;
}

export async function getAll(): Promise<Config> {
  return readConfig();
}
