/**
 * The host half of the webapp KV bridge (the guest half and the sandbox
 * attribute live in src/lib/webapp-sandbox.ts).
 *
 * A framed webapp has an opaque origin, so it cannot reach /setup-api/kv
 * itself. It posts `{ clawboxKv: { id, op, key, value } }` to window.parent
 * instead; the page that framed it — the desktop in src/app/page.tsx or the
 * standalone /app/[id] page — matches the message to the iframe it came from
 * BY WINDOW IDENTITY, never by anything the message claims, forces the app's
 * own key namespace, does the KV call with the owner's session and posts
 * `{ clawboxKvResult: { id, ok, value, error } }` back to that one frame. A
 * framed app can therefore reach exactly its own keys and nothing else.
 *
 * Nothing here touches `window` or `document` at module load, so a server
 * import of the constants is harmless.
 */

/**
 * The attribute a host page puts on a webapp iframe, holding the app id. The
 * bridge answers only to windows that belong to such a frame, and the id it
 * finds there is the namespace it serves.
 */
export const WEBAPP_FRAME_ID_ATTR = "data-webapp-id";

export type WebappKvOp = "get" | "set" | "delete" | "list";

export interface WebappKvRequest {
  id: string;
  op: WebappKvOp;
  key?: unknown;
  value?: unknown;
}

export interface WebappKvResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * The key the host actually reads or writes for an app's request, or null
 * when the request names a key outside the app's namespace.
 *
 * Every key lives under `<appId>:`. A bare key gets the prefix; a key that
 * already carries it is taken as is, so an app written to the storage guide's
 * "namespace every key with your app id" rule keeps working; a key carrying
 * any OTHER prefix is refused, because that is the one thing the bridge is
 * for — one app cannot read or overwrite another app's data through it.
 */
export function webappKvKey(appId: string, key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return null;
  const prefix = `${appId}:`;
  if (key.startsWith(prefix)) return key;
  if (key.includes(":")) return null;
  return prefix + key;
}

async function errorOf(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data?.error === "string") return data.error;
  } catch {}
  return `kv request failed (${res.status})`;
}

/**
 * Serve one guest request with the host's own session. Values are strings in
 * the KV store; a non-string handed to `set` is stored as its JSON rather than
 * refused, since the app that sent it cannot see the console it would have
 * been refused in. Exported for its unit tests; `attachWebappKvBridge` is what
 * the pages call.
 */
export async function serveWebappKvRequest(appId: string, req: WebappKvRequest): Promise<WebappKvResult> {
  const { id, op } = req;
  try {
    if (op === "list") {
      const res = await fetch(`/setup-api/kv?prefix=${encodeURIComponent(`${appId}:`)}`);
      if (!res.ok) return { id, ok: false, error: await errorOf(res) };
      return { id, ok: true, value: await res.json() };
    }
    if (op !== "get" && op !== "set" && op !== "delete") return { id, ok: false, error: "unsupported" };
    if (typeof req.key !== "string" || req.key.length === 0) return { id, ok: false, error: "invalid key" };
    const key = webappKvKey(appId, req.key);
    if (key === null) return { id, ok: false, error: "key outside app namespace" };
    if (op === "get") {
      const res = await fetch(`/setup-api/kv?key=${encodeURIComponent(key)}`);
      if (!res.ok) return { id, ok: false, error: await errorOf(res) };
      const data = (await res.json()) as { value?: unknown };
      return { id, ok: true, value: data.value ?? null };
    }
    const body =
      op === "set"
        ? { key, value: typeof req.value === "string" ? req.value : JSON.stringify(req.value ?? null) }
        : { delete: key };
    const res = await fetch("/setup-api/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { id, ok: false, error: await errorOf(res) };
    return { id, ok: true };
  } catch {
    return { id, ok: false, error: "kv request failed" };
  }
}

/**
 * Answer `clawboxKv` messages from the webapp iframes on this page. Call once
 * per page; returns the detach function, so it slots straight into a
 * `useEffect`.
 *
 * A request is attributed to a frame by comparing `event.source` with each
 * `iframe[data-webapp-id]`'s `contentWindow` — the one identity a sandboxed
 * frame cannot forge. The reply goes back with target origin "*": a frame
 * without `allow-same-origin` has origin "null", which cannot be named as a
 * target; the source check is what scopes the answer, and the answer carries
 * only that app's own keys.
 */
export function attachWebappKvBridge(): () => void {
  const onMessage = (event: MessageEvent) => {
    const req = (event.data as { clawboxKv?: unknown } | null)?.clawboxKv;
    if (!req || typeof req !== "object" || !event.source) return;
    const { id, op } = req as Partial<WebappKvRequest>;
    if (typeof id !== "string" || typeof op !== "string") return;
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>(`iframe[${WEBAPP_FRAME_ID_ATTR}]`));
    const frame = frames.find((f) => f.contentWindow === event.source);
    const appId = frame?.getAttribute(WEBAPP_FRAME_ID_ATTR);
    if (!appId) return;
    const source = event.source as Window;
    void serveWebappKvRequest(appId, req as WebappKvRequest).then((result) => {
      source.postMessage({ clawboxKvResult: result }, "*");
    });
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
