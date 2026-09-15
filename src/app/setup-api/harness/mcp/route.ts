export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { applyClawboxMcpSwitch, readClawboxMcpRegistration } from "@/lib/clawbox-mcp-registration";
import { CLAWBOX_MCP_ENABLED_KEY, readClawboxMcpEnabled } from "@/lib/clawbox-mcp-switch";
import { set } from "@/lib/config-store";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/harness/mcp — the owner's on/off switch for the ClawBox MCP
 * server, the assistant's device tools (Settings → Harness, owner's request
 * 2026-09-15).
 *
 * GET answers `{ enabled, registered: { openclaw, hermes } }`: the switch as
 * the store holds it, and whether each harness's config lists the server RIGHT
 * NOW (null = that harness is not on this edition, or its config could not be
 * read). Readable by anything the middleware admits — there is nothing in it
 * the agent should not know about itself.
 *
 * POST `{ enabled }` is OWNER ONLY, both halves, exactly as `harness/swap`:
 * the middleware admits the MCP bearer everywhere under /setup-api, and a tool
 * that could switch itself back on would make the owner's "off" temporary;
 * a cross-site page riding the owner's cookie is refused for the same reason
 * every other state-changing owner route refuses it. The key is written FIRST
 * — the two boot scripts honour it, so even a harness that cannot be told now
 * follows the switch at its next start — and then every harness this edition
 * runs is unregistered or re-registered and restarted
 * (`src/lib/clawbox-mcp-registration.ts`). The answer is the re-read GET shape
 * plus `applied`; a half that failed makes it a 502 carrying the same state
 * beside `{ error, code }`, because the switch IS saved and the panel must draw
 * that rather than the state it started from.
 */

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

async function state() {
  const [enabled, registered] = await Promise.all([readClawboxMcpEnabled(), readClawboxMcpRegistration()]);
  return { enabled, registered };
}

export async function GET() {
  return NextResponse.json(await state(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return refuse(403, "owner_only", "Switching the assistant's device tools needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The assistant's device tools can only be switched from this ClawBox's own pages.");
  }

  let enabled: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { enabled?: unknown }).enabled
      : undefined;
    if (typeof candidate !== "boolean") {
      return refuse(400, "bad_body", "enabled must be true or false.");
    }
    enabled = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  try {
    await set(CLAWBOX_MCP_ENABLED_KEY, enabled);
  } catch (err) {
    // A store that cannot be read is not written over (`config-store.set`
    // throws rather than replacing it with the one key), and nothing on the
    // harnesses is touched either: the boot scripts read the same store, and a
    // removal they would put back at the next boot is not a switch.
    console.error("[harness/mcp] the switch could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }

  const applied = await applyClawboxMcpSwitch(enabled);
  const current = await state();
  if (applied.error) {
    return NextResponse.json(
      { ...current, applied: { openclaw: applied.openclaw, hermes: applied.hermes }, error: applied.error.message, code: applied.error.code },
      { status: 502 },
    );
  }
  return NextResponse.json({ ...current, applied: { openclaw: applied.openclaw, hermes: applied.hermes } });
}
