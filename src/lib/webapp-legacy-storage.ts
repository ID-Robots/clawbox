/**
 * The server half of the webapp legacy-storage layer: the record the one-shot
 * migration leaves behind (webapp-legacy-storage-migration.ts), and what the
 * routes answer from it. See webapp-legacy-storage-rules.ts for why the layer
 * exists and whose data is whose.
 *
 * Every operation here is confined to ONE app's own namespace, named by the
 * caller — the desktop, which identifies the frame by window identity (see
 * webapp-kv-bridge.ts), never by anything the app says. The one path that
 * reads outside a namespace is the migration, which runs once, at boot, before
 * any app is served.
 */
import fs from "fs";
import path, { untraced } from "./runtime-path";
import { DATA_DIR } from "./config-store";
import { kvReadStrict, kvUpdateStrict } from "./kv-store";
import {
  LEGACY_KV_MAX_ENTRIES,
  LEGACY_KV_MAX_VALUE_BYTES,
  belongsToAnotherApp,
  detectLegacyStorageApis,
  isAttributedKey,
  isClawboxOwnedStorageKey,
  isLocalStorageKvKey,
  isValidLegacyKvKey,
  legacyKvListing,
  legacyKvStorageKey,
  localStorageKeyFromKv,
  localStorageKvKey,
  utf8Bytes,
} from "./webapp-legacy-storage-rules";
import { injectLegacyStorageShim, legacyStorageShimScript } from "./webapp-legacy-storage-shim";

/** Where the migration records what it found and did, per app. */
export const LEGACY_STORAGE_RECORD_PATH = path.join(DATA_DIR, "webapp-legacy-storage.json");

export interface LegacyAppRecord {
  /** The app's code talked to /setup-api/kv. */
  kv: boolean;
  /** The app's code used localStorage / sessionStorage. */
  localStorage: boolean;
  /** Old KV keys copied into the app's namespace (the originals are left in place). */
  copied: string[];
  /** Old KV keys whose place in the namespace was already taken — left alone on both sides. */
  kept: string[];
  /** The app's string literals as the migration read them, for the browser import. */
  tokens?: string[];
  /** Browser localStorage keys already brought over, from whichever browser did it first. */
  imported?: string[];
  /** Why the app's files were not read at all (a symlink, not a regular file, too large). */
  refused?: string;
}

export interface LegacyStorageRecord {
  version: 1;
  migratedAt: string;
  apps: Record<string, LegacyAppRecord>;
}

function isRecord(value: unknown): value is LegacyStorageRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<LegacyStorageRecord>;
  return rec.version === 1 && typeof rec.migratedAt === "string" && !!rec.apps && typeof rec.apps === "object" && !Array.isArray(rec.apps);
}

/**
 * The record, or null when the migration has not completed on this box.
 * Strict: a file that exists and cannot be read THROWS, so a writer never
 * rebuilds the record over one it could not see.
 */
export function readLegacyStorageRecordStrict(): LegacyStorageRecord | null {
  if (!fs.existsSync(LEGACY_STORAGE_RECORD_PATH)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(LEGACY_STORAGE_RECORD_PATH, "utf-8"));
  if (!isRecord(parsed)) throw new Error("data/webapp-legacy-storage.json is not a migration record");
  // Own-key lookups only: ids are object keys here, and `apps["__proto__"]`
  // must never answer Object.prototype.
  const apps: Record<string, LegacyAppRecord> = Object.create(null);
  for (const [id, entry] of Object.entries(parsed.apps)) {
    if (entry && typeof entry === "object") apps[id] = entry;
  }
  return { ...parsed, apps };
}

/**
 * The record for READERS: null both when the migration has not run and when
 * the record cannot be read. Either way the answer is the same — no
 * compatibility layer — which is the safe direction: an app served without it
 * behaves exactly as it did on v4.0 and writes nothing, while one served with
 * it before its data was moved could save its empty first screen over the
 * place that data is about to be copied to.
 */
