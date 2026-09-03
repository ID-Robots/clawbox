import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import {
  ClawKeepError,
  clawKeepErrorBody,
  RestoreNeedsPassphraseError,
  runRestore,
} from "@/lib/clawkeep";
import { getEdition } from "@/lib/harness";
import { HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";
import { bounceHermesDashboard } from "@/lib/hermes-dashboard-control";
import { GATEWAY_PORT, gatewayReadyWaitMs } from "@/lib/openclaw-config";
import { waitForPortOpen } from "@/lib/port-probe";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);

// The OpenClaw unit that holds the restored state open. After we swap a
// directory (or file) atomically, a running process's existing handles still
// see the OLD inodes, so it has to be restarted for user-facing behaviour to
// reflect the restored state.
//
// Spelled with `.service` so it matches the NOPASSWD rule in
// config/clawbox-sudoers verbatim — sudoers Cmnd_Spec is exact-string, so
// "clawbox-gateway" would NOT match "clawbox-gateway.service".
const OPENCLAW_RESTART_UNIT = "clawbox-gateway.service";

/**
 * Bring the process that holds the restored state back onto the new inodes.
 *
 * WHICH process is per-edition, and so is HOW it is restarted.
 *
 * OPENCLAW — `clawbox-gateway.service`, restarted through the sudoers grant
 * that exists for it.
 *
 * HERMES — `clawbox-hermes-dashboard.service`, and NOT through sudo. There is
 * deliberately no sudoers grant over any Hermes unit:
 * `install-foreign-edition-teardown.test.ts` asserts it, because `systemctl
 * restart` STARTS a stopped unit and such a grant would let a customer on an
 * OpenClaw box resurrect the Hermes dashboard the foreign-edition teardown had
 * just stopped and disabled. That decision is right and it stays.
 *
 * What was wrong was reaching for `sudo systemctl restart` anyway and calling
 * the guaranteed refusal "best effort". On the owner's Hermes box the restore
 * put every file back and then reported it could not restart the dashboard.
 *
 * `bounceHermesDashboard()` is the path built for exactly this: it asks the
 * unit whether it is `Restart=always`, and if so runs `hermes dashboard
 * --stop`, which is unprivileged (the dashboard runs `User=clawbox`, and the
 * unit's own ExecStartPre runs the same command) and is a stop, not a start —
 * so a dashboard that is stopped and disabled stays that way. Its own doc
 * comment names "a restored backup" as the reason it exists; ClawKeep simply
 * never picked it up, because it landed after this route was written.
 *
 * Either way a failure is REPORTED, never swallowed: an unrestarted process
 * keeps serving pre-restore state from the handles it already holds, so the one
 * thing this must not do is stay quiet about it. The caller puts whatever comes
 * back into `restartErrors` and the result card tells the owner which unit to
 * restart by hand.
 */
async function restartStateHolder(edition: string): Promise<string[]> {
  if (edition === "hermes") {
    if (await bounceHermesDashboard()) return [];
    // No exception to quote: bounceHermesDashboard() never throws, it answers
    // "this box was left exactly as it was". Say which of its two reasons the
    // owner can act on rather than inventing a detail we do not have.
    const detail =
      "could not be bounced from here — the unit is not Restart=always, the stop did not take, or it did not start serving again";
    console.warn(`[clawkeep/restore] ${HERMES_DASHBOARD_UNIT} ${detail}`);
    return [`${HERMES_DASHBOARD_UNIT}: ${detail}`];
  }
  try {
    // The unit name comes from the const above rather than being spelled again
    // here, and scripts/check-sudoers-coverage.sh resolves it: one name, checked
    // against the allow-list, with no second copy to drift.
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", OPENCLAW_RESTART_UNIT], {
      timeout: 30_000,
    });
    // The unit is Type=simple: `restart` returns when the process is forked,
    // seconds before it re-opens :18789 with the restored state. Answering `[]`
    // there reported the restore as served by a gateway that was still starting
    // — the same false success the Hermes half above no longer reports.
    if (await waitForPortOpen(GATEWAY_PORT, "127.0.0.1", { timeoutMs: gatewayReadyWaitMs() })) return [];
    const detail = "was restarted but is not serving the restored state yet";
    console.warn(`[clawkeep/restore] ${OPENCLAW_RESTART_UNIT} ${detail}`);
    return [`${OPENCLAW_RESTART_UNIT}: ${detail}`];
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Visible in journalctl this way even if the user dismisses the result
    // card before reading restartErrors.
    console.warn(`[clawkeep/restore] systemctl restart ${OPENCLAW_RESTART_UNIT} failed: ${detail}`);
    return [`${OPENCLAW_RESTART_UNIT}: ${detail}`];
  }
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

    // The restore itself has succeeded by here. A process that could not be
    // brought back onto the restored inodes is still a partial result, so the
    // reasons travel out to the caller instead of being swallowed.
    const restartErrors = await restartStateHolder(getEdition());

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
      clawKeepErrorBody(err, "Restore failed"),
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
