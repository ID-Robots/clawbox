export const dynamic = "force-dynamic";

import net from "net";
import { NextResponse } from "next/server";

import { isTunnelRequest, parseHostHeader } from "@/lib/host-allowlist";
import { localHttpsServing, localHttpsUrl } from "@/lib/local-https-listener";
import { readLocalHttpsState } from "@/lib/local-https-state";

/**
 * Where a page on the box's plain-HTTP address may move to: `{ url:
 * "https://<id>.lan.clawbox.com" }`, or `{ url: null }`.
 *
 * Read BEFORE sign-in (src/middleware.ts PRE_AUTH_API_PATHS): the login page is
 * where the move pays off, since a session is per origin and signing in twice
 * is what the owner would otherwise do. It names nothing secret — the hostname
 * is in public certificate-transparency logs from the day it is issued.
 *
 * A url is offered only while the certificate is VALID and :443 is serving it
 * (the listener's own word, scripts/local-https.js), to a request that came
 * over the LAN — never through the tunnel (already HTTPS, and another origin),
 * never on loopback (the kiosk's localhost is already a secure context), and
 * never on the hostname itself. The browser still decides: src/lib/
 * local-https-client.ts first fetches the https address and only then moves,
 * so a router that will not resolve the name (DNS-rebind protection) leaves
 * the owner on http://<IP>, working, rather than on an error page.
 *
 * Also the target of that probe: on the hostname it answers `{ url: null }`.
 */
export async function GET(req: Request) {
  const none = NextResponse.json({ url: null }, { headers: { "Cache-Control": "no-store" } });
  if (isTunnelRequest(req.headers)) return none;
  const host = parseHostHeader(req.headers.get("host"));
  if (!host) return none;
  if (host.hostname === "localhost" || (net.isIP(host.hostname) && /^(127\.|::1$|::ffff:127\.)/.test(host.hostname))) return none;
  const serving = localHttpsServing();
  if (!serving || Date.now() >= serving.notAfter || host.hostname === serving.hostname) return none;
  const state = await readLocalHttpsState();
  if (!state.enabled || state.hostname !== serving.hostname) return none;
  return NextResponse.json({ url: localHttpsUrl(serving.hostname) }, { headers: { "Cache-Control": "no-store" } });
}
