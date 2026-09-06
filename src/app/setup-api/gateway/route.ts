import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";
import { controlUiEmailDirectiveScript } from "@/lib/control-ui-email-directives";
import * as configStore from "@/lib/config-store";
import { getGatewayServiceHealth, type GatewayServiceHealth } from "@/lib/gateway-health";
import { envPort } from "@/lib/port-probe";
import { readEditionSource } from "@/lib/edition-source";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);

export async function GET(request: NextRequest) {
  try {
    const [res, gatewayToken] = await Promise.all([
      fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      }),
      getGatewayToken(),
    ]);
    if (!res.ok) {
      return gatewayOfflineResponse(await getGatewayServiceHealth());
    }
    let html = await res.text();
    // Use the request hostname so WebSocket connects to the right address.
    // The Host header is attacker-controllable and gets embedded in the inline
    // <script> below, so only accept hostname / IP-literal characters — anything
    // else (quotes, angle brackets) falls back to the mDNS name so it can't
    // break out of the JS string context (reflected XSS).
    const rawHost = request.headers.get("host")?.replace(/:\d+$/, "") || "";
    const host = /^[A-Za-z0-9.-]+$/.test(rawHost) || /^\[[0-9a-fA-F:]+\]$/.test(rawHost)
      ? rawHost
      : "clawbox.local";
    const wsUrl = `ws://${host}:${GATEWAY_PORT}`;
    // Rewrite relative asset paths (href="./assets/…" / src="./assets/…" →
    // "/assets/…") so they resolve through Next.js rewrites which proxy to the
    // gateway. Anchored to href=/src= attributes so a bare "./" inside an inline
    // script or text node isn't corrupted (the old global replace mangled any
    // "./" in the document).
    html = html.replace(/\b(href|src)=(["'])\.\//gi, '$1=$2/');
    // Escape <, >, & (in addition to JSON.stringify) before embedding the token
    // in the inline <script>, so a token value containing "</script>" can't
    // break out of the script context (mirrors serveGatewayHTML()).
    const safeToken = gatewayToken
      ? JSON.stringify(gatewayToken)
          .replace(/&/g, "\\u0026")
          .replace(/</g, "\\u003c")
          .replace(/>/g, "\\u003e")
      : '""';
    const autoConnect = `<script>
      (function(){
        var KEY="openclaw.control.settings.v1";
        var wsUrl=${JSON.stringify(wsUrl)};
        try{
          var s=JSON.parse(localStorage.getItem(KEY)||"{}");
          s.url=wsUrl;
          s.token=${safeToken};
          localStorage.setItem(KEY,JSON.stringify(s));
        }catch(e){}
        window.__OPENCLAW_WS_URL__=wsUrl;
        window.addEventListener("DOMContentLoaded",function(){
          setTimeout(function(){
            var input=document.querySelector('input[placeholder*="WebSocket"],input[value*="ws://"]');
            if(input){
              var nativeSet=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
              nativeSet.call(input,wsUrl);
              input.dispatchEvent(new Event("input",{bubbles:true}));
            }
            var btn=document.querySelector('button');
            if(btn&&/connect/i.test(btn.textContent))btn.click();
          },500);
        });
      })();
    </script>`;
    // The SECOND route that serves the Control UI's HTML. `serveGatewayHTML`
    // injects the same handling for TASK-700, and a directive shown as a bare
    // id here would be the same defect through a different door — the failure
    // this repo keeps producing is the sibling call site, not the fix.
    //
    // From `<head>` the observer is what does the work: `document.body` is null
    // this early, `scan(null)` returns, and `document.documentElement` already
    // exists, so every node the SPA adds afterwards is still seen.
    const emailDirectives = controlUiEmailDirectiveScript(await uiLocale());
    html = html.replace(/<head\b[^>]*>/i, '$&' + autoConnect + emailDirectives);
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss: http: https:; frame-ancestors 'self'",
      },
    });
  } catch {
    return gatewayOfflineResponse(await getGatewayServiceHealth());
  }
}

