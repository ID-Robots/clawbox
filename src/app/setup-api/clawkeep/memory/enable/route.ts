import { NextResponse } from "next/server";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";
import { hasOwnerSession } from "@/lib/owner-session";
import { bodyWouldEnable } from "@/lib/paid-plan-gate";
import { readPlanGate, refusePaidPlan } from "@/lib/paid-plan-gate-server";
import {
  getMemoryShardEnabled,
  getMemoryShardSetupComplete,
  setMemoryShardEnabled,
  setMemoryShardSetupComplete,
} from "@/lib/memory-shard";

export const dynamic = "force-dynamic";

/**
 * The owner's switch for Memory Shard, and the wizard's completion flag.
 *
 * OWNER ONLY. Middleware admits the MCP bearer on every /setup-api route and
 * the agent holds it, so a route that trusted middleware here would let the
 * assistant switch on the indexing of the owner's own documents. Same helper
 * and same rule as coding-agent/enable.
 *
 * POST { enabled?: boolean, setupComplete?: boolean } → the new state.
 *
 * Switching it ON, or marking the wizard finished, also needs a paid ClawBox
 * AI plan (Pro or Max) — 402 `paid_plan_required` otherwise. See
 * @/lib/paid-plan-gate for why the other writes stay open.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the memory index switch needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: { enabled?: unknown; setupComplete?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const hasEnabled = typeof body.enabled === "boolean";
  const hasSetup = typeof body.setupComplete === "boolean";
  if (!hasEnabled && !hasSetup) {
    return NextResponse.json(
      { error: "Expected { enabled: boolean } or { setupComplete: boolean }." },
      { status: 400 },
    );
  }

  // The paid-plan gate, before either flag is written. Owner's decision,
  // 2026-09-14: Memory Shard is a Pro-or-Max feature.
  //
  // Only a body that would switch it ON or finish the wizard is refused. A box
  // already indexing when its subscription lapsed keeps its index and its
  // folders — nothing here auto-disables the owner's own data — and can still
  // be switched OFF, which a blanket refusal would have taken away.
  if (bodyWouldEnable(body)) {
    const gate = await readPlanGate();
    if (!gate.satisfied) return refusePaidPlan("memory_shard", gate);
  }

  if (hasEnabled) {
    await setMemoryShardEnabled(body.enabled as boolean);
    console.error(`[memory-shard] switched ${body.enabled ? "on" : "off"} by the owner`);
    // The switch means nothing until the timer follows it. Off disarms the
    // armed slot here and now — a switch that only took effect at the next
    // reboot would let the box spend tonight embedding after the owner
    // switched it off — and on re-arms the schedule they already saved,
    // which is what the wizard relies on when it enables after its PUT.
    await refreshMemoryScheduler();
  }
  if (hasSetup) {
    await setMemoryShardSetupComplete(body.setupComplete as boolean);
  }

  return NextResponse.json({
    enabled: await getMemoryShardEnabled(),
    setupComplete: await getMemoryShardSetupComplete(),
    // Re-read beside the two flags so a panel that only ever sees this answer
    // (the embedded settings page writes and renders from it) can draw the
    // "needs Pro or Max" line without a second request.
    planGate: await readPlanGate(),
  });
}
