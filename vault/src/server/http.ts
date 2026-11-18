// HTTP helpers: JSON responses, bounded JSON bodies, typed errors and the Host
// header check that keeps DNS-rebinding pages away from the loopback API.
import { isIpLiteral, isLocalhost } from "../shared/domain";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const MAX_BODY = 64 * 1024;

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "expected application/json");
  const text = await readBounded(req);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Never echo the parser message: it can quote the body, which may hold a password.
    throw new HttpError(400, "invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "expected a JSON object");
  return body as Record<string, unknown>;
}

/** The body as text, read no further than MAX_BODY bytes: a larger one is cut off with a 413. */
async function readBounded(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HttpError(413, "body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/**
 * Accept loopback names, IP literals and LAN-style names that public DNS cannot
 * point at us (single label, .local, .lan, .internal, .home.arpa, .localhost),
 * plus configured names. A page on a rebinding public domain is refused.
 */
export function hostAllowed(hostHeader: string | null, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isLocalhost(bare) || isIpLiteral(bare)) return true;
  if (!bare.includes(".")) return true;
  if (/\.(local|lan|internal|home\.arpa|localhost)$/.test(bare)) return true;
  return extra.includes(bare);
}

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
