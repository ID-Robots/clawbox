export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { providerAuthStartResponse, runningProviderAuthTask, startProviderSignOutTask } from "@/lib/provider-auth-tasks";
import { CLAWAI_ROW, resolveSignOutTarget, signOutOfProvider, signOutRefusal } from "@/lib/provider-sign-out";

/**
 * "Sign out of ClawBox AI" — the ClawBox AI row's sign-out as PR #1369 shipped
 * it, kept for anything that already calls it. Settings → AI now signs every
 * row out through POST /setup-api/providers/sign-out, and this is that same
 * call for ClawBox AI (src/lib/provider-sign-out.ts), on either harness.
 *
 * POST → 202 { taskId, started, task }: the sign-out runs as a background
 * task of the box (TASK-2148), exactly as providers/sign-out starts it, and
 * ends with `{ signedOut: true, changed }` as its result once the box holds no
 * ClawBox AI credential and no record of the account behind it — or `failed`
 * with the refusal's sentence and `kind` (`still_signed_in`,
 * `restart_refused`). 409 `provider_change_running` while another provider
 * change runs.
 *
 * Refusals answered before any task, with `kind`:
 * - 403 `owner_only`: OWNER ONLY, the rule of providers/enabled.
 * - 409 `sign_in_in_progress`: a device login is writing its token right now.
 * - 409 `is_default` / `default_unknown`, on Hermes only: ClawBox AI is the
 *   chat's default there (or Hermes picks its own), the rule of every other
 *   provider's sign-out (src/lib/provider-sign-out.ts).
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Signing out of ClawBox AI needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const target = await resolveSignOutTarget(CLAWAI_ROW);
  if (!target.ok) return NextResponse.json({ error: target.error, kind: target.kind }, { status: 404 });
  const refusal = runningProviderAuthTask() ? null : await signOutRefusal(target);
  if (refusal) return NextResponse.json({ error: refusal.error, kind: refusal.kind }, { status: 409 });
  return providerAuthStartResponse(startProviderSignOutTask({
    provider: target.row,
    label: target.label,
    harness: target.harness,
    signOut: signOutOfProvider,
  }));
}
