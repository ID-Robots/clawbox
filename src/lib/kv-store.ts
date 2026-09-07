import path from "path";
import fs from "fs";
import { assertStorableKey, DATA_DIR } from "./config-store";

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
    const parsed = JSON.parse(fs.readFileSync(KV_PATH, "utf-8"));
    // The same inbound rule as config-store, for the same reason: `JSON.parse`
    // creates `"__proto__"` as an OWN property, `writeKV` would re-emit it on
    // every later write, and a key in this file that another reader merges into
    // a plain object with `Object.assign` changes that object's prototype.
    // `kvDelete` could always remove one; nothing had to keep carrying it.
    if (parsed && typeof parsed === "object") Reflect.deleteProperty(parsed, "__proto__");
    return parsed;
  } catch {
    return {};
  }
}

function writeKV(data: Record<string, string>): void {
  ensureDir();
  const tmp = KV_PATH + ".tmp";
  // 0o600: kv is an untyped string store (callers may stash anything), so it
  // should not default to world-readable. Written on the tmp file before the
  // atomic rename so the final file is never briefly 0644. chmod the tmp too:
  // writeFileSync's `mode` is ignored if a stale tmp survived a crash at 0644,
  // and rename would otherwise carry those perms onto the live file.
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmp, KV_PATH);
}

export function kvGet(key: string): string | null {
  const data = readKV();
  // Own keys only. `data["__proto__"]` reaches Object.prototype's getter and
  // would hand back the prototype OBJECT under a signature that says
  // `string | null` — a caller doing `String(kvGet(k))` gets
  // "[object Object]". The same reasoning as the write guard below.
  return Object.hasOwn(data, key) ? data[key] ?? null : null;
}

export function kvSet(key: string, value: string): void {
  // The same store-wide rule as config-store, from the same helper rather than
  // a second copy of it: `data["__proto__"] = value` reaches Object.prototype's
  // setter, stores nothing and reports success. `/setup-api/kv` refuses that
  // name (and `constructor`/`prototype`, which DO land as ordinary own
  // properties) before it gets here, but the route is not the only door — the
  // notice ring, the mascot phrases and the uninstall sweep all call in
  // directly.
  assertStorableKey(key);
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
  // The whole batch first, so a refusal never leaves half of it applied.
  for (const key of Object.keys(entries)) assertStorableKey(key);
  const data = readKV();
  for (const [key, value] of Object.entries(entries)) {
    data[key] = value;
  }
  writeKV(data);
}

export function kvClear(): void {
  writeKV({});
}
