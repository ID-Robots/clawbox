import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, RestoreNeedsPassphraseError, runRestore } from "@/lib/clawkeep";
import { getEdition } from "@/lib/harness";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);

// Services that hold the restored state open while running. After we swap a
// directory (or file) atomically, their existing handles still see the OLD
// inodes, so they have to be restarted for user-facing behaviour to reflect
// the restored state.
//
// WHICH service is per-edition, and getting it wrong is not a cosmetic bug.
// install.sh's step_edition_gateway_state REMOVES the clawbox-gateway unit
// file on Hermes and persistently masks it, so restarting it there fails
// twice over — while `clawbox-hermes-dashboard`, which is the process
// actually holding `~/.hermes/state.db` open, is never touched. The restore
// then reports success and the agent keeps serving pre-restore state until
// something else happens to restart it. That is the same false-success shape
// this codebase has already been bitten by twice.
//
// Names use the .service suffix so they match the NOPASSWD sudoers rules in
// config/clawbox-sudoers verbatim — sudoers Cmnd_Spec is exact-string, so
// "clawbox-gateway" would NOT match "clawbox-gateway.service".
function restartServicesFor(edition: string): string[] {
  return edition === "hermes"
    ? ["clawbox-hermes-dashboard.service"]
    : ["clawbox-gateway.service"];
}

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
    // Optional one-shot passphrase from the UI prompt — used when the
    // device has no stored passphrase, or to retry after a wrong-password
    // failure on a previous attempt. Empty string is treated as "not
    // supplied" so a misbehaving form doesn't accidentally try to
    // decrypt with an empty key.
    const passphraseRaw = body.passphrase;
    const passphrase = typeof passphraseRaw === "string" && passphraseRaw.length > 0
      ? passphraseRaw
      : undefined;

    const result = await runRestore(name, { passphrase });

    // Best-effort service restart. Swallow individual failures — the
    // restore itself succeeded, and a manual `systemctl restart` is a
    // recoverable follow-up.
    const restartErrors: string[] = [];
    for (const svc of restartServicesFor(getEdition())) {
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
        // Passed through rather than dropped: a restore that could not
        // recreate part of the archive is not a clean success, and the card
        // has to be able to say which part.
        skippedMembers: result.skippedMembers ?? [],
        restartErrors,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof RestoreNeedsPassphraseError) {
      // Surface the structured "kind" so the UI can decide between
      // "prompt for password" (passphrase_missing) and "show error +
      // re-prompt" (wrong_password) without parsing the message string.
      return NextResponse.json(
        { error: err.message, kind: err.kind, needsPassphrase: true },
        { status: err.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
