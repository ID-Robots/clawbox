import { NextResponse } from "next/server";
import { loadSpokenHistory } from "@/lib/chat-spoken-history";
import { mainChatKeyFor } from "@/lib/chat-scope";
import { chatPrincipalOf } from "@/lib/chat-scope-server";

export const dynamic = "force-dynamic";

// GET /setup-api/chat/spoken-history
//
// Session-gated by middleware. Returns only the timestamp-to-player mapping
// needed to repair older gateways' chat.history projection; never transcript
// text or session ids. This route is deliberately tied
// to the mascot's canonical main session so no session identifier appears in a
// browser URL or request body. Every ClawBox user has their own main chat
// (src/lib/chat-scope.ts), so the session read is the CALLER's: the owner's
// canonical main, or that user's own main key — never the owner's for a user.
export async function GET(request: Request) {
  try {
    const items = await loadSpokenHistory(mainChatKeyFor(await chatPrincipalOf(request), "agent:main:main"));
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
