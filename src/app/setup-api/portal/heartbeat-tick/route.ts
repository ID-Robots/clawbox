import { NextResponse } from "next/server";

import { readTunnelUrl } from "@/lib/cloudflared";
import { pushHeartbeatTick } from "@/lib/portal-heartbeat";

export const dynamic = "force-dynamic";

// GET /setup-api/portal/heartbeat-tick
//
// Fired every ~5 minutes by clawbox-heartbeat.timer (systemd) so the
// portal's `lastSeenAt < 10 min ago` derivation flags this device as
// Online while it's actually alive. Without the tick, devices fall off
// to Offline 10 minutes after the last cloudflared URL rotation even
// when they're up.
//
// We expose this as a *separate* route from /portal/status because the
// status endpoint does extra work (cloudflared install probe, systemd
// state read) that the timer doesn't need on every tick. Keeping the
// surfaces distinct also means a future addition to /portal/status
// can't accidentally widen the timer's blast radius.
//
// Always returns 200 + `{ ok: true }`. The tick helper is fire-and-
// forget: it no-ops on missing token, missing tunnel URL, or network
// failure — surfacing a 500 here would just make the systemd unit
// flap, which the timer's SuccessExitStatus already tolerates.
export async function GET() {
  pushHeartbeatTick(await readTunnelUrl());
  return NextResponse.json({ ok: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
