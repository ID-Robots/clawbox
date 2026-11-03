/**
 * What production-server.js's :443 listener says about Local HTTPS, read in
 * the same process. scripts/local-https.js `publishListener()` puts it on
 * globalThis when the listener starts; under `next dev`, in a test, or on a
 * server that never reached its HTTPS step there is nothing there, which reads
 * as "not serving" — never as an error.
 */

const LISTENER_KEY = Symbol.for("clawbox.local-https.listener");

export interface LocalHttpsServing {
  hostname: string;
  notBefore: number;
  notAfter: number;
  fingerprint256: string;
}

interface PublishedListener {
  status: () => LocalHttpsServing | null;
  port: number;
  refresh: () => void;
}

function published(): PublishedListener | null {
  const value = (globalThis as unknown as { [LISTENER_KEY]?: unknown })[LISTENER_KEY];
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PublishedListener>;
  return typeof v.status === "function" && typeof v.refresh === "function" ? (v as PublishedListener) : null;
}

/** The Local HTTPS certificate :443 is serving right now, or null. */
export function localHttpsServing(): LocalHttpsServing | null {
  try {
    return published()?.status() ?? null;
  } catch {
    return null;
  }
}

/** The port the TLS listener binds (HTTPS_PORT, 443 by default). */
export function localHttpsPort(): number {
  const port = published()?.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : 443;
}

/** Ask the listener to re-read data/local-https/ now rather than at its next poll. */
export function refreshLocalHttpsListener(): void {
  try {
    published()?.refresh();
  } catch (err) {
    console.warn("[local-https] the HTTPS listener refresh failed:", err instanceof Error ? err.message : err);
  }
}

/** `https://<hostname>` with the port when it is not 443. */
export function localHttpsUrl(hostname: string): string {
  const port = localHttpsPort();
  return `https://${hostname}${port === 443 ? "" : `:${port}`}`;
}
