import { NextResponse } from "next/server";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  CodingAgentError,
  getCodingAgentStatus,
  httpStatusForCodingError,
  MAX_DIRECTORY_CHARS,
  setCodingAgentEnabled,
  setDefaultDirectory,
  setEffort,
  setMaxTurns,
  setReviewPass,
  setTokenLimit,
} from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * The one refusal this route has: no owner browser session, no change.
 *
 * OWNER ONLY — the one thing in this subtree the agent must never be able to
 * do to itself. Middleware admits every /setup-api/* call on the MCP bearer,
 * and the agent holds that bearer; a route that trusted middleware here (or
 * requireSession, which also accepts the bearer) would let a prompt-injected
 * agent switch on its own delegated shell. Same rule and same helper as
 * email/pending: a real browser session or a 403, identical for "no
 * credential" and "valid bearer" alike.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Changing the coding agent switch needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

/**
 * Change one coding-agent setting, then answer with the whole status.
 *
 * POST { enabled: boolean } → flip the owner's switch.
 * POST { defaultDirectory: string | null } → set (or clear) the folder a run
 * works in when the assistant names neither a project nor a directory.
 * POST { effort: "low"|"medium"|"high"|"xhigh"|"max" } → how hard a run thinks.
 * POST { maxTurns: number } → how many steps a run gets.
 * POST { tokenLimit: number | null } → token ceiling, or null for none.
 * Either way the answer is the same payload as GET
 * /setup-api/coding-agent/status, re-read after the change.
 *
 * Owner-only; see `forbidden` for why middleware is not trusted here.
 *
 * The switch branch does one thing the others do not: it tells the RUNNING
 * agent. The coding_agent_* tools are registered behind a probe the MCP server
 * takes once at boot, so a flip that only reaches the browser leaves the panel
 * claiming "ready" over an agent that still cannot start a run — see
 * `refreshCodingAgentToolsIfReadinessChanged`.
 *
 * @param request the owner's browser request, JSON body as above
 * @returns 200 with the re-read status, 400 on a body this route cannot read,
 *          or 403 without an owner session
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  // A JSON body may legally be a string, a number or a boolean, and `in`
  // throws a TypeError on those — which surfaced as a 500 where the caller
  // should have been told 400. Measured: `"a string"`, `42` and `true` all
  // returned 500 before this guard.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = body as {
    enabled?: unknown;
    defaultDirectory?: unknown;
    effort?: unknown;
    maxTurns?: unknown;
    tokenLimit?: unknown;
    reviewPass?: unknown;
  };
  const hasEnabled = typeof fields.enabled === "boolean";
  const hasReviewPass = typeof fields.reviewPass === "boolean";
  const hasEffort = typeof fields.effort === "string";
  const hasTurns = typeof fields.maxTurns === "number";
  // null is meaningful — it CLEARS the ceiling — so presence decides.
  const hasTokens = "tokenLimit" in fields
    && (typeof fields.tokenLimit === "number" || fields.tokenLimit === null);
  // `null` is meaningful here — it CLEARS the default — so presence is what
  // decides whether this request is about the folder, not truthiness.
  const hasDirectory = "defaultDirectory" in fields
    && (typeof fields.defaultDirectory === "string" || fields.defaultDirectory === null);
  if (!hasEnabled && !hasDirectory && !hasEffort && !hasTurns && !hasTokens && !hasReviewPass) {
    return NextResponse.json(
      {
        error:
          "Invalid body. Expected { enabled: boolean }, { defaultDirectory: string | null }, "
          + "{ effort: string }, { maxTurns: number } "
          + "{ tokenLimit: number | null } or { reviewPass: boolean }.",
      },
      { status: 400 },
    );
  }
  if (typeof fields.defaultDirectory === "string" && fields.defaultDirectory.length > MAX_DIRECTORY_CHARS) {
    return NextResponse.json({ error: "The folder path is too long.", kind: "invalid" }, { status: 400 });
  }

  try {
    // The family's availability BEFORE the write, read only on requests that
    // can actually move it. `ready` — not the raw switch — because `ready` is
    // the fact `probeCodingAgent` reads to decide whether the coding_agent_*
    // tools exist at all, and it is the field this route already answers with.
    //
    // It is a SECOND status read on the switch branch, deliberately, rather than
    // deriving the old verdict from the new one: `ready` is `enabled AND the
    // harness is installed AND ClawBox AI is connected`, and only the first of
    // those three is this request's to know. The reads are a handful of stat()s
    // and one readdir, on the one branch that flips a switch — and null here
    // means "this request cannot move the family", which is every other setting
    // the route carries.
    const readyBefore = hasEnabled ? (await getCodingAgentStatus()).ready : null;
    if (hasDirectory) {
      const saved = await setDefaultDirectory(fields.defaultDirectory as string | null);
      console.error(`[coding-agent] default folder ${saved ? "set" : "cleared"} by the owner`);
    }
    if (hasEffort) {
      const saved = await setEffort(fields.effort as string);
      console.error(`[coding-agent] effort set to ${saved} by the owner`);
    }
    if (hasTurns) {
      const saved = await setMaxTurns(fields.maxTurns);
      console.error(`[coding-agent] step limit set to ${saved} by the owner`);
    }
    if (hasReviewPass) {
      const saved = await setReviewPass(fields.reviewPass);
      console.error(`[coding-agent] review pass switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasTokens) {
      const saved = await setTokenLimit(fields.tokenLimit as number | null);
      console.error(`[coding-agent] token limit ${saved === null ? "cleared" : `set to ${saved}`} by the owner`);
    }
    if (hasEnabled) {
      await setCodingAgentEnabled(fields.enabled as boolean);
      console.error(`[coding-agent] switched ${fields.enabled ? "on" : "off"} by the owner`);
    }
    const status = await getCodingAgentStatus();
    // Tell the RUNNING agent, not just the browser. The coding_agent_* tools are
    // registered behind a probe the MCP server takes ONCE while it boots, and
    // that server is a long-lived stdio child — so without this the panel says
    // "ready" while the agent still has no way to start a run. Same shape and
    // same mechanism as #486 (email) and #503 (images); see the helper for the
    // rule about when a reload is worth its cost.
    //
    // AWAITED, and it cannot fail the save: the helper swallows everything and
    // returns void, so the worst case is a logged line and a tool list that
    // catches up at the next restart. A floating promise here would outlive the
    // response with nothing watching it.
    if (readyBefore !== null) {
      await refreshCodingAgentToolsIfReadinessChanged(readyBefore, status.ready);
    }
    return NextResponse.json(status);
  } catch (err) {
    // The folder rules answer in the owner's words ("that folder holds
    // credentials…"); pass them through as a 400 rather than a 500, because
    // the request was understood and refused, not broken. (The setters throw
    // only invalid/not_found, so the shared table answers 400/404 here.)
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change the coding agent setting" },
      { status: 500 },
    );
  }
}
