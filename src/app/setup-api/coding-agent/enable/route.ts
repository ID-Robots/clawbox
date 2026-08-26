import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  CodingAgentError,
  getCodingAgentStatus,
  MAX_DIRECTORY_CHARS,
  setCodingAgentEnabled,
  setDefaultDirectory,
  setEffort,
  setMaxTurns,
  setTokenLimit,
} from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * POST { enabled: boolean } → flip the owner's switch.
 * POST { defaultDirectory: string | null } → set (or clear) the folder a run
 * works in when the assistant names neither a project nor a directory.
 * POST { effort: "low"|"medium"|"high"|"xhigh"|"max" } → how hard a run thinks.
 * POST { maxTurns: number } → how many steps a run gets.
 * POST { tokenLimit: number | null } → token ceiling, or null for none.
 * Either way the answer is the same payload as GET
 * /setup-api/coding-agent/status, re-read after the change.
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

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = (body ?? {}) as {
    enabled?: unknown;
    defaultDirectory?: unknown;
    effort?: unknown;
    maxTurns?: unknown;
    tokenLimit?: unknown;
  };
  const hasEnabled = typeof fields.enabled === "boolean";
  const hasEffort = typeof fields.effort === "string";
  const hasTurns = typeof fields.maxTurns === "number";
  // null is meaningful — it CLEARS the ceiling — so presence decides.
  const hasTokens = "tokenLimit" in fields
    && (typeof fields.tokenLimit === "number" || fields.tokenLimit === null);
  // `null` is meaningful here — it CLEARS the default — so presence is what
  // decides whether this request is about the folder, not truthiness.
  const hasDirectory = "defaultDirectory" in fields
    && (typeof fields.defaultDirectory === "string" || fields.defaultDirectory === null);
  if (!hasEnabled && !hasDirectory && !hasEffort && !hasTurns && !hasTokens) {
    return NextResponse.json(
      {
        error:
          "Invalid body. Expected { enabled: boolean }, { defaultDirectory: string | null }, "
          + "{ effort: string }, { maxTurns: number } "
          + "or { tokenLimit: number | null }.",
      },
      { status: 400 },
    );
  }
  if (typeof fields.defaultDirectory === "string" && fields.defaultDirectory.length > MAX_DIRECTORY_CHARS) {
    return NextResponse.json({ error: "The folder path is too long.", kind: "invalid" }, { status: 400 });
  }

  try {
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
    if (hasTokens) {
      const saved = await setTokenLimit(fields.tokenLimit as number | null);
      console.error(`[coding-agent] token limit ${saved === null ? "cleared" : `set to ${saved}`} by the owner`);
    }
    if (hasEnabled) {
      await setCodingAgentEnabled(fields.enabled as boolean);
      console.error(`[coding-agent] switched ${fields.enabled ? "on" : "off"} by the owner`);
    }
    return NextResponse.json(await getCodingAgentStatus());
  } catch (err) {
    // The folder rules answer in the owner's words ("that folder holds
    // credentials…"); pass them through as a 400 rather than a 500, because
    // the request was understood and refused, not broken.
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: err.kind === "not_found" ? 404 : 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change the coding agent setting" },
      { status: 500 },
    );
  }
}
