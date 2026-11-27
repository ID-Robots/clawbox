export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  checkScheduledJobs,
  isRecipientPick,
  readJobAlertRecipients,
  readJobAlertsStatus,
  saveJobAlertSettings,
  type JobAlertRecipients,
  type JobAlertsStatus,
} from "@/lib/job-alerts";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * The scheduled-job alerts (src/lib/job-alerts.ts): the owner's switch, who is
 * told on Telegram, and what the last check found — the card in Settings →
 * Harness.
 *
 * OWNER ONLY, both verbs. The answer carries the scheduler's own error text
 * for each failing job, which can quote a command's output, and the bot's
 * approved users; the switch decides whether the box tells the owner that one
 * of the assistant's jobs died, and the pick decides who else hears about it —
 * neither is the assistant's to change for itself.
 *
 * GET checks again when the last check is older than {@link FRESH_MS}, so the
 * card opened right after a fix shows the fix. That check is the timer's own
 * (joined if one is running) and sends what it would have sent anyway.
 *
 * POST takes `{ enabled?: boolean, recipients?: string[] | null }`, at least
 * one of the two. `recipients` is the owner's pick of the bot's approved users
 * by Telegram id; null forgets it, back to the default (the first five).
 */

const FRESH_MS = 30_000;

const NO_STORE = { "Cache-Control": "no-store" };

function ownerOnly() {
  return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
}

function badRequest() {
  return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
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

/**
 * The card's "Telegram recipients", or null when they cannot be listed — the
 * card then leaves that part out rather than drawing an empty pick.
 */
async function recipients(): Promise<JobAlertRecipients | null> {
  try {
    return await readJobAlertRecipients();
  } catch (err) {
    console.warn("[job-alerts] the Telegram recipients could not be listed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) return ownerOnly();
  const status = await freshStatus();
  return NextResponse.json({ ...status, recipients: await recipients() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  if (!(await hasOwnerSession(req))) return ownerOnly();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest();
  const fields = body as { enabled?: unknown; recipients?: unknown };
  const hasEnabled = Object.hasOwn(fields, "enabled");
  const hasRecipients = Object.hasOwn(fields, "recipients");
  if (!hasEnabled && !hasRecipients) return badRequest();
  if (hasEnabled && typeof fields.enabled !== "boolean") return badRequest();
  if (hasRecipients && !isRecipientPick(fields.recipients)) return badRequest();
  try {
    // One write for both halves: never a 502 with one of them kept.
    await saveJobAlertSettings({
      ...(hasEnabled ? { enabled: fields.enabled as boolean } : {}),
      ...(hasRecipients ? { recipients: fields.recipients as string[] | null } : {}),
    });
  } catch {
    return NextResponse.json({ ok: false, code: "write_failed" }, { status: 502 });
  }
  // Switched on: check at once, so the card says what is wrong now rather than
  // in two minutes. Switched off (or held off by the environment), or only the
  // pick changed: the card is answered as it now stands.
  let status = await readJobAlertsStatus();
  if (fields.enabled === true && status.enabled) {
    try {
      status = await checkScheduledJobs();
    } catch {
      // The switch is on; the next timer check will say the rest.
    }
  }
  return NextResponse.json({ ok: true, ...status, recipients: await recipients() }, { headers: NO_STORE });
}
