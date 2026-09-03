import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, clawKeepErrorBody, runBackup } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/backup
// Body: {} or { idle: true } — `idle` sends a heartbeat-only ping; default
// runs a full backup synchronously (openclaw backup create + S3 PUT) and
// returns the daemon's exit code.
//
// On Jetson a real backup can take minutes — the request stays open until
// the daemon finishes. The UI should call this with no client-side timeout
// (or an explicit one matching the systemd unit's TimeoutStartSec=4h).
//
// A box with no pairing is refused with 409 `not_paired` before the daemon is
// started: `clawkeepd` would have loaded the token, failed and exited 65, and
// returning that exit code inside a 200 body made a backup that never began
// arrive as a success.
//
// 65 is not the only pre-run exit — `daemon.py` returns 64 for a bad config
// before it reaches the token at all. A non-zero `exitCode` in a 200 body
// therefore means the daemon was started and did not succeed — or, for the two
// codes the bridge synthesises itself, that it could not be started at all
// (127, spawn error) or was killed by our own timer (124). Either way the
// backup did not happen. Classifying the rest of the daemon's `EXIT_*`
// taxonomy into HTTP statuses is a separate change to the backup result path.
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
    // Optional "Name this backup" label. Reject a non-string so a malformed
    // form can't smuggle an object/array into the daemon's argv.
    let label: string | undefined;
    if (obj.label !== undefined && obj.label !== null) {
      if (typeof obj.label !== "string") {
        return NextResponse.json(
          { error: "'label' must be a string when provided" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      label = obj.label;
    }
    const result = await runBackup({ idle, label });
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
      clawKeepErrorBody(err, "Backup failed"),
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
