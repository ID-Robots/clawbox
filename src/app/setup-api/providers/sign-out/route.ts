export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { providerAuthStartResponse, runningProviderAuthTask, startProviderSignOutTask } from "@/lib/provider-auth-tasks";
import {
  resolveSignOutTarget,
  signOutOfProvider,
  signOutRefusal,
  type ProviderSignOutRefusal,
} from "@/lib/provider-sign-out";

/** Each refusal's status: the owner's to fix (409), the box's (500/502), or no such row (404). */
const REFUSAL_STATUS: Record<ProviderSignOutRefusal, number> = {
  unknown_provider: 404,
  is_default: 409,
  default_unknown: 409,
  sign_in_in_progress: 409,
  still_signed_in: 500,
  restart_refused: 502,
};

/**
 * "Sign out of <Provider>" — Settings → AI, any connected provider's row.
 *
 * POST { provider: string } (the row's id) → 202 { taskId, started, task }:
 * the sign-out runs as a BACKGROUND TASK of the box (TASK-2148,
 * src/lib/provider-auth-tasks.ts), not as this request — closing Settings
 * half-way loses neither the work nor the view of it. The task removes every
 * copy of the credential and reads that back (src/lib/provider-sign-out.ts),
 * waits out the restart that drops it, and ends `succeeded` with the old
 * answer's `{ signedOut: true, provider, changed }` as its result, or `failed`
 * with the refusal's sentence and `kind`. Settings and the desktop's corner
 * card follow it at /setup-api/background-jobs/tasks. Asked again for the
 * same provider while it runs, the running task is answered (`started:
 * false`); a different provider change running is 409
 * `provider_change_running`.
 *
 * Refusals the box can tell at once are answered here, before any task, with
 * `kind`:
 * - 403 `owner_only`: OWNER ONLY. Middleware admits every /setup-api/* call
 *   on the MCP bearer, and the agent holds that bearer; signing the box out of
 *   an AI provider is the owner's, the same rule as providers/enabled.
 * - 404 `unknown_provider`: no cloud provider by that id (an on-device engine
 *   has no sign-in; it is turned off in Settings → Local AI).
 * - 409 `is_default`: the chat runs on it — make another provider the default
 *   first. ClawBox AI is the exception, as in #1369.
 * - 409 `default_unknown`: the box could not read which provider is the
 *   default, or none is set (Hermes on `auto`), so it did not risk signing the
 *   chat out from under itself.
 * - 409 `sign_in_in_progress`: a ClawBox AI device login is writing its token.
 *
 * Asked again under the change lock inside the task, these end it `failed`
 * with the same `kind`; so do the two only the work itself can find:
 * - `still_signed_in`: something of the credential is still on the box, or a
 *   store could not be read to say it is gone.
 * - `restart_refused`: signed out on disk, but the harness could not be
 *   restarted to let go of the sign-in it is running with.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Signing out of an AI provider needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const fields = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { provider?: unknown })
    : {};
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  if (!provider) {
    return NextResponse.json({ error: "Invalid body. Expected { provider: string }." }, { status: 400 });
  }

  const target = await resolveSignOutTarget(provider);
  if (!target.ok) {
    return NextResponse.json({ error: target.error, kind: target.kind }, { status: REFUSAL_STATUS[target.kind] });
  }
  // A provider change already running is answered by the start below — the
  // same sign-out followed again, or any other refused as busy — never by a
  // refusal read while that change is half-way.
  const refusal = runningProviderAuthTask() ? null : await signOutRefusal(target);
  if (refusal) {
    return NextResponse.json({ error: refusal.error, kind: refusal.kind }, { status: REFUSAL_STATUS[refusal.kind] });
  }
  return providerAuthStartResponse(startProviderSignOutTask({
    provider: target.row,
    label: target.label,
    harness: target.harness,
    signOut: signOutOfProvider,
  }));
}