/** The language the owner picked; see the twin in `gateway-proxy.ts`. */
async function uiLocale(): Promise<string | undefined> {
  try {
    const value = await configStore.get("pref:ui_language");
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function gatewayOfflineResponse(health: GatewayServiceHealth) {
  // A unit systemd cannot LOAD is not a unit that is down, and this page used to
  // tell both stories the same way: "OpenClaw Gateway Offline … not running on
  // port 18789", with a Retry that can never succeed and a restart command
  // systemctl refuses outright on a masked unit.
  //
  // The BRANCH is systemd's own LoadState, so it is right on a device whose
  // edition lock cannot be read; only the WORDING consults the edition, and
  // only where it can say something true.
  //
  // `unloadableState` rather than a boolean so the state itself is in scope
  // below: `masked` is the one value that licenses a claim about WHY (the
  // Hermes SKU's step_edition_gateway_state, or an update/factory reset holding
  // the lock), and `not-found` / `error` / `bad-setting` are units that will not
  // start for reasons this page has not measured.
  const unloadableState = health.unitLoaded === false ? health.loadState : null;
  const breaker = health.breakerActive && unloadableState === null
    ? `<p class="breaker" role="alert"><strong>Automatic restart breaker activated.</strong> Repair the configuration, then run <code>sudo systemctl reset-failed clawbox-gateway &amp;&amp; sudo systemctl restart clawbox-gateway</code>.</p>`
    : "";
  const finalError = health.finalStartupError
    ? `<pre>${escapeHtml(health.finalStartupError)}</pre>`
    : "";

  // `readEditionSource`, not `readEdition`/`openclawIsAbsent`: those collapse
  // "the device said openclaw" and "nothing on this device said anything, so I
  // guessed openclaw" into one value. A Hermes box whose root-owned lock cannot
  // be read would then be handed the OpenClaw sentence — the exact false claim
  // the device-derived branch above exists to avoid — so a guessed edition
  // names no cause at all.
  const { edition, defaulted } = readEditionSource();
  const hermesEdition = !defaulted && edition === "hermes";

  let status = 503;
  let heading = "OpenClaw Gateway Offline";
  let detail = `The gateway service is not running on port ${GATEWAY_PORT}.`;
  // Retrying a device that has no gateway unit at all only repaints the same
  // page; while the mask is an update's lock it clears on its own, so the button
  // stays for that case and goes for the SKU that will never have one.
  let retry = true;

  if (unloadableState !== null) {
    if (hermesEdition) {
      // 404, like every other OpenClaw-only path on this SKU (`/api/*`,
      // `/assets/*`, `/chat`): 503 would tell a monitor or a service worker to
      // re-poll a condition that cannot change.
      status = 404;
      heading = "OpenClaw Is Not Installed";
      detail = "This device runs the Hermes agent. The OpenClaw gateway is not installed here — open the Hermes app from the desktop instead.";
      retry = false;
    } else {
      heading = "Gateway Unavailable";
      detail = unloadableState === "masked" && !defaulted
        ? "The gateway service is masked, so it cannot start. An update or factory reset holds that lock while it runs."
        : `systemd cannot load <code>clawbox-gateway.service</code> (<code>${escapeHtml(unloadableState)}</code>), so it cannot be started from here.`;
    }
  }

  const retryButton = retry ? `<button onclick="location.reload()">Retry</button>` : "";
  const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0f1a; color:#94a3b8; font-family:system-ui,sans-serif; }
  .box { text-align:center; }
  h2 { color:#e2e8f0; margin:0 0 8px; font-size:18px; }
  p { margin:0; font-size:14px; }
  .box { max-width:720px; padding:24px; }
  .breaker { margin-top:14px; color:#fbbf24; line-height:1.5; }
  code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  code { color:#fed7aa; }
  pre { margin:14px 0 0; padding:12px; text-align:left; white-space:pre-wrap; overflow-wrap:anywhere;
        border:1px solid #7f1d1d; border-radius:8px; background:#1f1115; color:#fecaca; font-size:12px; }
  button { margin-top:16px; padding:8px 20px; border:1px solid #334155; border-radius:8px;
           background:#1e293b; color:#e2e8f0; cursor:pointer; font-size:13px; }
  button:hover { background:#334155; }
</style></head><body>
<div class="box">
  <h2>${heading}</h2>
  <p>${detail}</p>
  ${breaker}
  ${finalError}
  ${retryButton}
</div>
</body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache",
    },
  });
}
