export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  checkScheduledJobs,
  readJobAlertsStatus,
  setJobAlertsEnabled,
  type JobAlertsStatus,
} from "@/lib/job-alerts";
import { hasOwnerSession } from "@/lib/owner-session";

/**
 * The scheduled-job alerts (src/lib/job-alerts.ts): the owner's switch and
 * what the last check found — the card in Settings → Harness.
 *
 * OWNER ONLY, both verbs. The answer carries the scheduler's own error text
 * for each failing job, which can quote a command's output; and the switch
 * decides whether the box tells the owner that one of the assistant's jobs
 * died, which the assistant must not be able to turn off for itself.
 *
 * GET checks again when the last check is older than {@link FRESH_MS}, so the
 * card opened right after a fix shows the fix. That check is the timer's own
 * (joined if one is running) and sends what it would have sent anyway.
 */

const FRESH_MS = 30_000;

const NO_STORE = { "Cache-Control": "no-store" };

function ownerOnly() {
  return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
}

async function freshStatus(): Promise<JobAlertsStatus> {
  const last = await readJobAlertsStatus();
  if (!last.enabled || Date.now() - last.checkedAt < FRESH_MS) return last;
  try {
    return await checkScheduledJobs();
  } catch (err) {
    console.warn("[job-alerts] check from Settings failed:", err instanceof Error ? err.message : err);
    return last;
  }
}

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) return ownerOnly();
  return NextResponse.json(await freshStatus(), { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) return ownerOnly();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const enabled = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { enabled?: unknown }).enabled
    : undefined;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  try {
    await setJobAlertsEnabled(enabled);
  } catch {
    return NextResponse.json({ ok: false, code: "write_failed" }, { status: 502 });
  }
  // Switched on: check at once, so the card says what is wrong now rather than
  // in two minutes. Switched off (or held off by the environment): the switch
  // is answered as it now stands.
  let status = await readJobAlertsStatus();
  if (status.enabled) {
    try {
      status = await checkScheduledJobs();
    } catch {
      // The switch is on; the next timer check will say the rest.
    }
  }
  return NextResponse.json({ ok: true, ...status }, { headers: NO_STORE });
}
