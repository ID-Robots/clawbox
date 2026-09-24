/**
 * The one-shot migration behind the webapp legacy-storage layer (see
 * webapp-legacy-storage-rules.ts): run from the boot-migration register, once
 * per box, AWAITED before the server answers its first request — so no app is
 * ever served with the layer before its data has been moved.
 *
 * What it does, for every webapp present on this box at that boot (the
 * CENSUS — an app created afterwards is born under the bridge and is given
 * nobody's old data):
 *
 *  1. reads the app's own code, refusing anything that is not plainly the
 *     app's: a folder or file that is a symlink, something that is not a
 *     regular file, a file too large to be one;
 *  2. notes which old storage APIs it used;
 *  3. for an app that used /setup-api/kv, COPIES each old KV key its code
 *     names (`isAttributedKey`) into the app's own namespace — only where that
 *     place is empty, never ClawBox's own keys or another installed app's
 *     namespace, the original left where it was;
 *  4. reads every copy back and, only when all of them match, writes the
 *     record (data/webapp-legacy-storage.json) that switches the layer on.
 *
 * IDEMPOTENT: an existing record means done; a run that failed part-way wrote
 * no record, is left unmarked by the register, and the next boot starts over
 * — every copy it already made is found in place and kept, never written
 * twice. NOTHING IS DELETED: the old keys stay in data/kv.json, so a box
 * rolled back to v3.9 still finds its apps' data where they left it.
 */
import fs from "fs";
import path from "path";
import { APP_ID_RE, WEBAPPS_DIR } from "./code-projects";
import { kvReadStrict, kvUpdateStrict } from "./kv-store";
import { isReservedAppId } from "./webapp-registry";
import {
  type LegacyAppRecord,
  type LegacyStorageRecord,
  readLegacyStorageRecordStrict,
  writeLegacyStorageRecord,
} from "./webapp-legacy-storage";
import {
  belongsToAnotherApp,
  detectLegacyStorageApis,
  extractStringTokens,
  isAttributedKey,
  isClawboxOwnedStorageKey,
  isValidLegacyKvKey,
  legacyKvStorageKey,
} from "./webapp-legacy-storage-rules";

/** A deployed app's own document is at most this (the create route's cap is 1 MB; a build inlines more). */
export const MAX_APP_FILE_BYTES = 8 * 1024 * 1024;
/** Everything read from one app. */
export const MAX_APP_CODE_BYTES = 16 * 1024 * 1024;
const CODE_FILE_RE = /\.(?:html?|m?js)$/i;

interface CensusApp {
  id: string;
  code: string | null;
  refused?: string;
}

/**
 * The code of one deployed app — its index.html, then the other top-level
 * scripts and pages beside it (`&file=` assets), each read only when it is a
 * regular file of its own. Never follows a link out of the folder.
 */
