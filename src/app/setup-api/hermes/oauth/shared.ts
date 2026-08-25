import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { requireSession } from "@/lib/route-auth";

// Shared plumbing for the wizard-driven Hermes provider-OAuth routes
// (start / submit / poll / cancel). These exist so the browser NEVER has to
// reach the Hermes dashboard itself: the dashboard's auth proxy lives on :8090,
// which a tunnel or reverse proxy (clawbox-tunnel on :80, Cloudflare quick
// tunnel) does not forward — sending the user there worked only on the LAN.
// Instead the wizard talks to these same-origin routes, and the server relays
// to the dashboard API over dashboardFetch (127.0.0.2:9119, cookie-authed).

// The wizard only ever sends ids it got from GET /setup-api/hermes/oauth, but
// these values are spliced into a dashboard URL path, so they are charset-
// guarded here too. Session ids are dashboard-minted opaque tokens
// (UUID-shaped today); the guard is shape, not meaning.
const PROVIDER_ID_RE = /^[a-z0-9_-]+$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && PROVIDER_ID_RE.test(value);
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

// Bound the request body BEFORE JSON.parse — Route Handlers have no built-in
// body-size limit, and this server runs on a memory-constrained Jetson.
// Anything the wizard legitimately sends is under a kilobyte.
export const MAX_BODY_BYTES = 16 * 1024;
// Whole-body deadline on top of the byte cap: Node's server-level
// requestTimeout still allows five minutes of dribbled chunks, each arriving
// just often enough to hold a handler open. A wizard POST that hasn't fully
// arrived within this window is not a wizard POST.
const BODY_READ_TIMEOUT_MS = 10_000;

/** Parse a JSON object body, refusing oversized, stalled or malformed input
 *  with null. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  if (request.body) {
    // Read the stream with a running byte cap (a chunked body with no — or a
    // lying — content-length can never be buffered past the limit) and a
    // deadline (a read that stalls can never hold the handler open).
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    const deadlineAt = Date.now() + BODY_READ_TIMEOUT_MS;
    try {
      for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new Error("body read deadline");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const step = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("body read deadline")), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
        if (step.done) break;
        received += step.value.byteLength;
        if (received > MAX_BODY_BYTES) throw new Error("body too large");
        chunks.push(step.value);
      }
    } catch {
      await reader.cancel().catch(() => {});
      return null;
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 404 unless the device runs Hermes — same gate as ../route.ts. */
export async function hermesGate(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

/**
 * Edition gate plus the owner's session — what the three OAuth routes that
 * CHANGE something (start / submit / cancel) run before anything else.
 *
 * Middleware is the primary gate and already refuses these paths without a
 * session: the bootstrap allow-list in `@/lib/setup-api-gate` names only what
 * wizard steps 1-3 call, and this flow belongs to step 4 — AIModelsStep runs
 * after CredentialsStep has set the password and been handed a session cookie,
 * so it is authenticated by the time it gets here. The wizard needs no
 * carve-out and does not get one.
 *
 * This is the second line, on the same argument `@/lib/route-auth` makes for
 * the destructive handlers: one gate maintained by hand in front of a ~100-route
 * surface is one `startsWith` away from serving a route it meant to refuse, and
 * these three are worth refusing twice. `start` opens a provider sign-in session
 * against the owner's own dashboard, `submit` hands that session an
 * authorization code, `cancel` destroys one — all while the device may still be
 * broadcasting the open `ClawBox-Setup` AP. TASK-527.
 *
 * No `allowBootstrap`: nothing in this flow has a first-boot role, so it fails
 * closed on a device with no password rather than opening a window.
 *
 * The edition check stays first deliberately. It answers from
 * `getActiveHarness()`, which the wizard already reads pre-auth through the
 * allow-listed `/setup-api/harness/active`, so ordering it ahead of the session
 * check tells an anonymous caller nothing it could not already ask for.
 */
export async function ownerGate(request: Request): Promise<NextResponse | null> {
  const wrongEdition = await hermesGate();
  if (wrongEdition) return wrongEdition;
  return requireSession(request);
}

/**
 * Relay a dashboard response to the browser: same status, but only the listed
 * keys. A whitelist rather than a blanket passthrough because the dashboard's
 * responses are its own API surface — if it ever grows a field carrying
 * credential material, that field must not fall out of this route by default.
 * FastAPI signals errors as `detail`; surface that as `error` so the panel's
 * existing error handling reads it.
 */
export async function relayJson(res: Response, keys: readonly string[]): Promise<NextResponse> {
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body (dashboard mid-restart); relay the status alone.
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  if (!res.ok && typeof out.error !== "string") {
    const detail = data.detail;
    const message = data.message;
    out.error =
      typeof detail === "string" && detail
        ? detail
        : typeof message === "string" && message
          ? message
          : `Hermes dashboard error (HTTP ${res.status})`;
  }
  return NextResponse.json(out, { status: res.status });
}

export function dashboardUnreachable(): NextResponse {
  return NextResponse.json({ error: "Hermes dashboard is unreachable" }, { status: 502 });
}
