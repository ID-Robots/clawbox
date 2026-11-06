import { NextResponse } from "next/server";
import { envPort, isPortOpen } from "@/lib/port-probe";
import { gatewayRestartInFlight } from "@/lib/gateway-restart-tracker";
import { readOpenclawMigrationStatus } from "@/lib/openclaw-migration-status";
import { readOpenclawStartRecovery } from "@/lib/openclaw-start-recovery";

export const dynamic = "force-dynamic";

const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);

// Probe with a TCP connect rather than HTTP — the gateway's JS event loop
// stalls for tens of seconds during agent prep, and an HTTP probe would
// inherit those stalls and trip the desktop mascot's "DO NOT DISTURB"
// alarm on every chat message.
//
// A restart this server issued and has not seen through yet is NOT available,
// whatever the port says: for the first seconds of one the old process is
// still listening while systemd stops it, and a page that was answered before
// the restart finished (TASK-1535) polls this route to learn when the gateway
// is back — the old process answering would tell it "back" before it had gone.
//
// `migration` is the other half of "ready": a gateway can listen with every
// agent degraded because its databases are not on the schema the core expects
// (src/lib/openclaw-migration-status.ts). Carried beside `available`, never
// folded into it — the gateway IS up, and a client waiting for a restart must
// still see it come back. Only the reason and the byte counts: this route is
// served before sign-in, so it names no agent and no path.
//
// `startRecovery` is the same kind of fact about the gateway's last starts: it
// would not start over a database the core refused, and the pre-start repaired
// it or put back its pre-update copy (src/lib/openclaw-start-recovery.ts). The
// owner's data changed, so it is said. Outcome, reason and time only, for the
// same reason as above — and `channelsSuppressed`, whether the core's
// restart-loop breaker still holds channel auto-start back after that recovery
// (a gateway that is up, with Telegram and Discord silent). A yes or no, naming
// no channel.
export async function GET() {
  const restarting = gatewayRestartInFlight();
  const [available, migration, startRecovery] = await Promise.all([
    restarting ? Promise.resolve(false) : isPortOpen(GATEWAY_PORT, "127.0.0.1", 1000),
    readOpenclawMigrationStatus().catch(() => null),
    readOpenclawStartRecovery().catch(() => null),
  ]);
  return NextResponse.json({
    available,
    port: GATEWAY_PORT,
    restarting,
    ...(migration
      ? {
          migration: {
            state: migration.state,
            reason: migration.reason,
            requiredBytes: migration.requiredBytes,
            freeBytes: migration.freeBytes,
          },
        }
      : {}),
    ...(startRecovery
      ? {
          startRecovery: {
            outcome: startRecovery.outcome,
            reason: startRecovery.reason,
            at: startRecovery.at,
            channelsSuppressed: startRecovery.channelsSuppressed,
          },
        }
      : {}),
  });
}
