export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readFailureKind, set } from "@/lib/config-store";
import { hasPersonSession } from "@/lib/owner-session";
import {
  PATH_GUARD_ENABLED_KEY,
  applyPathGuardSwitch,
  readPathGuardEnabled,
  readPathGuardLoaded,
} from "@/lib/path-guard-switch";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/path-guard — the owner's switch for the protected-path
 * guard (TASK-1661).
 *
 * GET `{ enabled, loaded }`: the switch as stored, and whether OpenClaw's
 * config enables the plugin right now (null = no OpenClaw here / unreadable).
 *
 * POST `{ enabled }` is OWNER ONLY and same-origin, like harness/mcp: the guard
 * protects the box FROM the agent, so the MCP bearer the middleware admits must
 * never be able to switch it off from a chat.
 */

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

async function state() {
  const [enabled, loaded] = await Promise.all([readPathGuardEnabled(), readPathGuardLoaded()]);
  return { enabled, loaded };
}

export async function GET() {
  return NextResponse.json(await state(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasPersonSession(req))) {
    return refuse(403, "owner_only", "Switching the ClawBox file protection needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The ClawBox file protection can only be switched from this ClawBox's own pages.");
  }

  let enabled: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { enabled?: unknown }).enabled
      : undefined;
    if (typeof candidate !== "boolean") return refuse(400, "bad_body", "enabled must be true or false.");
    enabled = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  try {
    await set(PATH_GUARD_ENABLED_KEY, enabled);
  } catch (err) {
    // The kind only, never the message: see readFailureKind.
    console.error("[path-guard] the switch could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }

  const applied = await applyPathGuardSwitch(enabled);
  const current = await state();
  const body = { ...current, applied: { openclaw: applied.openclaw, hermes: applied.hermes } };
  if (applied.error) {
    return NextResponse.json({ ...body, error: applied.error, code: "apply_failed" }, { status: 502 });
  }
  return NextResponse.json(body);
}
