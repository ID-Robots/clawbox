import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, runBackup } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/backup
// Body: {} or { idle: true } — `idle` sends a heartbeat-only ping; default
// runs a full backup synchronously (openclaw backup create + S3 PUT) and
// returns the daemon's exit code.
//
// On Jetson a real backup can take minutes — the request stays open until
// the daemon finishes. The UI should call this with no client-side timeout
// (or an explicit one matching the systemd unit's TimeoutStartSec=4h).
export async function POST(request: NextRequest) {
  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Empty body is fine — defaults to a non-idle backup.
    }
    if (body !== null && typeof body !== "object") {
      return NextResponse.json(
        { error: "request body must be an object" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const obj = (body ?? {}) as Record<string, unknown>;
    let idle = false;
    if (obj.idle !== undefined) {
      if (typeof obj.idle !== "boolean") {
        return NextResponse.json(
          { error: "'idle' must be a boolean when provided" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      idle = obj.idle;
    }
    const result = await runBackup({ idle });
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
