import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, backupExitError, clawKeepErrorBody, runBackup } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/backup
// Body: {} or { idle: true } — `idle` sends a heartbeat-only ping; default
// runs a full backup synchronously (openclaw backup create + S3 PUT) and
// returns the daemon's exit code.
//
// On Jetson a real backup can take minutes — the request stays open until the
// daemon finishes. The UI should call this with no client-side timeout: the
// bridge's own kill timer (BACKUP_RUN_CAP_MS, 60 minutes) is the real ceiling
// and now has an owner-facing answer of its own, 504 `timed_out`. The systemd
// unit's TimeoutStartSec=4h applies to the SCHEDULED run, not to this one.
//
// A box with no pairing is refused with 409 `not_paired` before the daemon is
// started: `clawkeepd` would have loaded the token, failed and exited 65, and
// returning that exit code inside a 200 body made a backup that never began
// arrive as a success.
//
// Every OTHER non-zero exit is classified too (TASK-672). `backupExitError`
// maps the daemon's own `EXIT_*` taxonomy — plus the two codes the bridge
// synthesises itself, 124 for our kill timer and 127 for a daemon that could
// not be started — onto a status, a stable `code` and one owner-facing
// sentence. No failure leaves here as 2xx, and no FAILURE carries `stderrTail`:
// that is the daemon's log line, written for an operator, and it has put an
// absolute device path in front of the customer.
//
// The 200 still carries it, deliberately and with a known cost: `clawkeepd`
// logs through `logging.basicConfig`, i.e. stderr, so a backup that SUCCEEDED
// after warning ("failed to remove staging archive /home/…", "retention prune
// failed (continuing)") still shows that line inside the panel's green card.
// Whether the owner should see the daemon's tail on a run that worked is a
// product decision, not a bug fix — TASK-672 says so in as many words — so it
// is left alone here rather than changed in passing.
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
    const failure = backupExitError(result.exitCode);
    if (failure) {
      // The daemon's output stays in the server log, where an operator can
      // read it; the owner gets the sentence and the code.
      console.warn(
        `[clawkeep] backup exited ${result.exitCode}: ${result.stderr.slice(-2000)}`,
      );
      return NextResponse.json(
        { ...clawKeepErrorBody(failure, "Backup failed"), exitCode: result.exitCode },
        { status: failure.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        exitCode: result.exitCode,
        ok: true,
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
