import path from "path";
import fs from "fs";
import { DATA_DIR } from "./config-store";

// JSON-file-backed key-value store for persistent client state.
// Replaces browser localStorage so state survives browser changes
// and gets wiped on factory reset (kv.json lives in data/).

const KV_PATH = path.join(DATA_DIR, "kv.json");

let dirReady = false;
function ensureDir(): void {
  if (dirReady) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dirReady = true;
}

function readKV(): Record<string, string> {
  ensureDir();
  try {
    if (!fs.existsSync(KV_PATH)) return {};
    return JSON.parse(fs.readFileSync(KV_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeKV(data: Record<string, string>): void {
  ensureDir();
  const tmp = KV_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, KV_PATH);
}

export function kvGet(key: string): string | null {
  return readKV()[key] ?? null;
}

export function kvSet(key: string, value: string): void {
  const data = readKV();
  data[key] = value;
  writeKV(data);
}

export function kvDelete(key: string): void {
  const data = readKV();
  delete data[key];
  writeKV(data);
}

export function kvGetAll(prefix?: string): Record<string, string> {
  const data = readKV();
  if (!prefix) return data;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(prefix)) result[k] = v;
  }
  return result;
}

export function kvSetMany(entries: Record<string, string>): void {
  const data = readKV();
  for (const [key, value] of Object.entries(entries)) {
    data[key] = value;
  }
  writeKV(data);
}

export function kvClear(): void {
  writeKV({});
}
