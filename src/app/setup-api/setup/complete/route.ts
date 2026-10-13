export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { setMany } from "@/lib/config-store";
import { getSessionSigningSecret, createSessionCookie, getSessionGeneration } from "@/lib/auth";
import { requireSession } from "@/lib/route-auth";
import { applyDeferredLanguagePersona, retireOnboardingRitual } from "@/lib/language-persona";

export async function POST(request: Request) {
  // Second line of defence, the same one setup/reset carries. Middleware's
  // bootstrap allow-list (src/lib/setup-api-gate.ts) already keeps this route
  // shut to an anonymous caller — but a handler that mints a 24 h owner
  // session on the strength of that list alone falls open the day the list is
  // loosened or a path reaches it around the matcher. `allowBootstrap` stays
  // false on purpose: a box with no owner must never be marked complete, and
  // the wizard always holds the cookie CredentialsStep minted by the time it
  // posts here. `requireSession` (not `hasOwnerSession`) because it honours
  // CLAWBOX_TEST_MODE, which the e2e-install harness — driving the wizard with
  // no cookie jar, and later posting here to harvest a fresh session — relies on.
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    const timestamp = new Date().toISOString();
    await setMany({
      setup_complete: true,
      setup_completed_at: timestamp,
      setup_progress_step: undefined,
    });

    // A set-up box answers its first chat message normally (TASK-1528): end
    // the first-conversation ritual the gateway armed at first boot, then pay
    // the persona the language the wizard's picker had to defer for it. Both
    // never throw, and both are repeated by the heartbeat and the gateway's
    // ExecStartPre, so a failure here costs minutes, not the setup.
    await retireOnboardingRitual();
    await applyDeferredLanguagePersona();

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
