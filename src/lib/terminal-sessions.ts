/**
 * The browser's half of the Terminal's device sessions (TASK-1306).
 *
 * A desktop Terminal tab's shell is a session on the box
 * (scripts/terminal-sessions.mjs) that outlives the page: a refresh, a closed
 * browser tab or a dropped network leaves it running, and the window that comes
 * back reattaches to it by id. Closing the window or the tab BY HAND is the one
 * thing that ends it, and that is this module's `endTerminalSession`.
 */

/** A session id as the PTY server hands them out (`randomUUID()`), and as the desktop state stores them. */
export const TERMINAL_SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** How long an end request waits for the server before it gives up — the idle clock is the backstop. */
const END_TIMEOUT_MS = 10_000;

/**
 * The PTY socket, through the same origin that served the page — the production
 * server proxies `/terminal-ws` upgrades to 127.0.0.1:3006, which is what makes
 * it work on the LAN, through the Cloudflare tunnel, and under HTTPS.
 */
export function terminalWsUrl(loc: Pick<Location, "protocol" | "host"> | undefined = typeof window !== "undefined" ? window.location : undefined): string {
  if (!loc) return "ws://localhost/terminal-ws";
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/terminal-ws`;
}

export function isTerminalSessionId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_SESSION_ID_RE.test(value);
}

/**
 * End a session the owner closed by hand: kill its shell on the box and forget
 * it. Fire and forget — its own short socket, so it works whether or not the
 * terminal that showed the session is still mounted. A request that never
 * arrives (the page unloads with it) leaves the session to the idle clock.
 */
export function endTerminalSession(id: string | null | undefined): void {
  if (!isTerminalSessionId(id) || typeof WebSocket === "undefined") return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${terminalWsUrl()}?end=${encodeURIComponent(id)}`);
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try { ws.close(); } catch { /* already closed */ }
  };
  ws.onmessage = done;
  ws.onerror = done;
  timer = setTimeout(done, END_TIMEOUT_MS);
}
