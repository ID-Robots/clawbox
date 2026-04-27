import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";

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

export function redirectToSetup(request: NextRequest) {
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
  if (rawHost && ALLOWED_HOSTS.has(rawHost)) {
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

/**
 * Fetches the gateway SPA HTML and injects the ClawBox bar + auth token.
 * Used by both the root route and the catch-all gateway route.
 *
 * Timeout is 20s (was 3s): on Jetson the gateway can take 10–30s to
 * render its SPA root the first time after a restart while channels
 * and sidecars are warming up. The previous 3s was firing during
 * routine restarts and bouncing every gateway-backed app to /setup
 * even though setup was complete.
 */
export async function serveGatewayHTML(
  request: NextRequest
): Promise<NextResponse> {
  try {
    const [res, gatewayToken] = await Promise.all([
      fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      }),
      getGatewayToken(),
    ]);
    if (!res.ok) {
      return gatewayUnavailable();
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
    return gatewayUnavailable();
  }
}

/**
 * Returned when setup is complete but the gateway HTTP isn't responding
 * (still warming up after restart, briefly overloaded, etc.). Shows an
 * inline "starting" page that auto-retries instead of redirecting to
 * /setup, which would mislead the user into thinking setup itself broke.
 */
function gatewayUnavailable(): NextResponse {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>OpenClaw is starting…</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#0b0e14;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif}.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center}.spin{width:42px;height:42px;border:3px solid rgba(249,115,22,0.18);border-top-color:#f97316;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}h1{margin:0;font-size:18px;font-weight:600;color:#f3f4f6}p{margin:0;color:#9ca3af;font-size:14px;max-width:420px;line-height:1.5}.note{font-size:12px;color:#6b7280;margin-top:12px}</style></head><body><div class="wrap"><div class="spin"></div><h1>OpenClaw is starting…</h1><p>The gateway is warming up. This usually takes 10–30 seconds after a restart on Jetson hardware.</p><p class="note">This page auto-refreshes every 5 seconds.</p></div><script>setTimeout(function(){location.reload()},5000)</script></body></html>`;
  return new NextResponse(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
}
