import { NextResponse } from "next/server";

import { readTunnelUrl, startTunnelService } from "@/lib/cloudflared";
import { isInternalRequest } from "@/lib/internal-token";
import { pushHeartbeatTick } from "@/lib/portal-heartbeat";
import { requireSession } from "@/lib/route-auth";
import { checkTunnelLiveness, markRestarted, mayRestart } from "@/lib/tunnel-liveness";

export const dynamic = "force-dynamic";

// GET /setup-api/portal/heartbeat-tick
//
// Fired every ~5 minutes by clawbox-heartbeat.timer (systemd) so the
// portal's `lastSeenAt < 10 min ago` derivation flags this device as
// Online while it's actually alive. Without the tick, devices fall off
// to Offline 10 minutes after the last cloudflared URL rotation even
// when they're up.
//
// Since 2026-08-09 the tick also refuses to advertise a hostname that no
// longer resolves. Cloudflare reaps quick tunnels server-side; when that
// happens with cloudflared still running, tunnel.url keeps a corpse and the
// box reported it every five minutes forever, so the portal showed a green
// Online next to a link that could not work. On the live fleet that was 5 of
// 30 devices, and two days later 4 of 30 — the only recovery in between was a
// box someone fixed by hand after its owner complained.
//
// We exposed this as a *separate* route from /portal/status because the
// status endpoint does extra work (cloudflared install probe, systemd
// state read) that the timer doesn't need on every tick. Keeping the
// surfaces distinct also means a future addition to /portal/status
// can't accidentally widen the timer's blast radius.
//
// Authenticated, despite being pre-auth in middleware. The route has to stay
// reachable without a session — the timer curls it on a device nobody has logged
// into — but "no session required" had become "anyone may call it", and the dead
// -tunnel branch below RESTARTS a systemd unit. Anyone on the LAN, or anyone
// holding the box's public tunnel URL, could bounce clawbox-tunnel four times an
// hour by hitting this path (TASK-446). So: our own units present the
// per-install internal token (see src/lib/internal-token.ts, and the
// EnvironmentFile line in config/clawbox-heartbeat.service), the owner's browser
// presents a session cookie, and everyone else gets 401.
//
// Otherwise always returns 200. The tick helper is fire-and-forget: it no-ops on
// missing token, missing tunnel URL, or network failure — surfacing a 500
// here would just make the systemd unit flap, which the timer's
// SuccessExitStatus already tolerates. The restart is best-effort for the
// same reason.
export async function GET(request: Request) {
  if (!isInternalRequest(request)) {
    const unauthorized = await requireSession(request);
    if (unauthorized) return unauthorized;
  }

  const tunnelUrl = await readTunnelUrl();
  const liveness = await checkTunnelLiveness(tunnelUrl);

  if (liveness === "dead") {
    // Do not push. Reporting a hostname we have just proven does not exist is
    // the whole bug. Restart instead: run-tunnel.sh clears the file and
    // captures a fresh URL, which the next tick will pick up and push.
    let restarted = false;
    if (mayRestart()) {
      try {
        // The `enable` verdict is read, not discarded. It is NOT surfaced in the
        // body: this path restarts a unit that was already running, so it was
        // already enabled, and the timer has no owner watching it. What a failure
        // here means is that the box's own repair could not re-arm boot start —
        // worth a line in the journal an operator can find, and nothing more.
        const { bootPersisted, bootPersistWarning } = await startTunnelService();
        markRestarted();
        restarted = true;
        console.warn(`[heartbeat-tick] tunnel hostname dead, restarted clawbox-tunnel (was ${tunnelUrl})`);
        if (!bootPersisted) console.warn(`[heartbeat-tick] ${bootPersistWarning}`);
      } catch (err) {
        console.warn("[heartbeat-tick] tunnel restart failed:", err instanceof Error ? err.message : err);
      }
    }
    return NextResponse.json(
      { ok: true, tunnel: "dead", restarted },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // "unknown" means our own DNS is down, not that the tunnel is. Pushing the
  // last known URL keeps the device visibly Online through a network blip,
  // which is the behaviour it always had.
  pushHeartbeatTick(tunnelUrl);
  return NextResponse.json(
    { ok: true, tunnel: liveness },
    { headers: { "Cache-Control": "no-store" } },
  );
}