function readAppCode(dir: string): { code: string } | { refused: string } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return { refused: `unreadable folder (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  // A project's own server (registerServerApp) has a folder and a meta.json
  // but no document of ours: nothing to read, and nothing refused either.
  if (!names.includes("index.html")) return { code: "" };
  const ordered = ["index.html", ...names.filter((n) => n !== "index.html" && CODE_FILE_RE.test(n)).sort()];
  const parts: string[] = [];
  let total = 0;
  for (const name of ordered) {
    const read = readCodeFile(path.join(dir, name), MAX_APP_CODE_BYTES - total);
    if (read === "not-a-file") {
      if (name === "index.html") return { refused: "index.html is not a regular file" };
      continue;
    }
    if (read === "too-large") {
      if (name === "index.html") return { refused: "index.html is too large" };
      continue;
    }
    if (read === "over-budget") break;
    total += read.size;
    parts.push(read.text);
  }
  return { code: parts.join("\n") };
}

/**
 * One code file, read through the descriptor it was checked on: opened with
 * O_NOFOLLOW (a symlink fails to open at all), then `fstat` on that same open
 * file decides whether it is a regular file of a size worth reading. Checking
 * a path and then reading the path again would leave a gap in which the entry
 * could be swapped for something else.
 */
function readCodeFile(
  file: string,
  budget: number,
): { text: string; size: number } | "not-a-file" | "too-large" | "over-budget" {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // ELOOP is O_NOFOLLOW's answer to a symlink; anything else (a folder
    // opened for reading is fine on Linux and refused by fstat below) is the
    // caller's EACCES/ENOENT to file against the app.
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return "not-a-file";
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return "not-a-file";
    if (st.size > MAX_APP_FILE_BYTES) return "too-large";
    if (st.size > budget) return "over-budget";
    return { text: fs.readFileSync(fd, "utf-8"), size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every deployed app, in a stable order. An entry whose name is not an app id
 * is not an app of ours and is skipped; a folder that is a symlink, or that
 * resolves outside data/webapps, is REFUSED — kept in the census so the record
 * says why its data was not looked at.
 */
function censusApps(): CensusApp[] {
  let names: string[];
  try {
    names = fs.readdirSync(WEBAPPS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const root = fs.realpathSync(WEBAPPS_DIR);
  const apps: CensusApp[] = [];
  for (const name of names.sort()) {
    if (!APP_ID_RE.test(name) || isReservedAppId(name)) continue;
    const dir = path.join(WEBAPPS_DIR, name);
    // One app's unreadable file (a root-owned 0600 index.html, a folder that
    // vanished mid-scan) refuses THAT app. Thrown, it would leave the whole
    // migration unmarked at every boot and every other app without its data.
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        apps.push({ id: name, code: null, refused: "the app folder is a symlink" });
        continue;
      }
      if (!st.isDirectory()) continue;
      if (path.dirname(fs.realpathSync(dir)) !== root) {
        apps.push({ id: name, code: null, refused: "the app folder resolves outside data/webapps" });
        continue;
      }
      const read = readAppCode(dir);
      apps.push("code" in read ? { id: name, code: read.code } : { id: name, code: null, refused: read.refused });
    } catch (err) {
      apps.push({ id: name, code: null, refused: `its files could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})` });
    }
  }
  return apps;
}

export interface LegacyStorageMigrationResult {
  /** False when a record already existed: this box had migrated. */
  ran: boolean;
  apps: number;
  copied: number;
}

/**
 * Run the migration if this box has not. See the file header for what it
 * does. Throws — leaving no record — when the store cannot be read or a copy
 * does not read back; the boot-migration register then leaves it unmarked
 * and the next boot tries again.
 */
export function migrateLegacyWebappStorage(now: Date = new Date()): LegacyStorageMigrationResult {
  if (readLegacyStorageRecordStrict()) return { ran: false, apps: 0, copied: 0 };

  const census = censusApps();
  const appIds = new Set(census.map((app) => app.id));
  const snapshot = kvReadStrict();
  const apps: Record<string, LegacyAppRecord> = Object.create(null);
  const plan = new Map<string, string>();

  for (const app of census) {
    if (app.code === null) {
      apps[app.id] = { kv: false, localStorage: false, copied: [], kept: [], refused: app.refused };
      if (app.refused) console.warn(`[webapp-legacy-storage] ${app.id}: not migrated — ${app.refused}`);
      continue;
    }
    const apis = detectLegacyStorageApis(app.code);
    const entry: LegacyAppRecord = { kv: apis.kv, localStorage: apis.localStorage, copied: [], kept: [] };
    if (apis.kv || apis.localStorage) {
      const tokens = extractStringTokens(app.code);
      const tokenSet = new Set(tokens);
      if (apis.kv) {
        for (const [key, value] of Object.entries(snapshot)) {
          if (key.startsWith(`${app.id}:`)) continue; // already where it belongs
          if (isClawboxOwnedStorageKey(key) || belongsToAnotherApp(key, app.id, appIds)) continue;
          if (typeof value !== "string" || !isAttributedKey(key, tokenSet)) continue;
          const target = legacyKvStorageKey(app.id, key);
          if (!isValidLegacyKvKey(target)) continue;
          if (Object.hasOwn(snapshot, target) || plan.has(target)) entry.kept.push(key);
          else {
            plan.set(target, value);
            entry.copied.push(key);
          }
        }
      }
      if (apis.localStorage) entry.tokens = tokens;
    }
    apps[app.id] = entry;
  }

  if (plan.size > 0) {
    // Only-if-absent inside the write itself: anything that reached the store
    // between the snapshot and now is newer than the copy and is kept.
    const lateKept = kvUpdateStrict((data) => {
      const kept = new Set<string>();
      for (const [target, value] of plan) {
        if (Object.hasOwn(data, target)) kept.add(target);
        else data[target] = value;
      }
      return kept;
    });
    const after = kvReadStrict();
    for (const [id, entry] of Object.entries(apps)) {
      const stillCopied: string[] = [];
      for (const key of entry.copied) {
        const target = legacyKvStorageKey(id, key);
        if (lateKept.has(target)) {
          entry.kept.push(key);
          continue;
        }
        if (after[target] !== plan.get(target)) {
          throw new Error(`${id}: the copy of ${key} did not read back — nothing recorded, the next boot tries again`);
        }
        stillCopied.push(key);
      }
      entry.copied = stillCopied;
    }
  }

  const record: LegacyStorageRecord = { version: 1, migratedAt: now.toISOString(), apps };
  writeLegacyStorageRecord(record);
  let copied = 0;
  for (const entry of Object.values(apps)) copied += entry.copied.length;
  return { ran: true, apps: census.length, copied };
}
