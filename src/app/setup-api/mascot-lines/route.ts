import { NextResponse } from "next/server";
import { kvGet } from "@/lib/kv-store";

export const dynamic = "force-dynamic";

// Must match MASCOT_LINES_KEY in ChatPopup.tsx
const KV_KEY = "clawbox-mascot-convo-lines";

/**
 * GET /setup-api/mascot-lines
 * Returns conversation-based mascot speech lines collected from chat.
 * The ChatPopup saves snippets to KV as conversations happen.
 */
export async function GET() {
  const raw = kvGet(KV_KEY);
  if (!raw) return NextResponse.json({ lines: [] });
  try {
    const data = JSON.parse(raw) as { lines: string[]; date: string };
    return NextResponse.json({ lines: data.lines || [], date: data.date });
  } catch {
    return NextResponse.json({ lines: [] });
  }
}
