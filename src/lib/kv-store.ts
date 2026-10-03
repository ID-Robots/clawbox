import path, { untraced } from "./runtime-path";
import fs from "fs";
import { assertStorableKey, DATA_DIR } from "./config-store";
import { processStore } from "./process-store";

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

// ── The parsed store, kept while the file is the one it was read from ──
//
// The desktop polls ONE key of this file every two seconds, all day: the
// owner-notice ring (`ui:pending-actions`, src/lib/pending-actions.ts). Every
// read used to be an existsSync, a readFileSync and a JSON.parse of the WHOLE
// file to answer that one short string — and the file also holds every web
// app's `clawboxKv` data and the legacy-storage copies, values up to 256 KB
// each, so the cost of the poll grew with the owner's apps. An unchanged file
// is now an open, an fstat and a close.
//
// Keyed on what the file IS, through ONE descriptor — middleware's
// `readConfigCached`, for its reason: a stat of the NAME followed by a read of
// the NAME can pair one file's identity with the next file's bytes when a
// rename lands in between, and that pair would then be served until the next
// write. dev:ino:size:mtime:ctime, in nanoseconds. Every write below is a
// rename onto a fresh inode, so a new store is a new key even within the same
// clock tick.
//
// A snapshot is only KEPT once the file has stood still for
// `RACY_WINDOW_MS`. File times come from the kernel's coarse clock — a tick of
// 1-10 ms on the device's kernel, whole seconds on some filesystems — so a
// file rewritten IN PLACE within the tick it was read in can keep every field
// of its key (git calls such index entries "racily clean"). Nothing here
// writes in place, but kv.json is a plain file that a hand edit or a test
// does, and an inode freed by one rename can be handed to the next. A file
// read that soon after its last change is simply parsed again next time: one
// or two extra parses per write, against a poll that otherwise never parses.
//
// ONE snapshot per process, in process-store.ts, keyed by the file it caches.
// This module is compiled into the boot hook's layer as well as the routes'
// (see that file), and a module-level snapshot was one per COPY: correct —
// each copy checked its own against the file on every read — but two parsed
// copies of a file with no total size cap, the boot hook's sitting unused until
// its next read, on a box whose model servers need that memory more. Shared,
// either copy's read serves the other, and either copy's write drops it for
// both; every check below is the same as it was.
const RACY_WINDOW_MS = 2000;

interface StoreSnapshot {
  signature: string;
  /** SHARED: handed to readers as is, so nothing may ever mutate it. */
  data: Record<string, string>;
}

/**
 * The kept snapshot. The key is the file's path, so a test that points
 * `CLAWBOX_ROOT` somewhere else keeps its own (process-store's rule).
 */
const cache = processStore<{ snapshot: StoreSnapshot | null }>(`kv-store:${KV_PATH}`, () => ({ snapshot: null }));

/** No kv.json — a store that has never been written, or a wiped one. */
const ABSENT = Symbol("kv-absent");

function isStoreObject(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What kv.json holds, parsed, or `ABSENT` when there is no file. Throws when
 * the file is there and cannot be read or parsed — the lenient and the strict
 * readers below decide what that means.
 *
 * The answer may be the SHARED snapshot: callers that mutate take a copy.
 */
function loadStore(): unknown {
  ensureDir();
  let fd: number;
  try {
    fd = fs.openSync(KV_PATH, "r");
  } catch (err) {
    cache.snapshot = null;
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return ABSENT;
    // What `existsSync` called "not there" stays "not there" — an unreadable
    // path component reads as an empty store, the way it always did. A file
    // that IS there and cannot be opened is a failure.
    if (!fs.existsSync(KV_PATH)) return ABSENT;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const signature = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    if (cache.snapshot !== null && cache.snapshot.signature === signature) return cache.snapshot.data;
    cache.snapshot = null;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf-8"));
    // The same inbound rule as config-store, for the same reason: `JSON.parse`
    // creates `"__proto__"` as an OWN property, `writeKV` would re-emit it on
    // every later write, and a key in this file that another reader merges into
    // a plain object with `Object.assign` changes that object's prototype.
    // `kvDelete` could always remove one; nothing had to keep carrying it.
    if (parsed && typeof parsed === "object") Reflect.deleteProperty(parsed, "__proto__");
    // ctime as well as mtime: a rename or a chmod moves only ctime, and any
    // change at all after the newer of the two gives the file a new key.
    const changedAtMs = Number(st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs) / 1e6;
    if (isStoreObject(parsed) && Date.now() - changedAtMs > RACY_WINDOW_MS) {
      cache.snapshot = { signature, data: parsed };
    }
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The store for a READER that changes nothing: the shared snapshot itself, no
 * copy. Lenient — `{}` for a store that cannot be read, as it always was.
 */
function readKVShared(): Record<string, string> {
  try {
    const store = loadStore();
    return store === ABSENT ? {} : (store as Record<string, string>);
  } catch {
    return {};
  }
}

/** The store for a WRITER: its own copy, which it may change and write back. */
function readKV(): Record<string, string> {
  const data = readKVShared();
  // Only an object is ever shared; whatever else a damaged file parses to is
  // handed back as it always was.
  return isStoreObject(data) ? { ...data } : data;
}

function writeKV(data: Record<string, string>): void {
  ensureDir();
  const tmp = untraced(KV_PATH + ".tmp");
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
  // The next read looks at the new file. Dropped rather than replaced with
  // `data`, which is the caller's object and is not ours to share.
  cache.snapshot = null;
}

export function kvGet(key: string): string | null {
  const data = readKVShared();
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
  // The whole store goes out as a copy: the caller owns what it is given.
  if (!prefix) return readKV();
  const data = readKVShared();
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

/**
 * The whole store, WITHOUT the swallow `readKV` applies.
 *
 * `readKV` answers `{}` to an EIO or a half-written file as readily as to a
 * missing one, and every writer above then writes that `{}` plus its own key
 * back — which is fine for a mascot position and wrong for a caller moving the
 * owner's data: "the file could not be read" is not "the store is empty". Only
 * an ABSENT file reads as empty here; anything else throws.
 */
export function kvReadStrict(): Record<string, string> {
  const store = loadStore();
  if (store === ABSENT) return {};
  if (!isStoreObject(store)) {
    throw new Error("data/kv.json does not hold a JSON object");
  }
  // A copy: `kvUpdateStrict` edits it in place, and the snapshot is shared.
  return { ...store };
}

/**
 * A read-modify-write on the strict read: `mutate` edits the store in place
 * and the result is written back atomically, or — when the file could not be
 * read — nothing is written and the error reaches the caller. Synchronous from
 * read to rename, so no other write in this process lands in between.
 */
export function kvUpdateStrict<T>(mutate: (data: Record<string, string>) => T): T {
  const data = kvReadStrict();
  const result = mutate(data);
  writeKV(data);
  return result;
}
