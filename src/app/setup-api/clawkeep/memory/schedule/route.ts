import { NextRequest, NextResponse } from "next/server";

import {
  computeNextMemoryRunMs,
  readMemorySchedule,
  writeMemorySchedule,
} from "@/lib/clawkeep-memory";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";
import { hasOwnerSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const schedule = await readMemorySchedule();
  return NextResponse.json(
    { schedule, nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  // OWNER ONLY: the schedule decides when the box spends an hour re-embedding.
  // Middleware admits the MCP bearer, so without this the agent could rewrite
  // when — and how often — that happens.
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the index schedule needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
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
