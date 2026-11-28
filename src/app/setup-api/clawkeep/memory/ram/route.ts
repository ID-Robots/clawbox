import { NextResponse } from "next/server";
import { memoryShardWriter } from "@/lib/memory-shard-writer";
import { readIndexInRam, setIndexInRam } from "@/lib/memory-shard-ram";

export const dynamic = "force-dynamic";

/**
 * "Keep the Memory Shard index in RAM" (`src/lib/memory-shard-ram.ts`), off
 * by default.
 *
 * GET → `{ on, bytes, files, availableBytes, stopped }`: the switch, the index
 * files' total size (what it holds while on), MemAvailable, and why the box
 * switched it off by itself when it did.
 *
 * POST `{ on: boolean }` → the new state. Switching on is refused 409
 * `too_big` (the index files are more than half of the memory available now)
 * or `memory_unknown`, with the state and nothing written. A signed-in person
 * or the box's assistant (`memoryShardWriter`), like the switch beside it.
 */
export async function GET() {
  return NextResponse.json(await readIndexInRam(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const writer = await memoryShardWriter(request, "Changing whether the memory index is kept in RAM");
  if (!writer.ok) return writer.response;
  let body: { on?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body?.on !== "boolean") return NextResponse.json({ error: "Expected { on: boolean }." }, { status: 400 });
  const r = await setIndexInRam(body.on);
  if (!r.ok) {
    const error = r.refusal === "too_big"
      ? "The index is more than half of the memory available now, so it is not kept in RAM."
      : "This box's available memory could not be measured, so the index is not kept in RAM.";
    return NextResponse.json({ error, code: r.refusal, ...r.state }, { status: 409 });
  }
  console.error(`[memory-shard] index in RAM switched ${body.on ? "on" : "off"} by the ${writer.by}`);
  return NextResponse.json(r.state);
}
