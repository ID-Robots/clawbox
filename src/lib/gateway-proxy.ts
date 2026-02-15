import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const OPENCLAW_CONFIG_PATH = "/home/clawbox/.openclaw/openclaw.json";

const ALLOWED_PROTOS = new Set(["http", "https"]);
const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || "http://clawbox.local";
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || "clawbox.local,10.42.0.1,localhost")
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
<a href="/setup" style="color:#f97316;text-decoration:none;font-weight:600">ClawBox</a>
</div>`;

async function getGatewayToken(): Promise<string> {
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
 */
export async function serveGatewayHTML(
  request: NextRequest
): Promise<NextResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const [res, gatewayToken] = await Promise.all([
      fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
        cache: "no-store",
        signal: controller.signal,
      }),
      getGatewayToken(),
    ]);
    if (!res.ok) {
      return redirectToSetup(request);
    }
    let html = await res.text();

    const tokenScript = gatewayToken
      ? `<script>
(function(){
  var KEY="openclaw.control.settings.v1";
  try{
    var s=JSON.parse(localStorage.getItem(KEY)||"{}");
    if(!s.token){s.token=${JSON.stringify(gatewayToken)};localStorage.setItem(KEY,JSON.stringify(s))}
  }catch(e){}
})();
</script>`
      : "";

    html = html.replace(/<body>/, `<body>${CLAWBOX_BAR}${tokenScript}`);
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return redirectToSetup(request);
  } finally {
    clearTimeout(timeout);
  }
}
