import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, runRestore } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);

// Services that hold ~/.openclaw open while running. After we swap the
// directory atomically, their existing file handles still see the OLD
// inodes, so we restart them so user-facing behaviour reflects the
// restored state. clawbox-gateway is the only known consumer today;
// add more here as we discover them. Names use the .service suffix so
// they match the NOPASSWD sudoers rules in config/clawbox-sudoers
// verbatim (sudoers Cmnd_Spec is exact-string, so "clawbox-gateway"
// would NOT match "clawbox-gateway.service").
const RESTART_SERVICES = ["clawbox-gateway.service"];

// POST /setup-api/clawkeep/restore
// Body: { name: "<timestamp>-openclaw-backup.tar.gz" }
// Runs to completion synchronously — the request stays open through
// download (300+ MB), verify, extract, and the directory swap. Then it
// kicks the gateway service so it re-reads the restored state.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== "string" || !name) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const result = await runRestore(name);

    // Best-effort service restart. Swallow individual failures — the
    // restore itself succeeded, and a manual `systemctl restart` is a
    // recoverable follow-up.
    const restartErrors: string[] = [];
    for (const svc of RESTART_SERVICES) {
      try {
        await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", svc], {
          timeout: 30_000,
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        // Service-restart failures are visible in journalctl this way even
        // if the user dismisses the result card before reading restartErrors.
        console.warn(`[clawkeep/restore] systemctl restart ${svc} failed: ${detail}`);
        restartErrors.push(`${svc}: ${detail}`);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        archive: result.archive,
        archiveBytes: result.archiveBytes,
        assets: result.assets,
        restartErrors,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
