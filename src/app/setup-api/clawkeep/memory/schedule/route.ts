import { NextRequest, NextResponse } from "next/server";

import {
  computeNextMemoryRunMs,
  readMemorySchedule,
  writeMemorySchedule,
} from "@/lib/clawkeep-memory";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import { memoryShardWriter, scheduledFullPassRefusal } from "@/lib/memory-shard-writer";

export const dynamic = "force-dynamic";

export async function GET() {
  const schedule = await readMemorySchedule();
  return NextResponse.json(
    { schedule, nextRunAtMs: computeNextMemoryRunMs(schedule, new Date()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  // A signed-in person or the box's assistant (`memoryShardWriter`), nobody
  // else: the schedule decides when the box spends an hour re-embedding. The
  // passes it starts are incremental — the same pass the assistant may start
  // by hand — except on an index with nothing in it yet, where the first
  // scheduled pass builds it in full: arming THAT from the assistant waits for
  // `confirm: true`, as a full pass by hand does (409 `confirm_required`).
  const writer = await memoryShardWriter(request, "Changing the index schedule");
  if (!writer.ok) return writer.response;
  const body = await request.json().catch(() => ({}));
  try {
    const arms = writer.by === "assistant" && (body as { enabled?: unknown } | null)?.enabled === true && (await getMemoryShardEnabled());
    if (arms) {
      const refused = await scheduledFullPassRefusal(writer.by, body);
      if (refused) return refused;
    }
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
