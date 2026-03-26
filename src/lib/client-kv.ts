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

// Debounced writes — coalesces rapid updates (e.g. mascot position
// during animation) into a single server POST. Deletes and sets are
// ordered through the same queue to prevent races.
type PendingOp = { type: "set"; value: string } | { type: "delete" };
const pendingWrites = new Map<string, PendingOp>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const entries: Record<string, string> = {};
    const deletes: string[] = [];
    for (const [key, op] of pendingWrites) {
      if (op.type === "set") entries[key] = op.value;
      else deletes.push(key);
    }
    pendingWrites.clear();
    flushTimer = null;

    if (Object.keys(entries).length > 0) {
      fetch("/setup-api/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      }).catch(() => {});
    }
    for (const key of deletes) {
      fetch("/setup-api/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: key }),
      }).catch(() => {});
    }
  }, 500);
}
