import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, runBackup } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/backup
// Body: {} or { idle: true } — `idle` sends a heartbeat-only ping; default
// runs a full restic backup synchronously and returns the daemon's exit code.
//
// On Jetson a real backup can take minutes — the request stays open until
// the daemon finishes. The UI should call this with no client-side timeout
// (or an explicit one matching the systemd unit's TimeoutStartSec=4h).
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { idle?: boolean };
    const result = await runBackup({ idle: !!body.idle });
    return NextResponse.json(
      {
        exitCode: result.exitCode,
        ok: result.exitCode === 0,
        stdoutTail: result.stdout.slice(-2000),
        stderrTail: result.stderr.slice(-2000),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backup failed" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
