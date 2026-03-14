import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";

export async function GET() {
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return gatewayOfflineResponse();
    }
    let html = await res.text();
    // Inject <base href="/"> so relative asset paths resolve against root
    html = html.replace(/<head\b[^>]*>/i, '$&<base href="/">');
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:",
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
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
