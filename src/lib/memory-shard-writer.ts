// "Who is changing Memory Shard?" — the gate every write under
// /setup-api/clawkeep/memory/* keeps.
//
// Middleware admits a caller to /setup-api/* on EITHER a session cookie OR the
// MCP bearer, so a route that wants to know WHO is asking has to look again.
// Until the assistant had Memory Shard tools these routes asked one question —
// a signed-in person, `hasPersonSession` — and refused the bearer 403
// `owner_only`. The owner's ask since: everything they can do in
// the Memory Shard app, the assistant can do too. So the routes now admit two
// credentials and tell them apart, the way the Prime Radiant routes do
// (`writerGuard` in src/lib/prime-radiant/route-helpers.ts):
//
//   - a signed-in person's browser cookie (the owner's or any ClawBox user's),
//     whose click IS the decision; and
//   - the box's MCP bearer, checked here again rather than taken from
//     middleware, because only the bearer makes the caller the assistant.
//
// Anything else — no credential, a wrong bearer, a revoked cookie — is still
// refused 403 `owner_only`. The difference between the two callers is what
// the routes do with it: the expensive and destructive writes (a full
// re-embed, a provider change that forces one, the reset) answer the
// ASSISTANT an estimate and wait for `confirm: true`, which the tool sets only
// once the owner said yes in chat. The person's own click needs no second ask.

import { NextResponse } from "next/server";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { hasPersonSession } from "@/lib/owner-session";

/** The person at the desktop, or the assistant through the box's MCP server. */
export type MemoryShardWriter = "owner" | "assistant";

export type MemoryShardWriterCheck =
  | { ok: true; by: MemoryShardWriter }
  | { ok: false; response: NextResponse };

/**
 * Admit a signed-in person or the MCP bearer; refuse anything else 403
 * `owner_only`. `what` names the change in the refusal, e.g. "Starting an
 * index run". Never throws: both checks answer false rather than throw.
 */
export async function memoryShardWriter(request: Request, what: string): Promise<MemoryShardWriterCheck> {
  if (await hasPersonSession(request)) return { ok: true, by: "owner" };
  if (verifyMcpBearer(request.headers.get("authorization"))) return { ok: true, by: "assistant" };
  return {
    ok: false,
    response: NextResponse.json(
      { error: `${what} needs a signed-in browser session or the box's assistant.`, kind: "owner_only" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    ),
  };
}

/**
 * The assistant's go-ahead for a write that costs hours or deletes something:
 * the request body's `confirm` is literally `true`. A person's click needs
 * none — the button is the decision.
 */
export function confirmed(by: MemoryShardWriter, body: unknown): boolean {
  if (by === "owner") return true;
  return !!body && typeof body === "object" && (body as { confirm?: unknown }).confirm === true;
}

/**
 * The answer to an assistant's expensive write that came without
 * `confirm: true`: 409 `confirm_required`, nothing done, and what the write
 * WOULD cost so the assistant can put it to the owner.
 */
export function confirmRequired(error: string, details: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { error, kind: "confirm_required", ...details },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}
