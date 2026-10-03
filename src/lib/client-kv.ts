// Client-side KV cache backed by server JSON store (data/kv.json).
// Call init() once on page load before rendering components that
// depend on stored state. Reads are synchronous from the in-memory
// cache; writes update the cache immediately and flush to the server.

const cache = new Map<string, string>();
let initPromise: Promise<void> | null = null;

export function init(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const res = await fetch("/setup-api/kv");
        if (!res.ok) return;
        const data: Record<string, string> = await res.json();
        for (const [k, v] of Object.entries(data)) cache.set(k, v);
      } catch {
        // Proceed with empty cache if server is unreachable
      }
    })();
  }
  return initPromise;
}

export function get(key: string): string | null {
  return cache.get(key) ?? null;
}

export function set(key: string, value: string): void {
  cache.set(key, value);
  pendingWrites.set(key, { type: "set", value });
  scheduleFlush();
}

export function remove(key: string): void {
  cache.delete(key);
  pendingWrites.set(key, { type: "delete" });
  scheduleFlush();
}

export function getJSON<T = unknown>(key: string): T | null {
  const raw = get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setJSON(key: string, value: unknown): void {
  set(key, JSON.stringify(value));
}

// Writes are THROTTLED, not debounced: the first pending write arms one
// 500 ms timer and everything set or removed before it fires goes out in the
// same flush, so a key reaches the device at most half a second after it was
// set. That bound is kept on purpose — a trailing debounce would hold a write
// back for as long as writes kept coming — so a caller that sets a key on
// every animation frame (the mascot used to, for its position) coalesces on its
// side instead: here it would still be two POSTs a second, each a rewrite of
// the whole data/kv.json on the box. Deletes and sets are ordered through the
// same queue to prevent races.
type PendingOp = { type: "set"; value: string } | { type: "delete" };
const pendingWrites = new Map<string, PendingOp>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A `keepalive` request outlives the page, but the browser gives all of them
 * together 64 KiB — the same bound src/lib/desktop-state-client.ts keeps.
 * A larger body goes as an ordinary request, as every write did before.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

function post(body: string, keepalive: boolean): void {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
  if (keepalive && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES) {
    // The 64 KiB is shared with every other keepalive request still in flight
    // — the desktop's own state save goes out as one on the same `pagehide`
    // and the same turn to hidden — and a request past it is refused before it
    // leaves. A page that only turned hidden is still alive, and before the
    // flush its write went out as an ordinary request on the timer: send it
    // that way rather than lose it. (Any other refusal is retried the same
    // once; a set or a delete is the same request twice.)
    fetch("/setup-api/kv", { ...init, keepalive: true })
      .catch(() => fetch("/setup-api/kv", init))
      .catch(() => {});
    return;
  }
  fetch("/setup-api/kv", init).catch(() => {});
}

function sendPending(keepalive: boolean): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (pendingWrites.size === 0) return;
  const entries: Record<string, string> = {};
  const deletes: string[] = [];
  for (const [key, op] of pendingWrites) {
    if (op.type === "set") entries[key] = op.value;
    else deletes.push(key);
  }
  pendingWrites.clear();

  if (Object.keys(entries).length > 0) post(JSON.stringify({ entries }), keepalive);
  for (const key of deletes) post(JSON.stringify({ delete: key }), keepalive);
}

/**
 * Send what is waiting NOW, as requests that outlive the page — for a page
 * that is going away. The 500 ms timer never fires after a reload has begun,
 * so without this the last half-second of writes was lost. Called on
 * `pagehide` and on the page turning hidden (registered below), and by a
 * caller that has just written its own last value on the way out.
 */
export function flush(): void {
  sendPending(true);
}

let pageHideWatched = false;
/** Registered on the first write, so importing this module on the server — or
 *  on a page that never writes — adds nothing. */
function watchPageHide(): void {
  if (pageHideWatched || typeof window === "undefined") return;
  pageHideWatched = true;
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

function scheduleFlush(): void {
  watchPageHide();
  if (flushTimer) return;
  flushTimer = setTimeout(() => sendPending(false), 500);
}
