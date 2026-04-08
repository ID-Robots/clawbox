import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";

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
      return gatewayOfflineResponse();
    }
    let html = await res.text();
    // Use the request hostname so WebSocket connects to the right address
    const host = request.headers.get("host")?.replace(/:\d+$/, "") || "clawbox.local";
    const wsUrl = `ws://${host}:${GATEWAY_PORT}`;
    // Rewrite relative asset paths (./assets/... → /assets/...) so they
    // resolve through Next.js rewrites which proxy to the gateway.
    html = html.replace(/\.\//g, '/');
    const safeToken = gatewayToken ? JSON.stringify(gatewayToken) : '""';
    const autoConnect = `<script>
      (function(){
        var KEY="openclaw.control.settings.v1";
        var wsUrl="${wsUrl}";
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
    html = html.replace(/<head\b[^>]*>/i, '$&' + autoConnect);
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
    return gatewayOfflineResponse();
  }
}

function gatewayOfflineResponse() {
  const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0f1a; color:#94a3b8; font-family:system-ui,sans-serif; }
  .box { text-align:center; }
  h2 { color:#e2e8f0; margin:0 0 8px; font-size:18px; }
  p { margin:0; font-size:14px; }
  button { margin-top:16px; padding:8px 20px; border:1px solid #334155; border-radius:8px;
           background:#1e293b; color:#e2e8f0; cursor:pointer; font-size:13px; }
  button:hover { background:#334155; }
</style></head><body>
<div class="box">
  <h2>OpenClaw Gateway Offline</h2>
  <p>The gateway service is not running on port ${GATEWAY_PORT}.</p>
  <button onclick="location.reload()">Retry</button>
</div>
</body></html>`;
  return new NextResponse(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
