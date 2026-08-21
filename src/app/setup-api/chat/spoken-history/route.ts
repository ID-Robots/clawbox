import { NextResponse } from "next/server";
import { loadSpokenHistory } from "@/lib/chat-spoken-history";

export const dynamic = "force-dynamic";

// GET /setup-api/chat/spoken-history
//
// Session-gated by middleware. Returns only the timestamp-to-player mapping
// needed to repair older gateways' chat.history projection; never transcript
// text or session ids. This route is deliberately tied
// to the mascot's canonical main session so no session identifier appears in a
// browser URL or request body.
export async function GET() {
  try {
    const items = await loadSpokenHistory("agent:main:main");
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    // A missing/corrupt transcript must not take the whole chat history down.
    // Log the detail only on the device; the browser needs no filesystem hint.
    console.warn("[chat/spoken-history] could not read transcript:", err);
    return NextResponse.json(
      { items: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
