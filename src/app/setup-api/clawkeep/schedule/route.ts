import { NextRequest, NextResponse } from "next/server";

import { computeNextRunMs, readSchedule, readScheduleArmedAtMs, writeSchedule } from "@/lib/clawkeep";
import { refresh as refreshScheduler } from "@/lib/clawkeep-scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const schedule = await readSchedule();
    return NextResponse.json(
      {
        schedule,
        nextRunAtMs: computeNextRunMs(schedule, new Date()),
        scheduleArmedAtMs: await readScheduleArmedAtMs(),
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
    const schedule = await writeSchedule(body);
    await refreshScheduler();
    // Hand back the arm stamp with the schedule: the card folds both into its
    // local status, so arming auto-backup cannot lapse the shield on the same
    // click for a run that has not come round yet — and so a save that armed
    // nothing cannot un-lapse it either.
    return NextResponse.json(
      {
        schedule,
        nextRunAtMs: computeNextRunMs(schedule, new Date()),
        scheduleArmedAtMs: await readScheduleArmedAtMs(),
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
