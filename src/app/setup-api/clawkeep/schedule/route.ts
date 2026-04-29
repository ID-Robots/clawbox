import { NextRequest, NextResponse } from "next/server";

import { computeNextRunMs, readSchedule, writeSchedule } from "@/lib/clawkeep";
import { refresh as refreshScheduler } from "@/lib/clawkeep-scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const schedule = await readSchedule();
    return NextResponse.json(
      { schedule, nextRunAtMs: computeNextRunMs(schedule, new Date()) },
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
    return NextResponse.json(
      { schedule, nextRunAtMs: computeNextRunMs(schedule, new Date()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update schedule" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
