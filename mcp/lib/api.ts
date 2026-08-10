// HTTP to the device's own /setup-api/*.
//
// Three things every call gets that the previous helper did not:
//   1. A timeout. An unbounded fetch against a stalled Next.js route hung the
//      whole stdio server, and the agent saw nothing at all.
//   2. redirect:"manual". /setup-api/* is session-gated by src/middleware.ts;
//      without a valid bearer every call 307s to /login, and following it
//      returned the login HTML which JSON.parse then blamed on the tool.
//   3. Per-route error rules, so a 502 becomes an instruction instead of a
//      status code the model has to guess about.

import { readFileSync } from "fs";
import { join } from "path";
import { ApiError, type ErrorRule, matchRule, ToolError } from "./errors";

export const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
export const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";

const TOKEN_FILE = join(CLAWBOX_ROOT, "data", ".mcp-token");
const MIN_TOKEN_LEN = 16;
const DEFAULT_TIMEOUT_MS = 8_000;

export type TokenSource = "env" | "file" | "none";

let cached: { token: string; source: TokenSource } | null = null;

/**
 * The per-install bearer /setup-api/* accepts in lieu of a session cookie.
 *
 * The env var is what scripts/gateway-pre-start.sh injects on OpenClaw. The
 * FILE fallback is what lets a Hermes provisioning entry carry no secret in
 * ~/.hermes/config.yaml at all — and it means token rotation is not a
 * config-sync problem. Only successful reads are cached, so a token written
 * after the MCP started is still picked up.
 */
export function apiToken(): { token: string; source: TokenSource } {
  if (cached) return cached;
  const fromEnv = (process.env.CLAWBOX_MCP_TOKEN || "").trim();
  if (fromEnv.length >= MIN_TOKEN_LEN) {
    cached = { token: fromEnv, source: "env" };
    return cached;
  }
  try {
    const raw = readFileSync(TOKEN_FILE, "utf-8").trim();
    if (raw.length >= MIN_TOKEN_LEN) {
      cached = { token: raw, source: "file" };
      return cached;
    }
  } catch {
    // No token file — report it through clawbox_health rather than throwing
    // here, so a token-free device still lists its tools.
  }
  return { token: "", source: "none" };
}

export function authHeader(): string | null {
  const { token } = apiToken();
  return token ? `Bearer ${token}` : null;
}

export interface ApiOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** Per-route failure → instruction mappings. */
  rules?: ErrorRule[];
}

function buildUrl(path: string, query?: ApiOptions["query"]): string {
  if (!query) return `${API_BASE}${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
}

/** Call /setup-api/*. Throws a ToolError the register() wrapper can render. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, query, timeoutMs = DEFAULT_TIMEOUT_MS, rules } = options;
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = authHeader();
  if (auth) headers.authorization = auth;
  if (body) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      redirect: "manual",
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Field debugging only, and only on stderr — the harness log, never the
    // model's context. The agent still gets the scrubbed envelope below.
    if (process.env.CLAWBOX_MCP_DEBUG === "1") console.error("[clawbox-mcp] api failure:", path, err);
    if (err instanceof Error && /abort|timeout/i.test(err.message)) {
      throw new ToolError(
        "TIMEOUT",
        "The ClawBox service did not answer in time.",
        "Retry once. If it times out again, call clawbox_health and tell the user.",
      );
    }
    throw new ToolError(
      "ENDPOINT_DOWN",
      "The ClawBox service is not answering.",
      "Call clawbox_health to see what is down, then tell the user.",
    );
  }

  // A redirect is one of the app's two gates, and WHICH one matters:
  //   -> /login   the bearer was missing or stale        → AUTH_FAILED
  //   -> anything else (in practice /setup): this build has no such route, so
  //      the request fell through to the setup-completion redirect
  //                                                      → NOT_SUPPORTED_HERE
  // Treating every 3xx as AUTH_FAILED made a MISSING route report "the token was
  // rejected" while clawbox_health, in the same session, reported the same token
  // present and two other bearer-authenticated checks passing. A small model has
  // no way out of that: it re-reads the token and retries forever. Observed live
  // on a Hermes box whose build predates /setup-api/hermes/skills/*.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "";
    if (!location || /(^|\/)login(\/|\?|#|$)/.test(location)) {
      throw new ToolError(
        "AUTH_FAILED",
        "The ClawBox API token was rejected.",
        "Call clawbox_health; the device may have restarted since this session began.",
      );
    }
    throw new ToolError(
      "NOT_SUPPORTED_HERE",
      "This ClawBox does not have that feature: its software version does not provide it, or setup was never finished.",
      "Do not retry and do not call this tool again this session. Call device_status, then tell the user which version the device is on.",
    );
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const apiErr = new ApiError(res.status, raw);
    const mapped = matchRule(apiErr, rules);
    throw mapped ?? apiErr;
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ToolError(
      "ENDPOINT_DOWN",
      "The ClawBox service returned a response this tool could not read.",
      "Call clawbox_health, then retry once.",
    );
  }
}

export function apiGet<T = unknown>(
  path: string,
  options: Omit<ApiOptions, "method" | "body"> = {},
): Promise<T> {
  return api<T>(path, { ...options, method: "GET" });
}

export function apiPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  options: Omit<ApiOptions, "method" | "body"> = {},
): Promise<T> {
  return api<T>(path, { ...options, method: "POST", body });
}

/**
 * A read that must never fail the caller — used by the fan-out in
 * device_status, where one dead leg reports "unknown" instead of taking the
 * whole answer down.
 */
export async function apiTry<T>(path: string, options: ApiOptions = {}): Promise<T | null> {
  try {
    return await api<T>(path, options);
  } catch {
    return null;
  }
}