export function readLegacyStorageRecord(): LegacyStorageRecord | null {
  try {
    return readLegacyStorageRecordStrict();
  } catch (err) {
    console.error("[webapp-legacy-storage] Could not read the migration record:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Atomic, 0600 — the tokens are the app's own code, but nothing else needs to read them. */
export function writeLegacyStorageRecord(record: LegacyStorageRecord): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = untraced(`${LEGACY_STORAGE_RECORD_PATH}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, LEGACY_STORAGE_RECORD_PATH);
}

// ── Serving the document ────────────────────────────────────────────────────

/** Past this, the app's saved localStorage is not inlined into its page. */
export const MAX_LOCAL_STORAGE_SEED_BYTES = 16 * 1024 * 1024;

/** The app's saved localStorage, as the page's first script hands it back. Throws when the store cannot be read. */
export function legacyLocalStorageSeed(appId: string): Record<string, string> {
  const data = kvReadStrict();
  const seed: Record<string, string> = {};
  for (const [storedKey, value] of Object.entries(data)) {
    if (!isLocalStorageKvKey(appId, storedKey)) continue;
    const key = localStorageKeyFromKv(appId, storedKey);
    if (key !== null) seed[key] = value;
  }
  return seed;
}

/**
 * The document to serve for a legacy app, or null to serve the file as it is.
 *
 * Null until the migration has completed on this box (see
 * `readLegacyStorageRecord` for why), and for any document that does not use
 * the old storage APIs. Otherwise the compatibility script goes in before
 * anything of the app's runs: its `fetch('/setup-api/kv')` calls are answered
 * through the desktop's bridge, and its `localStorage` — which throws in an
 * opaque origin — is a working one seeded with what it saved.
 *
 * A PUBLIC app (`isPublic`, which the webapps route answers without a
 * session) gets no saved data in its page and a memory-only storage, so a
 * public view can neither read the data nor save an empty first screen over
 * it. A seed that cannot be read, or that is too large to inline, leaves
 * localStorage out of the layer for the same reason: an app that finds no
 * storage at all fails the way it did on v4.0; an app that finds an EMPTY one
 * saves over the real thing.
 */
export async function legacyWebappDocument(
  appId: string,
  html: string,
  opts: { isPublic: () => Promise<boolean> },
): Promise<string | null> {
  const record = readLegacyStorageRecord();
  if (!record) return null;
  const apis = detectLegacyStorageApis(html);
  if (!apis.kv && !apis.localStorage) return null;

  let storage: { seed: Record<string, string>; persist: boolean } | null = null;
  if (apis.localStorage) {
    if (await opts.isPublic()) {
      storage = { seed: {}, persist: false };
    } else {
      try {
        const seed = legacyLocalStorageSeed(appId);
        const size = Object.entries(seed).reduce((sum, [k, v]) => sum + k.length + v.length, 0);
        if (size <= MAX_LOCAL_STORAGE_SEED_BYTES) storage = { seed, persist: true };
        else console.error(`[webapp-legacy-storage] ${appId}: saved localStorage is too large to inline; left out of the layer`);
      } catch (err) {
        console.error(`[webapp-legacy-storage] ${appId}: could not read its saved localStorage:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (!apis.kv && !storage) return null;
  return injectLegacyStorageShim(html, legacyStorageShimScript({ kv: apis.kv, storage }));
}

// ── The old KV route, answered inside one namespace ─────────────────────────

export interface LegacyKvRequest {
  method: string;
  /** The request URL's query string, `?` included or not. */
  search: string;
  /** The request body as text. */
  body?: string;
}

export interface LegacyKvAnswer {
  status: number;
  body: unknown;
}

const ok = (): LegacyKvAnswer => ({ status: 200, body: { ok: true } });
const refuse = (status: number, error: string): LegacyKvAnswer => ({ status, body: { error } });

/**
 * What v3.9's `/setup-api/kv` answered — the same statuses and the same JSON
 * shapes, validated by the same key rule — with every key the app names read
 * and written under its own namespace (`legacyKvStorageKey`). A store that
 * cannot be read throws; the route answers 500 and nothing is written.
 */
export function legacyKvRequest(appId: string, req: LegacyKvRequest): LegacyKvAnswer {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    const params = new URLSearchParams(req.search);
    const key = params.get("key");
    if (key) {
      if (!isValidLegacyKvKey(key)) return refuse(400, "Invalid key");
      const stored = legacyKvStorageKey(appId, key);
      const data = kvReadStrict();
      return { status: 200, body: { key, value: Object.hasOwn(data, stored) ? data[stored] : null } };
    }
    const prefix = params.get("prefix") ?? undefined;
    if (prefix !== undefined && !isValidLegacyKvKey(prefix)) return refuse(400, "Invalid prefix");
    return { status: 200, body: legacyKvListing(appId, kvReadStrict(), prefix ?? "") };
  }
  if (method !== "POST") return { status: 405, body: null };

  let body: unknown;
  try {
    body = JSON.parse(req.body ?? "");
  } catch {
    return refuse(400, "Invalid JSON");
  }
  // v3.9 read `body.delete` straight off the parse: `null` threw there (and
  // was answered as bad JSON), anything else without the fields fell through.
  if (body === null) return refuse(400, "Invalid JSON");
  const fields = (typeof body === "object" ? body : {}) as { delete?: unknown; entries?: unknown; key?: unknown; value?: unknown };

  if (typeof fields.delete === "string") {
    if (!isValidLegacyKvKey(fields.delete)) return refuse(400, "Invalid key");
    const stored = legacyKvStorageKey(appId, fields.delete);
    kvUpdateStrict((data) => {
      delete data[stored];
    });
    return ok();
  }
  if (fields.entries && typeof fields.entries === "object") {
    const rawKeys = Object.keys(fields.entries);
    if (rawKeys.length > LEGACY_KV_MAX_ENTRIES) return refuse(413, `Too many entries (max ${LEGACY_KV_MAX_ENTRIES})`);
    const writes: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields.entries as Record<string, unknown>)) {
      // As lenient as v3.9's batch: an entry it would have dropped is dropped.
      if (!isValidLegacyKvKey(key) || typeof value !== "string" || utf8Bytes(value) > LEGACY_KV_MAX_VALUE_BYTES) continue;
      const stored = legacyKvStorageKey(appId, key);
      if (isValidLegacyKvKey(stored)) writes[stored] = value;
    }
    if (Object.keys(writes).length > 0) {
      kvUpdateStrict((data) => {
        Object.assign(data, writes);
      });
    }
    return ok();
  }
  if (typeof fields.key === "string" && typeof fields.value === "string") {
    if (!isValidLegacyKvKey(fields.key)) return refuse(400, "Invalid key");
    if (utf8Bytes(fields.value) > LEGACY_KV_MAX_VALUE_BYTES) {
      return refuse(413, `Value too large (max ${LEGACY_KV_MAX_VALUE_BYTES} bytes)`);
    }
    const stored = legacyKvStorageKey(appId, fields.key);
    // The namespace makes the key longer; one that no longer fits the store
    // is refused the way the store would refuse it.
    if (!isValidLegacyKvKey(stored)) return refuse(400, "Invalid key");
    const value = fields.value;
    kvUpdateStrict((data) => {
      data[stored] = value;
    });
    return ok();
  }
  return refuse(400, "Invalid request");
}

