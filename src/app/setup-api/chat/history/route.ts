import { NextRequest, NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { UNKNOWN_FACTS, capabilitiesFor } from "@/lib/harness/capabilities";
import { clearTranscript, readTranscript, type TranscriptRecord } from "@/lib/harness/transcript-store";
import { DESKTOP_TRANSCRIPT_KEY, transcriptKeyIsSafe } from "@/lib/harness/transcript-key";

export const dynamic = "force-dynamic";

// ── The durable chat transcript ────────────────────────────────────────────
//
// What the chat shows after a refresh, for a harness whose transport does not
// remember the conversation on our behalf.
//
// It is deliberately NOT "the history route for both editions". OpenClaw HAS a
// transcript — the gateway holds it and answers `chat.history` over the socket
// the browser already has open — and proxying that through here would mean the
// server opening a second WebSocket to relay a read the client can make
// directly, for no gain and with the whole OpenClaw chat path as the blast
// radius. The abstraction that makes the two editions one is
// `HarnessAdapter.loadHistory()`, which the component calls without knowing
// which of the two answered. This route is one of that method's two
// implementations, not a replacement for it.
//
// So a GET here on a box whose transport owns its transcript is a caller
// asking the wrong store, and it is told so rather than handed an empty list
// it would render as "no history" over a conversation that plainly exists.
//
// Session-gated by middleware, which lists /setup-api/chat among the surfaces
// that stay closed even during the pre-setup AP window.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Whether THIS box keeps its transcript here.
 *
 * Asked as a capability rather than as `harness === "hermes"`, so the day a
 * third harness arrives — or the day the gateway stops holding history — this
 * route needs no edit. `hasLiveConnection` is the honest question: a harness
 * with a live transport has something to ask; one without has only this file.
 *
 * Facts do not matter to it (no capability that depends on a credential is read
 * here), so the cautious defaults are enough and this stays a cheap call.
 */
async function transcriptLivesHere(): Promise<boolean> {
  const harness = await getActiveHarness();
  return !capabilitiesFor(harness, UNKNOWN_FACTS).hasLiveConnection;
}

// The same refusal chat/model makes about the chat's model, and it carries the
// same `code`: two routes that say "you are asking the wrong store" must be one
// thing a caller can switch on, not two shapes to string-match.
const WRONG_STORE = {
  error: "This box's chat transcript is held by its agent gateway, not on disk. Ask the gateway.",
  code: "wrong_store",
} as const;

const BAD_KEY = { error: "Invalid session key" } as const;

/**
 * Which conversation: the desktop thread unless the caller names one of the
 * tabs opened beside it. A key that is not a bare filename is refused before
 * it can become one — see `transcriptKeyIsSafe`. Null means refused.
 */
function sessionKeyOf(req: NextRequest): string | null {
  const raw = req.nextUrl.searchParams.get("sessionKey");
  if (!raw) return DESKTOP_TRANSCRIPT_KEY;
  return transcriptKeyIsSafe(raw) ? raw : null;
}

/** One stored record as the chat surface's own message shape. */
function toMessage(record: TranscriptRecord) {
  return {
    role: record.role,
    text: record.text,
    timestamp: record.timestamp,
    ...(record.media?.length ? { images: record.media } : {}),
    ...(record.audio?.length ? { audio: record.audio } : {}),
    // Carried under their own names so a REPLAYED turn collapses its thinking
    // and shows its steps exactly as the live one did. Without this a refresh
    // would quietly downgrade every past answer to a bare bubble.
    ...(record.reasoning ? { reasoning: record.reasoning } : {}),
    ...(record.toolCalls?.length ? { toolCalls: record.toolCalls } : {}),
    // Which model answered, so the bubble can say so. Same names on both
    // sides; only a reply that recorded them carries them.
    ...(record.model ? { model: record.model } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.turnId ? { idempotencyKey: record.turnId } : {}),
    ...(record.variant ? { variant: record.variant } : {}),
  };
}

// GET /setup-api/chat/history?limit=50[&sessionKey=…] → { messages }
// Oldest first, newest last — the order the transcript renders in.
export async function GET(req: NextRequest) {
  if (!(await transcriptLivesHere())) {
    return NextResponse.json(WRONG_STORE, { status: 409 });
  }
  const key = sessionKeyOf(req);
  if (!key) return NextResponse.json(BAD_KEY, { status: 400 });
  const raw = Number(req.nextUrl.searchParams.get("limit"));
  // A missing or nonsensical limit is the default, not a 400: the caller asked
  // for the conversation, and there is a right answer to give them.
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  const records = await readTranscript(limit, key);
  return NextResponse.json({ messages: records.map(toMessage) });
}

// DELETE /setup-api/chat/history[?sessionKey=…] → { ok: true }
//
// The half of "restart" (and of closing a tab) that makes forgetting real. The
// adapter also drops the resumed session id, which is what makes the AGENT
// forget; without this the screen would refill with the previous conversation
// on the next refresh while the agent had no idea what any of it referred to.
export async function DELETE(req: NextRequest) {
  if (!(await transcriptLivesHere())) {
    return NextResponse.json(WRONG_STORE, { status: 409 });
  }
  const key = sessionKeyOf(req);
  if (!key) return NextResponse.json(BAD_KEY, { status: 400 });
  try {
    await clearTranscript(key);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not clear the transcript" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
