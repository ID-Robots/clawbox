import { NextRequest, NextResponse } from "next/server";

import {
  computeNextMemoryRunMs,
  readMemorySchedule,
  writeMemorySchedule,
} from "@/lib/clawkeep-memory";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  const schedule = await readMemorySchedule();
  return NextResponse.json(
    { schedule, nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  try {
    const schedule = await writeMemorySchedule(body);
    // Re-arm immediately. Without this the saved schedule would not take
    // effect until the next reboot, which is exactly the kind of silent
    // half-applied setting this panel exists to expose.
    await refreshMemoryScheduler();
    return NextResponse.json(
      { schedule, nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "The schedule could not be saved. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
