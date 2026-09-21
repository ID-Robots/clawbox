import { NextRequest, NextResponse } from "next/server";

import { hasOwnerSession } from "@/lib/owner-session";
import { startMemoryIndex } from "@/lib/clawkeep-memory";
import { getMemoryShardEnabled } from "@/lib/memory-shard";

export const dynamic = "force-dynamic";

/**
 * Start one indexing pass.
 *
 * `mode: "full"` forces a full reindex, which is what the customer needs after
 * the embedding model changes; anything else is incremental. A run that is
 * declined because one is already going answers 409 rather than pretending to
 * have started a second one — single-flight lives in `startMemoryIndex`, and
 * this route must not paper over its answer.
 *
 * OWNER ONLY. Middleware admits the MCP bearer on every /setup-api route and
 * the agent holds it, so until this check existed the assistant could start a
 * full reindex of the owner's memory on its own — an expensive, hours-long pass
 * that re-embeds everything. Reading the status stays open; starting work does
 * not.
 */
/**
 * The owner's switch is off. 409 rather than 403, because nothing is wrong
 * with WHO asked — the box is simply not indexing at the moment, and the app
 * says so with `kind`. Written once because two places answer it now: before
 * the work, and again for the switch startMemoryIndex read inside its lock.
 */
function switchedOff() {
  return NextResponse.json(
    { error: "Memory Shard is switched off. Switch it on in its settings to index.", kind: "disabled" },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Starting an index run needs a signed-in browser session.", kind: "owner_only" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  // The owner's switch, not a preference: switching Memory Shard off has to
  // stop the passes ClawBox starts, or "off" is a word on a screen. The
  // scheduler disarms itself for the same reason; this is the by-hand half.
  // Cheap and early so a switched-off box is refused before the CLI probe;
  // startMemoryIndex reads the same switch inside its lock, which is where the
  // decision is actually made.
  if (!(await getMemoryShardEnabled())) return switchedOff();
  const body = await request.json().catch(() => ({}));
  // `request.json()` resolves a literal `null` body to null, which the cast
  // does not change — reading `.mode` off it threw and the outer catch turned
  // that into a 500.
  const requested = (body as { mode?: unknown } | null)?.mode === "full" ? "full" : "incremental";
  try {
    // The mode asked for, not a resolved one: on a box with no index yet an
    // incremental pass cannot succeed, and startMemoryIndex settles that
    // AFTER declining a caller that overlaps a run — resolving it here first
    // made that caller wait on the CLI probe and then start a second run.
    // The run reports the mode it actually used.
    const { accepted, run, declined } = await startMemoryIndex(requested, "manual");
    // The switch again, as startMemoryIndex saw it from inside its own lock —
    // the reading above is only the fast, well-worded refusal. Between the two
    // sits a probe that can take a minute on a cold box, and an owner who
    // switched the feature off in that minute must be told that, not that a
    // run they cannot see is already going.
    if (declined === "disabled") return switchedOff();
    // The run state only. The panel adopts it at once and refetches the status
    // straight after this resolves anyway.
    return NextResponse.json(
      { accepted, run },
      { status: accepted ? 200 : 409, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Deliberately a fixed string: the underlying failure can carry a path or
    // a provider error, and neither belongs in front of a customer.
    return NextResponse.json(
      { error: "Indexing could not be started. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
