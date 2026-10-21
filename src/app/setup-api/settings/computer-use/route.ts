export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  applyComputerUseSwitch,
  computerUseSupported,
  readStoredComputerUseSwitch,
} from "@/lib/computer-use-apply";
import { set } from "@/lib/config-store";
import { COMPUTER_USE_KEY, computerUseSettingEnabled } from "@/lib/computer-use-switch";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/computer-use — the owner's switch for Hermes' built-in
 * `computer_use` toolset (desktop control). See src/lib/computer-use-switch.ts.
 *
 * DORMANT: both methods answer 404 `setting_off` unless
 * CLAWBOX_COMPUTER_USE_SETTING=1, so with the flag off nothing can write the
 * key and every box behaves as before the switch existed.
 *
 * GET `{ supported, state, enabled }`: `supported` is false on the
 * OpenClaw-only edition (no leg there); `state` is the stored decision —
 * on / off / unmanaged (no decision: Hermes keeps the toolset it ships with) —
 * and `enabled` what that means for the agent.
 *
 * POST `{ enabled }` is OWNER ONLY and same-origin, like the path guard: the
 * agent's MCP bearer must never be able to grant itself the desktop. It saves
 * the key, then applies it at once through register-mcp.sh — the same native
 * `hermes tools enable|disable computer_use`, under the same config lock, that
 * every boot repeats.
 */

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status });
}

function settingOff(): NextResponse {
  return refuse(404, "setting_off", "The computer use setting is not available on this ClawBox.");
}

async function state() {
  const supported = computerUseSupported();
  if (!supported) return { supported, state: null, enabled: false };
  const stored = await readStoredComputerUseSwitch();
  return { supported, state: stored, enabled: stored === null ? null : stored !== "off" };
}

export async function GET() {
  if (!computerUseSettingEnabled()) return settingOff();
  return NextResponse.json(await state(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!computerUseSettingEnabled()) return settingOff();
  if (!(await hasPersonSession(req))) {
    return refuse(403, "owner_only", "Switching computer use needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "Computer use can only be switched from this ClawBox's own pages.");
  }
  if (!computerUseSupported()) {
    return refuse(409, "unsupported", "Computer use is not available on the OpenClaw edition of ClawBox.", { supported: false });
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
    await set(COMPUTER_USE_KEY, enabled);
  } catch (err) {
    console.error("[computer-use] the switch could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }

  const applied = await applyComputerUseSwitch(enabled);
  const body = { ...(await state()), applied: { hermes: applied.applied, gatewayRestarted: applied.gatewayRestarted } };
  if (applied.error) {
    return NextResponse.json({ ...body, error: applied.error, code: "apply_failed" }, { status: 502 });
  }
  return NextResponse.json(body);
}
