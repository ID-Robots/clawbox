// localStorage-backed chat transcript cache. Used by both ChatApp and
// ChatPopup so refresh paints the prior conversation in <100 ms — before
// any WS handshake — even when the gateway is busy.
//
// We use raw `localStorage` (not `client-kv`) because client-kv reads are
// only synchronous AFTER an async init; chat needs the value during the
// useState initializer on first render, before any effect can run.

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  images?: string[]; // data URLs for inline display only — stripped from cache
}

export const HISTORY_CACHE_LIMIT = 50;

export function loadCachedHistory(key: string): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m: unknown) => {
        if (!m || typeof m !== "object") return false;
        const r = (m as { role?: unknown }).role;
        return (
          (r === "user" || r === "assistant") &&
          typeof (m as { text?: unknown }).text === "string" &&
          typeof (m as { timestamp?: unknown }).timestamp === "number"
        );
      })
      .slice(-HISTORY_CACHE_LIMIT) as ChatMessage[];
  } catch {
    return [];
  }
}

export function saveCachedHistory(key: string, msgs: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-HISTORY_CACHE_LIMIT)
      .map((m) => ({ role: m.role, text: m.text, timestamp: m.timestamp }));
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    // quota exceeded / private mode — silent
  }
}

// When chat.history arrives, the server is canonical for messages it has;
// any optimistic local message hasn't reached the server yet. Append local-
// only entries rather than replacing, so a reload right after a queued send
// doesn't erase the user's just-typed message — then re-sort by timestamp
// so a local entry with t=250 doesn't sit after a server entry with t=300.
export function mergeMessages(
  server: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] {
  const result: { msg: ChatMessage; orig: number }[] = server.map((msg, i) => ({ msg, orig: i }));
  for (let i = 0; i < local.length; i++) {
    const lm = local[i];
    if (lm.role === "system") continue;
    const dup = server.some(
      (sm) =>
        sm.role === lm.role &&
        sm.text === lm.text &&
        Math.abs(sm.timestamp - lm.timestamp) < 60000,
    );
    if (!dup) result.push({ msg: lm, orig: server.length + i });
  }
  // Stable sort: timestamp ascending, ties broken by original arrival order
  // (server entries come before local-only entries with the same timestamp).
  result.sort((a, b) => a.msg.timestamp - b.msg.timestamp || a.orig - b.orig);
  return result.map((r) => r.msg);
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
