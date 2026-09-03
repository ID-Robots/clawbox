export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { set, setMany } from "@/lib/config-store";
import { getSessionSigningSecret, createSessionCookie, getSessionGeneration } from "@/lib/auth";
import { announceTimezoneToAgent } from "@/lib/timezone-agent";
import { TIMEZONE_SYNCED_KEY, isValidTimezoneName, setTimezone } from "@/lib/timezone";

/**
 * The wizard's timezone one-shot. TASK-514.
 *
 * The wizard sends the zone the customer's own browser resolved
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`) alongside the completion
 * POST, because that is the one moment where a device that knows the answer is
 * talking to a box that does not: asking the owner to find their zone in a
 * picker they never needed is a worse first-boot than reading it off the phone
 * already in their hand. Settings → System stays the place to correct it.
 *
 * Everything here is best-effort and deliberately quiet:
 *  - a missing, empty or non-JSON body is the old contract and still completes;
 *  - an invalid zone is IGNORED rather than 400'd — a browser that reports
 *    nonsense (or nothing) must never be able to block finishing setup;
 *  - a box with no `timedatectl` at all (a dev machine, a container) throws in
 *    here and setup still completes.
 * It runs BEFORE the setup_complete write so a failure in it cannot leave setup
 * half-marked, and so the rollback below stays about the write it guards.
 */
async function applyWizardTimezone(req?: Request): Promise<void> {
  if (!req) return;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return; // No body, or not JSON: the pre-TASK-514 wizard. Nothing to do.
  }
  const zone = (body as { timezone?: unknown } | null)?.timezone;
  if (!isValidTimezoneName(zone)) return;

  const status = await setTimezone(zone);
  // Marks the zone as having been set once, which is what stops the desktop's
  // one-shot (for boxes upgraded into this feature) from ever asking again.
  await set(TIMEZONE_SYNCED_KEY, true);
  // restartHarness: false on purpose. Setup completion starts the harness right
  // after this response — the wizard's last screen polls the gateway/Hermes for
  // readiness — and a process started AFTER the zone is applied already reads
  // it. Restarting here would buy nothing and only lengthen that last screen.
  await announceTimezoneToAgent(status.timezone, { restartHarness: false });
}

export async function POST(req?: Request) {
  try {
    // Best-effort, and first: setup completing matters more than the clock.
    try {
      await applyWizardTimezone(req);
    } catch {
      // A box with no timedatectl, a helper that isn't installed yet, a zone
      // the OS refused — none of that is a reason to fail setup. The owner can
      // still set the zone in Settings → System, and the desktop's one-shot
      // will offer to do it for them.
    }

    const timestamp = new Date().toISOString();
    await setMany({
      setup_complete: true,
      setup_completed_at: timestamp,
      setup_progress_step: undefined,
    });

    // Auto-login after first setup so user isn't shown the login screen
    const res = NextResponse.json({ success: true });
    try {
      const secret = await getSessionSigningSecret();
      const gen = await getSessionGeneration();
      const cookie = createSessionCookie(86400, secret, gen); // 24h session, current generation
      res.cookies.set("clawbox_session", cookie, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 86400,
        secure: false,
      });
    } catch {
      // Non-fatal: user will just see the login screen
    }
    return res;
  } catch (err) {
    // Rollback on partial failure
    await setMany({
      setup_complete: undefined,
      setup_completed_at: undefined,
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to complete setup",
      },
      { status: 500 }
    );
  }
}