// ── localStorage, persisted ─────────────────────────────────────────────────

export interface LegacyLocalStorageWrite {
  clear?: boolean;
  set?: Record<string, unknown>;
  remove?: unknown[];
}

/**
 * Apply one batch of a legacy app's localStorage changes, in the order the
 * page made them: `clear` first (it was called before anything else in the
 * batch was set), then removals, then sets. Answers the keys it could not keep
 * — a value the store cannot hold, a key too long to name.
 */
export function writeLegacyLocalStorage(appId: string, ops: LegacyLocalStorageWrite): { dropped: string[] } {
  const dropped: string[] = [];
  const removals: string[] = [];
  for (const key of Array.isArray(ops.remove) ? ops.remove : []) {
    if (typeof key !== "string") continue;
    const stored = localStorageKvKey(appId, key);
    if (stored) removals.push(stored);
  }
  const sets: Record<string, string> = {};
  for (const [key, value] of Object.entries(ops.set && typeof ops.set === "object" ? ops.set : {})) {
    const stored = localStorageKvKey(appId, key);
    if (!stored || typeof value !== "string" || utf8Bytes(value) > LEGACY_KV_MAX_VALUE_BYTES) {
      dropped.push(key);
      continue;
    }
    sets[stored] = value;
  }
  if (!ops.clear && removals.length === 0 && Object.keys(sets).length === 0) return { dropped };
  kvUpdateStrict((data) => {
    if (ops.clear) {
      for (const stored of Object.keys(data)) if (isLocalStorageKvKey(appId, stored)) delete data[stored];
    }
    for (const stored of removals) delete data[stored];
    Object.assign(data, sets);
  });
  return { dropped };
}

