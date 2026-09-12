import { NextResponse } from "next/server";
import {
  addAllowRule,
  AllowRuleError,
  CodingAgentError,
  getAllowRules,
  getCodingAgentStatus,
  httpStatusForCodingError,
  removeAllowRule,
} from "@/lib/coding-agent";
import { MAX_ALLOW_RULES, MAX_RULE_CHARS } from "@/lib/coding-permission-rules";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * The owner's permission rules: what a delegated run may do beyond what the
 * device ships with.
 *
 * OWNER ONLY, AND SAME ORIGIN. Middleware admits every /setup-api/* call on the
 * MCP bearer and the agent holds that bearer — a rule is a standing widening of
 * what the agent's own delegated shell may do, so this is the same fence
 * `coding-agent/enable` puts around the switch itself, plus the origin check
 * the routes that write the owner's own tree carry (projects/import,
 * projects/desktop). Neither guard is the other's substitute: the cookie is
 * what keeps the agent out, the origin check is what keeps another page on the
 * owner's browser from adding a rule while they read it.
 *
 * GET                      → { allowRules, maxAllowRules }
 * POST   { rule: string }  → save one rule
 * DELETE ?rule=…           → take one back (a JSON body is read too)
 *
 * The two writes answer with the same payload as GET
 * /setup-api/coding-agent/status, re-read after the change: the settings panel
 * and the run page both already render that payload, so a caller shows the
 * box's own answer rather than the list it hoped for. GET answers the two
 * fields alone, for a caller that wants the list and nothing else.
 */
function refuse(status: number, kind: string, error: string, code?: string) {
  return NextResponse.json({ error, kind, ...(code ? { code } : {}) }, { status });
}

/** Owner session, and — for the two writes — this box's own page. */
async function guard(request: Request, write: boolean): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Reading or changing what a coding run may do needs a signed-in browser session.");
  }
  if (write && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "Permission rules can only be changed from this ClawBox's own pages.");
  }
  return null;
}

/** The one place a rule-shaped failure becomes an HTTP answer. */
function failed(err: unknown) {
  // The rule-level code travels beside the HTTP kind: the panel words
  // "already on the list" in the owner's language, an older panel shows the
  // box's own sentence, and both read the same 400.
  if (err instanceof AllowRuleError) {
    return NextResponse.json(
      { error: err.message, kind: err.kind, code: err.code },
      { status: httpStatusForCodingError(err.kind) },
    );
  }
  if (err instanceof CodingAgentError) {
    return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Could not change the permission rules" },
    { status: 500 },
  );
}

/**
 * The rule a request names, as text, from the query or from a JSON body.
 *
 * DELETE carries it in the query — a body on a DELETE is legal but not every
 * client sends one — and POST in the body. Both are read for both, so the one
 * this route cannot see is never the reason a removal fails.
 */
async function ruleFrom(request: Request): Promise<unknown> {
  const fromQuery = new URL(request.url).searchParams.get("rule");
  if (fromQuery !== null) return fromQuery;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  // A JSON body may legally be a string, a number or a boolean, and `in` throws
  // a TypeError on those — the same guard, and the same reason, as enable's.
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as { rule?: unknown }).rule;
}

export async function GET(request: Request) {
  const denied = await guard(request, false);
  if (denied) return denied;
  try {
    return NextResponse.json({ allowRules: await getAllowRules(), maxAllowRules: MAX_ALLOW_RULES });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request) {
  const denied = await guard(request, true);
  if (denied) return denied;
  const rule = await ruleFrom(request);
  if (typeof rule !== "string") {
    return refuse(400, "invalid", 'Invalid body. Expected { rule: string }.', "malformed");
  }
  // Bounded before anything reads it: the validator refuses an over-long rule
  // too, but a body that never becomes a rule should not travel that far.
  if (rule.length > MAX_RULE_CHARS) {
    return refuse(400, "invalid", `A permission rule may be at most ${MAX_RULE_CHARS} characters.`, "too_long");
  }
  try {
    const rules = await addAllowRule(rule);
    console.error(`[coding-agent] permission rule added by the owner (${rules.length} in force)`);
    return NextResponse.json(await getCodingAgentStatus());
  } catch (err) {
    return failed(err);
  }
}

export async function DELETE(request: Request) {
  const denied = await guard(request, true);
  if (denied) return denied;
  const rule = await ruleFrom(request);
  if (typeof rule !== "string") {
    return refuse(400, "invalid", "Name the rule to remove, as ?rule=… or { rule: string }.", "malformed");
  }
  try {
    const rules = await removeAllowRule(rule);
    console.error(`[coding-agent] permission rule removed by the owner (${rules.length} in force)`);
    return NextResponse.json(await getCodingAgentStatus());
  } catch (err) {
    return failed(err);
  }
}
