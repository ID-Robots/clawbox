import { NextRequest, NextResponse } from "next/server";

import { computeNextRunMs, readScheduleSnapshot, writeSchedule } from "@/lib/clawkeep";
import { refresh as refreshScheduler } from "@/lib/clawkeep-scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // One read for both halves — the card folds the pair into its local status
    // and `deriveProtection` reads the window from one and the anchor from the
    // other, so they must come from the same version of the file.
    const { schedule, armedAtMs } = await readScheduleSnapshot();
    return NextResponse.json(
      {
        schedule,
        nextRunAtMs: computeNextRunMs(schedule, new Date()),
        scheduleArmedAtMs: armedAtMs,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read schedule" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  try {
    const { schedule, armedAtMs } = await writeSchedule(body);
    // The schedule the write returned, not a re-read of the file it just
    // renamed: a transient read failure on this path would leave the OLD
    // cadence armed under a 200, so a box would go on backing up after the
    // owner switched auto-backup off.
    await refreshScheduler(schedule);
    // Hand back the arm stamp the write itself produced: the card folds both
    // into its local status, so arming auto-backup cannot lapse the shield on
    // the same click for a run that has not come round yet — and a save that
    // armed nothing cannot un-lapse it either.
    return NextResponse.json(
      {
        schedule,
        nextRunAtMs: computeNextRunMs(schedule, new Date()),
        scheduleArmedAtMs: armedAtMs,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update schedule" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