// ── Bringing a browser's old localStorage over ──────────────────────────────

/**
 * What the desktop needs to bring THIS browser's old localStorage for an app
 * over: the app's tokens and the keys some browser already brought. Null when
 * there is nothing to ask for — the migration has not run, the app came after
 * it, or its code never used localStorage.
 */
export function legacyBrowserImportPlan(appId: string): { tokens: string[]; imported: string[] } | null {
  const app = readLegacyStorageRecord()?.apps[appId];
  if (!app?.localStorage || !app.tokens?.length) return null;
  return { tokens: app.tokens, imported: app.imported ?? [] };
}

/**
 * Copy the entries a browser sent into the app's localStorage namespace.
 *
 * A key is taken only when the app's code named it (the tokens the migration
 * recorded, never the page's current code), it is not ClawBox's own or
 * another app's, and no browser brought it before. It is written only where
 * the namespace has nothing yet — the app may already have saved newer data
 * from another browser — read back before it is counted, and then recorded,
 * so a second browser holding an older copy cannot bring it back over the app's
 * later edits or deletions. The browser's own copy is never touched.
 */
export function importLegacyBrowserStorage(
  appId: string,
  entries: Record<string, unknown>,
): { copied: string[]; kept: string[]; refused: string[] } {
  const record = readLegacyStorageRecordStrict();
  const app = record?.apps[appId];
  if (!record || !app?.localStorage || !app.tokens?.length) {
    return { copied: [], kept: [], refused: Object.keys(entries) };
  }
  const tokens = new Set(app.tokens);
  const imported = new Set(app.imported ?? []);
  const appIds = new Set(Object.keys(record.apps));
  const refused: string[] = [];
  const wanted = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(entries)) {
    const stored = localStorageKvKey(appId, key);
    if (
      typeof value !== "string"
      || imported.has(key)
      || isClawboxOwnedStorageKey(key)
      || belongsToAnotherApp(key, appId, appIds)
      || !isAttributedKey(key, tokens)
      || !stored
      || utf8Bytes(value) > LEGACY_KV_MAX_VALUE_BYTES
    ) {
      refused.push(key);
      continue;
    }
    wanted.set(stored, { key, value });
  }
  const copied: string[] = [];
  const kept: string[] = [];
  if (wanted.size > 0) {
    kvUpdateStrict((data) => {
      for (const [stored, { key, value }] of wanted) {
        if (Object.hasOwn(data, stored)) kept.push(key);
        else {
          data[stored] = value;
          copied.push(key);
        }
      }
    });
    const after = kvReadStrict();
    for (const key of copied) {
      const stored = localStorageKvKey(appId, key)!;
      if (after[stored] !== wanted.get(stored)?.value) throw new Error(`${appId}: ${key} did not read back after the import`);
    }
    // Re-read the record right before writing it: the KV write above cannot
    // yield, but this function is the only writer after the migration, and a
    // fresh read keeps it that way if that ever changes.
    const latest = readLegacyStorageRecordStrict();
    const entry = latest?.apps[appId];
    if (latest && entry) {
      entry.imported = [...new Set([...(entry.imported ?? []), ...copied, ...kept])];
      writeLegacyStorageRecord(latest);
    }
  }
  return { copied, kept, refused };
}
