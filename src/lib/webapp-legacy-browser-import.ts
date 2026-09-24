/**
 * Bring THIS browser's old localStorage for a webapp over into the app's own
 * storage, before its frame loads (TASK-1150; the rules are in
 * webapp-legacy-storage-rules.ts).
 *
 * Until v4.0 a webapp ran on the ClawBox origin, so what it kept in
 * `localStorage` lives in this browser's storage for that origin — the same
 * storage this desktop page reads. The app's frame cannot reach it any more;
 * the desktop can, and hands the server the keys the app's own code named
 * (the tokens the boot migration recorded), never a key ClawBox or a UI it
 * serves on this origin owns. The browser's own copy is never touched.
 *
 * Once per app per browser: a mark under a ClawBox-owned key records that
 * this browser has been asked, so the question costs one storage scan and no
 * request from then on.
 */
import { isAttributedKey, isClawboxOwnedStorageKey } from "./webapp-legacy-storage-rules";

export const BROWSER_IMPORT_MARK_PREFIX = "clawbox-webapp-storage-imported:";
const DEFAULT_TIMEOUT_MS = 8_000;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this browser may still hold old storage for the app — synchronous,
 * because it decides whether the frame waits. False once the app's mark is
 * set, and on a browser whose storage holds nothing but ClawBox's own keys
 * (every browser that never ran a pre-v4.0 app), so those never wait at all.
 */
export function browserImportPending(appId: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(BROWSER_IMPORT_MARK_PREFIX + appId) !== null) return false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && !isClawboxOwnedStorageKey(key)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export type BrowserImportOutcome = "imported" | "nothing" | "unavailable";

/**
 * Ask the box what the app's code named, send the matching entries, and mark
 * the app done. "unavailable" (the box has not migrated, a request failed or
 * timed out) sets no mark, so the next open asks again; the caller loads the
 * frame either way.
 */
export async function importBrowserStorage(
  appId: string,
  opts: { timeoutMs?: number } = {},
): Promise<BrowserImportOutcome> {
  const storage = browserStorage();
  if (!storage) return "nothing";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const mark = () => {
    try {
      storage.setItem(BROWSER_IMPORT_MARK_PREFIX + appId, new Date().toISOString());
    } catch {
      // A full or locked storage: the next open asks again, which is harmless.
    }
  };
  try {
    const res = await fetch(`/setup-api/webapps/storage?app=${encodeURIComponent(appId)}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return "unavailable";
    const { migrated, plan } = (await res.json()) as {
      migrated?: unknown;
      plan?: { tokens?: unknown; imported?: unknown } | null;
    };
    if (migrated !== true) return "unavailable";
    const tokens = new Set(Array.isArray(plan?.tokens) ? plan.tokens.filter((t): t is string => typeof t === "string") : []);
    const done = new Set(Array.isArray(plan?.imported) ? plan.imported : []);
    const entries: Record<string, string> = {};
    if (tokens.size > 0) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null || done.has(key) || isClawboxOwnedStorageKey(key) || !isAttributedKey(key, tokens)) continue;
        const value = storage.getItem(key);
        if (value !== null) entries[key] = value;
      }
    }
    if (Object.keys(entries).length === 0) {
      mark();
      return "nothing";
    }
    const post = await fetch("/setup-api/webapps/storage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: appId, op: "importBrowser", entries }),
      signal: controller.signal,
    });
    if (!post.ok) return "unavailable";
    mark();
    return "imported";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
