import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { syncChatTabs } from "@/lib/chat-tab-store";
import { isChatTabKey, MAX_CLOSED, MAX_TABS, parseActivity, parseTabList } from "@/lib/chat-tabs";

export const dynamic = "force-dynamic";

// ── The chat's tab inventory ───────────────────────────────────────────────
//
// Which side conversations the owner has open beside the main one, as ONE list
// for every browser signed in to this box (TASK-1159: a tab opened on the phone
// never reached the desktop, because the list lived in each browser's
// localStorage). The rules — what a change may do, why a closed key stays
// closed — are in `chat-tabs.ts`; the disk and the discovery of conversations
// the list never heard of are in `chat-tab-store.ts`.
//
// GET  /setup-api/chat/tabs                                    → { tabs, active }
// POST /setup-api/chat/tabs { upsert?: [], close?: [], activity? } → { tabs, active }
//
// A POST carries what the device holds, not an edit script: its whole cached
// list and the keys it closed. The merge is monotonic, so a device can send
// that on every sync without knowing what the box already has.
//
// `active` is the conversation the owner last sent a turn in, on any device —
// `{ key, at }`, key null for the main one, `at` the box's clock — or null
// before one has been recorded (TASK-1364). A device opening the chat opens
// that one, so a conversation started on the desktop is the one the phone
// lands in. `activity: { key }` on a POST is how a device reports a turn.
//
// Session-gated by middleware like the rest of /setup-api/chat, and checked
// again here. A WRITE also has to come from the owner's own browser: the MCP
// bearer the agent holds opens /setup-api, and a prompt-injected agent that
// could add tabs to the owner's strip could put words in it the owner never
// said, or close a conversation out of sight — and, like every owner write, it
// has to come from this box's own page (`isSameOriginRequest`). Reading needs
// no more than the session: the agent already reads these conversations whole.

/** A request larger than this is not a strip anyone has. */
const MAX_BODY_BYTES = 64 * 1024;

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await syncChatTabs());
  } catch (err) {
    console.warn("[chat-tabs] could not read the tab list:", err);
    return NextResponse.json({ error: "Could not read the chat tabs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  if (!(await hasOwnerSession(req)) || !isSameOriginRequest(req)) {
    return NextResponse.json(
      { error: "Chat tabs can only be changed from the owner's own session", code: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Too many tabs in one request" }, { status: 413 });
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected an object" }, { status: 400 });
  }
  const { upsert, close } = body as { upsert?: unknown; close?: unknown };
  if ((upsert !== undefined && !Array.isArray(upsert)) || (close !== undefined && !Array.isArray(close))) {
    return NextResponse.json({ error: "upsert and close must be lists" }, { status: 400 });
  }
  // Main (null) or a key the strip could hold — never a channel's, a cron
  // job's or a coding run's session, which no device opens from the strip.
  const activity = parseActivity((body as { activity?: unknown }).activity);
  if (activity === false) {
    return NextResponse.json({ error: "activity must be { key } naming main (null) or a chat tab" }, { status: 400 });
  }

  try {
    const synced = await syncChatTabs({
      // Anything that is not a tab this strip could have made is dropped
      // here, before it can reach the file, and no request adds more than the
      // strip may hold (the merge caps the total the same way).
      upsert: parseTabList(upsert).slice(0, MAX_TABS),
      close: (close ?? []).filter(isChatTabKey).slice(0, MAX_CLOSED),
      ...(activity ? { activity } : {}),
    });
    return NextResponse.json(synced);
  } catch (err) {
    console.warn("[chat-tabs] could not save the tab list:", err);
    return NextResponse.json({ error: "Could not save the chat tabs" }, { status: 500 });
  }
}
