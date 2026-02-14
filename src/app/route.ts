import { NextRequest, NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const CLAWBOX_BAR = `<div id="clawbox-bar" style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:6px;padding:4px 14px;background:rgba(17,24,39,0.92);border:1px solid rgba(249,115,22,0.3);border-top:none;border-radius:0 0 10px 10px;font-family:system-ui,sans-serif;font-size:12px;color:#d1d5db;backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:default;">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<a href="/setup" style="color:#f97316;text-decoration:none;font-weight:600;">ClawBox</a>
<span style="color:#6b7280;">|</span>
<a href="/setup" style="color:#9ca3af;text-decoration:none;font-size:11px;">Settings</a>
</div>`;

function redirectToSetup(request: NextRequest) {
  const proto =
    request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost";
  return NextResponse.redirect(new URL(`${proto}://${host}/setup`), 302);
}

export async function GET(request: NextRequest) {
  const config = await getAll();

  if (!config.setup_complete) {
    return redirectToSetup(request);
  }

  // Proxy the OpenClaw Control UI from the gateway
  try {
    const res = await fetch("http://127.0.0.1:18789/", { cache: "no-store" });
    if (!res.ok) {
      return redirectToSetup(request);
    }
    let html = await res.text();

    // Inject ClawBox navigation bar
    html = html.replace("</body>", `${CLAWBOX_BAR}</body>`);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    // Gateway not running — fall back to setup
    return redirectToSetup(request);
  }
}
