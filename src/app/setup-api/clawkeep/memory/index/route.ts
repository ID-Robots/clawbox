import { NextRequest, NextResponse } from "next/server";

import { getMemoryStatus, resolveIndexMode, startMemoryIndex, stopMemoryIndex } from "@/lib/clawkeep-memory";
import { estimateFullReindex } from "@/lib/memory-reindex-advice";
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import { confirmed, confirmRequired, memoryShardWriter } from "@/lib/memory-shard-writer";

export const dynamic = "force-dynamic";

/**
 * Start one indexing pass (POST), or stop the running one (DELETE).
 *
 * `mode: "full"` forces a full reindex, which is what the customer needs after
 * the embedding model changes; anything else is incremental. A run that is
 * declined because one is already going answers 409 rather than pretending to
 * have started a second one — single-flight lives in `startMemoryIndex`, and
 * this route must not paper over its answer.
 *
 * WHO: a signed-in person or the box's assistant (`memoryShardWriter`);
 * anything else is refused 403 `owner_only`. The assistant starts an
 * incremental pass on its own — it reads only what changed — but a FULL pass
 * re-embeds every file and can take hours, so from the assistant it needs
 * `confirm: true`, which the tool sets only once the owner said yes. Without it
 * the answer is 409 `confirm_required` with what the pass would cost. That
 * includes an incremental pass the box would run in full anyway (no index yet,
 * or one built for another embedder): the gate is on the pass that RUNS, not
 * on the word asked for.
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
  const writer = await memoryShardWriter(request, "Starting an index run");
  if (!writer.ok) return writer.response;
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
    if (!confirmed(writer.by, body)) {
      // Only the assistant gets here. The mode the box would actually run: an
      // incremental pass over an index that is missing or disowned is a full
      // one (see planIndexPass), and the assistant must not start one by
      // asking for the other.
      const runs = requested === "full" ? "full" : await resolveIndexMode("incremental", "manual");
      if (runs === "full") {
        const status = await getMemoryStatus();
        return confirmRequired(
          requested === "full"
            ? "A full reindex embeds every file again. Ask the owner first; nothing was started."
            : "This index can only be rebuilt in full right now, which embeds every file again. Ask the owner first; nothing was started.",
          {
            mode: "full",
            requested,
            reasons: status.reindex?.reasons ?? [],
            estimate: estimateFullReindex(status, status.location === "cloud" ? "cloud" : "local", status.model || undefined),
          },
        );
      }
    }
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
    if (accepted) console.error(`[memory-shard] ${run.mode || requested} index pass started by the ${writer.by}`);
    // The run state only. The panel adopts it at once and refetches the status
    // straight after this resolves anyway.
    return NextResponse.json(
      { accepted, run, ...(declined ? { kind: declined } : {}) },
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

/**
 * Stop the running pass. What it indexed stays indexed; the next incremental
 * pass carries on from there. 409 `not_running` when there is nothing to stop.
 * No confirm: stopping costs nothing and undoes nothing.
 */
export async function DELETE(request: NextRequest) {
  const writer = await memoryShardWriter(request, "Stopping an index run");
  if (!writer.ok) return writer.response;
  try {
    const { stopped, run } = await stopMemoryIndex();
    if (!stopped) {
      return NextResponse.json(
        { error: "No indexing pass is running.", kind: "not_running", run },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error(`[memory-shard] index pass stopped by the ${writer.by}`);
    return NextResponse.json({ stopped: true, run }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "The indexing pass could not be stopped. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
