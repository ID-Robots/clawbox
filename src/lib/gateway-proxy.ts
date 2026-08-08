import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import os from "os";
import net from "net";
import crypto from "crypto";
import { statSync } from "node:fs";
import {
  loadConfiguredOrigins,
  normalizeOrigin,
  resolveOriginsPath,
} from "./control-ui-origins";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_HOME
  ? `${process.env.OPENCLAW_HOME}/openclaw.json`
  : `${process.env.HOME ?? "/home/clawbox"}/.openclaw/openclaw.json`;

const ALLOWED_PROTOS = new Set(["http", "https"]);
const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || "http://clawbox.local";
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "clawbox.local,10.42.0.1,10.43.0.1,localhost")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

// Single mDNS label — letters/digits/hyphens, no dots, no leading/trailing
// hyphen. We append `.local` ourselves; allowing dots in the input would
// let a host header like `evil..local` slip through host comparison.
const MDNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

let cachedMdnsHost: string | null | undefined; // undefined = not loaded yet
function getSystemMdnsHost(): string | null {
  if (cachedMdnsHost !== undefined) return cachedMdnsHost;
  try {
    const label = os.hostname().trim().toLowerCase();
    cachedMdnsHost = MDNS_LABEL_RE.test(label) ? `${label}.local` : null;
  } catch {
    cachedMdnsHost = null;
  }
  return cachedMdnsHost;
}

// Without renamed-host support, ALLOWED_HOSTS was frozen to `clawbox.local`
// at install time, so any rename bounced the user to a NXDOMAIN page when
// the gateway was busy and we fell back to CANONICAL_ORIGIN.
function isReflectableHost(rawHost: string): boolean {
  if (ALLOWED_HOSTS.has(rawHost)) return true;
  if (rawHost === getSystemMdnsHost()) return true;
  if (net.isIPv4(rawHost)) return true;
  return false;
}

// Trusted control UI origins — a narrow escape hatch for genuinely
// cross-origin/custom-origin deployments (see control-ui-origins.ts and
// README). Unlike isReflectableHost() above (host-only, scheme/port-
// agnostic), a configured origin must match EXACTLY: scheme, host, and
// port (including a non-default port) all have to agree with an entry in
// the configured list. A configured hostname does not get reflected on a
// different scheme or port than what was configured.
interface ConfiguredOriginState {
  origins: Set<string>;
  hosts: Set<string>;
}

let cachedConfiguredOrigins: ConfiguredOriginState | undefined;
let cachedConfiguredOriginsSignature: string | undefined;

function configuredOriginsSignature(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return `${path}:missing`;
  }
}

function getConfiguredOrigins(): ConfiguredOriginState {
  const path = resolveOriginsPath();
  const signature = configuredOriginsSignature(path);
  if (
    cachedConfiguredOrigins !== undefined &&
    cachedConfiguredOriginsSignature === signature
  ) {
    return cachedConfiguredOrigins;
  }

  const { origins, warnings } = loadConfiguredOrigins(path);
  for (const warning of warnings) {
    console.warn(`[gateway-proxy] ${warning}`);
  }
  cachedConfiguredOrigins = {
    origins: new Set(origins),
    hosts: new Set(origins.map((origin) => new URL(origin).hostname.toLowerCase())),
  };
  cachedConfiguredOriginsSignature = signature;
  return cachedConfiguredOrigins;
}

function isConfiguredOrigin(proto: string, hostHeader: string): boolean {
  const { origin } = normalizeOrigin(`${proto}://${hostHeader}`);
  return origin !== null && getConfiguredOrigins().origins.has(origin);
}

export function redirectToSetup(request: NextRequest): NextResponse {
  const rawProto = request.headers.get("x-forwarded-proto");
  const proto =
    rawProto
      ?.split(",")
      .map((t) => t.trim().toLowerCase())
      .find((t) => ALLOWED_PROTOS.has(t)) ?? "http";
  const hostHeader = request.headers.get("host");
  const rawHost = hostHeader?.toLowerCase().replace(/:\d+$/, "");
  const exactConfiguredMatch =
    !!hostHeader && isConfiguredOrigin(proto, hostHeader);
  // A default-reflectable host (LAN IP / localhost / mDNS name) keeps its broad
  // reflection even when an operator also configures an exact origin for it:
  // configuring `https://10.42.0.1` must not stop plain `http://10.42.0.1` from
  // working on the SoftAP. Configured non-default origins reflect on an exact
  // scheme+host+port match.
  const reflectable =
    !!rawHost && (isReflectableHost(rawHost) || exactConfiguredMatch);
  if (reflectable) {
    try {
      return NextResponse.redirect(new URL(`${proto}://${hostHeader}/setup`), 302);
    } catch {
      // Malformed Host header (e.g. an out-of-range port like `:99999`, which
      // rawHost strips before the reflection check) — fall through to the
      // canonical origin instead of throwing a 500.
    }
  }
  return NextResponse.redirect(new URL(`${CANONICAL_ORIGIN}/setup`), 302);
}

