import fs from "fs/promises";
import path from "path";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const CONFIG_PATH = path.join(CONFIG_ROOT, "data", "config.json");

interface Config {
  [key: string]: unknown;
}

let writeLock: Promise<void> = Promise.resolve();

async function readConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    console.error("[config-store] Corrupt config file, resetting:", parseErr);
    return {};
  }
}

async function writeConfig(config: Config): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmpPath, CONFIG_PATH);
}

export async function get(key: string): Promise<unknown> {
  const config = await readConfig();
  return config[key];
}

export async function set(key: string, value: unknown): Promise<void> {
  const prev = writeLock;
  let done: Promise<void>;
  done = (async () => {
    await prev;
    const config = await readConfig();
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
    await writeConfig(config);
  })();
  writeLock = done.catch(() => {});
  await done;
}

export async function getAll(): Promise<Config> {
  return readConfig();
}

export async function resetConfig(): Promise<void> {
  const prev = writeLock;
  let done: Promise<void>;
  done = (async () => {
    await prev;
    await writeConfig({});
  })();
  writeLock = done.catch(() => {});
  await done;
}
