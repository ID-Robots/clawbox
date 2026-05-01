import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import os from "os";
import net from "net";
import crypto from "crypto";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const OPENCLAW_CONFIG_PATH = "/home/clawbox/.openclaw/openclaw.json";

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

export function redirectToSetup(request: NextRequest): NextResponse {
  const rawProto = request.headers.get("x-forwarded-proto");
  const proto =
    rawProto
      ?.split(",")
      .map((t) => t.trim().toLowerCase())
      .find((t) => ALLOWED_PROTOS.has(t)) ?? "http";
  const rawHost = request.headers
    .get("host")
    ?.toLowerCase()
    .replace(/:\d+$/, "");
  if (rawHost && isReflectableHost(rawHost)) {
    return NextResponse.redirect(
      new URL(`${proto}://${request.headers.get("host")}/setup`),
      302
    );
  }
  return NextResponse.redirect(new URL(`${CANONICAL_ORIGIN}/setup`), 302);
}

const CLAWBOX_BAR = `<div id="clawbox-bar" style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:6px;padding:4px 14px;background:rgba(17,24,39,0.92);border:1px solid rgba(249,115,22,0.3);border-top:none;border-radius:0 0 10px 10px;font-family:system-ui,sans-serif;font-size:12px;color:#d1d5db;backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,0.3)">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<a href="/" style="color:#f97316;text-decoration:none;font-weight:600">ClawBox</a>
</div>`;

export async function getGatewayToken(): Promise<string> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    return config?.gateway?.auth?.token || "";
  } catch {
    return "";
  }
}

// Legacy literal that earlier ClawBox builds wrote into `gateway.auth.token`.
// Public knowledge (it's in the open-source git history), so any device still
// carrying it gets rotated to a per-device random token on the next configure
// or reset.
const LEGACY_GATEWAY_TOKEN = "clawbox";
const MIN_GATEWAY_TOKEN_LENGTH = 32;

/**
 * Returns the existing per-device gateway auth token, or freshly generates
 * one when the on-disk value is missing, the legacy literal `"clawbox"`, or
 * shorter than the minimum random length.
 *
 * Caller is responsible for persisting the returned value (via
 * `runOpenclawConfigSet`, `runCommand`, or a direct seed write).
 */
export async function getOrGenerateGatewayToken(): Promise<string> {
  const existing = await getGatewayToken();
  if (
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