const CLAWBOX_BAR = `<div id="clawbox-bar" style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:6px;padding:4px 14px;background:rgba(17,24,39,0.92);border:1px solid rgba(249,115,22,0.3);border-top:none;border-radius:0 0 10px 10px;font-family:system-ui,sans-serif;font-size:12px;color:#d1d5db;backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,0.3)">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<a href="/" style="color:#f97316;text-decoration:none;font-weight:600">ClawBox</a>
</div>`;

type GatewaySecretRef =
  { source: "env" | "file" | "exec"; provider: string; id: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isGatewaySecretRef(value: unknown): value is GatewaySecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const keys = Object.keys(ref);
  const source = ref.source;
  if (source === "env" || source === "file" || source === "exec") {
    // source is a valid enum and id/provider are non-empty strings, so with
    // exactly 3 keys they must be {source, id, provider} — no need to re-assert
    // each key is present.
    if (!isNonEmptyString(ref.id)) return false;
    return keys.length === 3 && isNonEmptyString(ref.provider);
  }
  return false;
}

function isGatewayTokenInterpolation(value: unknown): value is string {
  return typeof value === "string" && /^\$\{.+\}$/.test(value);
}

async function readGatewayTokenInput(): Promise<unknown> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    return config?.gateway?.auth?.token || "";
  } catch {
    return "";
  }
}

export async function getGatewayToken(): Promise<string> {
  const token = await readGatewayTokenInput();
  // ClawBox cannot resolve managed refs safely. Do not serialize a SecretRef
  // object or an unresolved ${ENV} marker into the browser as an auth token.
  return typeof token === "string" && !isGatewayTokenInterpolation(token)
    ? token
    : "";
}

// Legacy literal that earlier ClawBox builds wrote into `gateway.auth.token`.
// Public knowledge (it's in the open-source git history), so any device still
// carrying it gets rotated to a per-device random token on the next configure
// or reset.
const LEGACY_GATEWAY_TOKEN = "clawbox";
const MIN_GATEWAY_TOKEN_LENGTH = 32;

/**
 * Returns null for an externally managed token, the existing per-device
 * literal token when strong, or a fresh token when the on-disk value is
 * missing, the legacy literal `"clawbox"`, malformed, or too short.
 *
 * Caller is responsible for persisting the returned value (via
 * `runOpenclawConfigSet`, `runCommand`, or a direct seed write).
 */
export async function getOrGenerateGatewayToken(): Promise<string | null> {
  const existing = await readGatewayTokenInput();
  if (isGatewaySecretRef(existing) || isGatewayTokenInterpolation(existing)) {
    return null;
  }
  if (
    typeof existing === "string" &&
    existing &&
    existing !== LEGACY_GATEWAY_TOKEN &&
    existing.length >= MIN_GATEWAY_TOKEN_LENGTH
  ) {
    return existing;
  }
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Fetches the gateway SPA HTML and injects the ClawBox bar + auth token.
 * Used by both the root route and the catch-all gateway route.
 */
export async function serveGatewayHTML(
  request: NextRequest
): Promise<NextResponse> {
  try {
    const [res, gatewayToken] = await Promise.all([
      fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      }),
      getGatewayToken(),
    ]);
    if (!res.ok) {
      return redirectToSetup(request);
    }
    let html = await res.text();

    const safeToken = gatewayToken
      ? JSON.stringify(gatewayToken)
          .replace(/&/g, "\\u0026")
          .replace(/</g, "\\u003c")
          .replace(/>/g, "\\u003e")
      : "";
    // Script to set WebSocket URL + token so the OpenClaw UI auto-connects
    // to the gateway. The SPA stores settings in localStorage (field
    // "gatewayUrl") and tokens in sessionStorage under per-URL key
    // "openclaw.control.token.v1:<normalized_ws_url>".
    //
    // Use the SAME origin as the page (no port). The production server's
    // WebSocket upgrade proxy forwards ws[s]://<host>/ to the gateway on
    // port ${GATEWAY_PORT}, which works on the LAN, through HTTPS, and
    // through the Cloudflare tunnel (which only exposes port 80/443).
    // Stale gatewayUrl with ":${GATEWAY_PORT}" baked in is overwritten so
    // older sessions migrate automatically.
    const wsScript = `<script>
(function(){
  var SK="openclaw.control.settings.v1";
  var TP="openclaw.control.token.v1:";
  try{
    var wsUrl=(location.protocol==="https:"?"wss://":"ws://")+location.host;
    var s=JSON.parse(localStorage.getItem(SK)||"{}");
    if(s.gatewayUrl!==wsUrl){s.gatewayUrl=wsUrl;localStorage.setItem(SK,JSON.stringify(s))}
    ${safeToken ? `var t=${safeToken};var tk=TP+wsUrl;if(sessionStorage.getItem(tk)!==t){sessionStorage.setItem(tk,t)}` : ""}
    // Inject gatewayUrl+token into URL hash so the SPA auto-connects on first load
    if(!location.hash.includes("gatewayUrl")){
      var h=new URLSearchParams(location.hash.replace(/^#/,""));
      h.set("gatewayUrl",wsUrl);
      ${safeToken ? `h.set("token",t);` : ""}
      location.replace(location.pathname+location.search+"#"+h.toString());
    }
  }catch(e){}
})();
</script>`;
    html = html.replace(/<body\b[^>]*>/i, `$&${CLAWBOX_BAR}${wsScript}`);
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return redirectToSetup(request);
  }
}
