import { NextResponse } from "next/server";
import * as configStore from "@/lib/config-store";
import { requireSession } from "@/lib/route-auth";
import { announceTimezoneToAgent } from "@/lib/timezone-agent";
import {
  DEFAULT_TIMEZONE,
  TIMEZONE_SYNCED_KEY,
  TimezoneUnavailableError,
  isValidTimezoneName,
  listTimezones,
  readTimezone,
  setTimezone,
} from "@/lib/timezone";

export const dynamic = "force-dynamic";

/**
 * The system timezone. TASK-514.
 *
 * GET  → the live zone, the box's own wall clock in it, and whether anything
 *        has ever set it. `?zones=1` adds the picker's list.
 * POST { timezone } → apply it, then tell the assistant.
 *
 * Gated with requireSession, like its system/desktop and system/power-profile
 * siblings — cookie or MCP bearer, and NO bootstrap carve-out. The wizard does
 * not call this route (it hands its zone to setup/complete, which is already
 * behind the session the credentials step mints), so there is no first-boot
 * window to hold open, and a box whose clock anyone in radio range of the setup
 * AP could move is a box whose reminders they can move. TASK-443's rule.
 *
 * The bearer is deliberately allowed on POST: "set my timezone to Sofia" is an
 * ordinary thing to ask the assistant, and the zone it can reach is bounded by
 * the same validation the owner's request goes through.
 */
export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  try {
    const status = await readTimezone();
    const synced = (await configStore.get(TIMEZONE_SYNCED_KEY)) === true;
    const body: Record<string, unknown> = {
      ...status,
      /** Still on the systemd default — i.e. nobody has ever been asked. */
      isDefault: status.timezone === DEFAULT_TIMEZONE,
      /**
       * The desktop's one-shot for boxes that were set up before this shipped:
       * true only while the box is on the default zone AND no zone has ever
       * been applied. Writing the marker on the first POST is what keeps it
       * from asking twice — including for an owner who really does want UTC.
       */
      autoSyncPending: status.timezone === DEFAULT_TIMEZONE && !synced,
    };

    const url = new URL(req.url);
    if (url.searchParams.get("zones") === "1") {
      body.zones = await listTimezones();
    }
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof TimezoneUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read the timezone" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const timezone = (body as { timezone?: unknown } | null)?.timezone;
  if (!isValidTimezoneName(timezone)) {
    return NextResponse.json(
      { error: "Invalid body. Expected { timezone: <IANA zone name> }." },
      { status: 400 },
    );
  }

  try {
    // setTimezone() returns the state read back AFTER the change, so what the
    // UI confirms with is the box's own clock rather than an echo of the
    // request. A zone the OS rejects never reaches the lines below.
    const status = await setTimezone(timezone);
    await configStore.set(TIMEZONE_SYNCED_KEY, true);
    const agent = await announceTimezoneToAgent(status.timezone, { restartHarness: true });
    return NextResponse.json({ success: true, ...status, agent });
  } catch (err) {
    if (err instanceof TimezoneUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set the timezone" },
      { status: 500 },
    );
  }
}
