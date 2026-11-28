import { NextResponse } from "next/server";
import { isTunnelRequest } from "@/lib/host-allowlist";
import { getMonitorStatus } from "@/lib/monitors";
import { PEER_HEADER, isLoopback } from "../../../../scripts/proxy-peer.js";

export const dynamic = "force-dynamic";

// Where the monitors are, for /login (TASK-2850): the sign-in panel is drawn on
// the main monitor when the desktop window is laid over a row of them. Asked
// before anyone has signed in — after a boot nobody is, and GET
// /setup-api/monitors needs a session — so /login-api, a public prefix in
// middleware, answers it, and as little as it can:
//
//   * only the box's OWN screen is answered: a socket peer on loopback (the
//     `x-clawbox-peer` production-server.js writes over whatever a client sent,
//     scripts/proxy-peer.js) that is not the tunnel (which also connects from
//     loopback, but carries CF-Connecting-IP). The window laid over the
//     monitors is the box's own Chrome at localhost; a browser on the LAN, the
//     internet and `next dev` get `available: false` and start no wlr-randr;
//   * geometry only: the monitors that are on, numbered 1, 2, … in the
//     compositor's order (a monitor's own id carries its make, model and
//     serial), where each sits and how big it is, which is the main one, the
//     row's size and whether they mirror — rebuilt value by value, no label,
//     name, mode or trial;
//   * never cached.
export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  if (isTunnelRequest(request.headers) || !isLoopback(request.headers.get(PEER_HEADER))) {
    return NextResponse.json({ available: false }, { headers });
  }
  const status = await getMonitorStatus();
  if (!status.available) return NextResponse.json({ available: false }, { headers });
  const on = status.monitors.filter((m) => m.enabled && m.rect);
  const main = on.findIndex((m) => m.id === status.main);
  return NextResponse.json(
    {
      available: true,
      main: main >= 0 ? String(main + 1) : null,
      box: status.box ? { width: status.box.width, height: status.box.height } : null,
      mirror: status.mirror === true,
      monitors: on.map((m, i) => ({
        id: String(i + 1),
        label: "",
        enabled: true,
        rect: { x: m.rect!.x, y: m.rect!.y, width: m.rect!.width, height: m.rect!.height },
      })),
    },
    { headers },
  );
}
