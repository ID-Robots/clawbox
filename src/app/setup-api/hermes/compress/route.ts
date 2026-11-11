export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { runHermesSlashCommand } from "@/lib/hermes-slash-exec";
import { requireSession } from "@/lib/route-auth";
import { chatPrincipalOf, hermesSessionFor } from "@/lib/chat-scope-server";
import { orgMemberOf } from "@/lib/org-mode-server";
import { staffHermesProfilePaths } from "@/lib/hermes-staff-profile";

/**
 * Shorten a Hermes conversation now — the chat's "Shorten this conversation
 * first" for a long chat on Local AI (TASK-2127; the OpenClaw twin is the
 * gateway's `sessions.compact`).
 *
 * POST `{ sessionId }` → 200 `{ compressed: true, tokensBefore?, tokensAfter? }`,
 * 409 `{ error }` when Hermes compressed nothing (an idle session with nothing
 * to fold, a lock held elsewhere, a summary that would grow, a fold that left
 * the request no smaller), 503 when the dashboard could not be reached.
 *
 * Hermes' own `session.compress` (its manual `/compress` of an idle session),
 * on the session resumed by its stored id; the summary runs on
 * `auxiliary.compression`, which names ClawBox AI while Local AI is on
 * (src/lib/hermes-local-ai.ts). Not `/compress` through the chat's slash path:
 * a board answered that "(no output)" and compressed nothing.
 */
const SESSION_ID = /^(?:[0-9]{8}_[0-9]{6}_[0-9a-f]{6}|local-[0-9a-f]{64})$/;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ error: "Hermes is not this box's runtime." }, { status: 409 });
  }
  let body: { sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!SESSION_ID.test(sessionId)) {
    return NextResponse.json({ error: "A Hermes session id is required." }, { status: 400 });
  }
  // Only the caller's own conversation (src/lib/chat-scope-server.ts): a
  // ClawBox user may not compress the owner's, nor another user's.
  if (hermesSessionFor(await chatPrincipalOf(request), sessionId) !== sessionId) {
    return NextResponse.json({ error: "That conversation belongs to someone else on this ClawBox.", code: "not_your_chat" }, { status: 403 });
  }
  // A member of staff's conversation lives in their own Hermes profile on an
  // organisation box (src/lib/hermes-staff-profile.ts).
  const member = await orgMemberOf(request);
  const profile = member ? staffHermesProfilePaths(member.username)?.profile : undefined;
  if (member && !profile) return NextResponse.json({ error: "Hermes could not be reached." }, { status: 503 });
  const ran = await runHermesSlashCommand({ command: "/compress", sessionId, rpc: "session.compress", signal: request.signal, ...(profile ? { profile } : {}) });
  if (!ran) return NextResponse.json({ error: "Hermes could not be reached." }, { status: 503 });
  const result = ran.result;
  const summary = result?.summary && typeof result.summary === "object" ? result.summary as Record<string, unknown> : null;
  const tokensBefore = count(result?.before_tokens);
  const tokensAfter = count(result?.after_tokens);
  // `status: "compressed"` is how an in-process compression answers (a board's
  // did, with no `compressed` flag); `compressed: true` how a compute host's
  // passes through. "pending", "aborted", a noop or a held lock compressed nothing yet.
  // Hermes also answers "compressed" when its own summary says nothing was
  // removed (`noop`, `refused_would_grow`, `aborted`), and for a fold that left
  // the request no smaller: a board's folded one exchange of seven, ~64.9k →
  // ~66.7k tokens, still far past the local line.
  const removedNothing = summary?.noop === true || summary?.refused_would_grow === true || summary?.aborted === true;
  const noSmaller = tokensBefore !== undefined && tokensAfter !== undefined && tokensAfter >= tokensBefore;
  const compressed = !removedNothing && !noSmaller
    && (result?.compressed === true || (result?.status === "compressed" && result?.compressed !== false));
  if (!result || !compressed) {
    const headline = typeof summary?.headline === "string" ? summary.headline : "";
    const message = typeof result?.message === "string" && result.message
      ? result.message
      : !removedNothing && noSmaller
        ? `The summary left this conversation no shorter (~${tokensBefore} → ~${tokensAfter} tokens).`
        : headline || ran.output;
    return NextResponse.json({ error: message || "Nothing was compressed." }, { status: 409 });
  }
  return NextResponse.json({
    compressed: true,
    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
  });
}
