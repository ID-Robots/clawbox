export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  AGENT_SANDBOX_BUDGET,
  AGENT_SANDBOX_ENABLED_KEY,
  agentSandboxAvailable,
  agentSandboxProvisioning,
  applyAgentSandboxSwitch,
  readAgentSandboxMode,
  readAgentSandboxRuntime,
  readAgentSandboxSwitch,
} from "@/lib/agent-sandbox";
import { set } from "@/lib/config-store";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/agent-sandbox — the owner's switch for the agent tool
 * sandbox (OpenClaw's agents.defaults.sandbox, rootless Podman).
 *
 * GET `{ available, enabled, known, mode, runtime, provisioning, budget }`:
 * whether this edition has an OpenClaw to sandbox, the switch as stored (OFF
 * unless exactly true; `known: false` = the store could not be read), the mode
 * OpenClaw's config holds now, and, while the switch is on, whether the
 * runtime is ready and its install running. `budget` is the cap the posture
 * holds the sandbox to.
 *
 * POST `{ enabled }` is OWNER ONLY and same-origin, like path-guard: the
 * sandbox fences the agent in, so the MCP bearer the middleware admits must
 * never be able to switch it off from a chat.
 */

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

async function state() {
  const available = agentSandboxAvailable();
  const [{ enabled, known }, mode] = await Promise.all([readAgentSandboxSwitch(), readAgentSandboxMode()]);
  // Podman and systemd are only asked while the switch is on: a box that
  // never uses the sandbox spawns nothing when its Settings open.
  const [runtime, provisioning] = available && enabled
    ? await Promise.all([readAgentSandboxRuntime(), agentSandboxProvisioning()])
    : [null, null];
  return { available, enabled, known, mode, runtime, provisioning, budget: AGENT_SANDBOX_BUDGET };
}

export async function GET() {
  return NextResponse.json(await state(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await hasPersonSession(req))) {
    return refuse(403, "owner_only", "Switching the agent tool sandbox needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The agent tool sandbox can only be switched from this ClawBox's own pages.");
  }
  if (!agentSandboxAvailable()) {
    return refuse(409, "not_openclaw", "The agent tool sandbox is an OpenClaw setting, and this ClawBox runs Hermes.");
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
    await set(AGENT_SANDBOX_ENABLED_KEY, enabled);
  } catch (err) {
    console.error("[agent-sandbox] the switch could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }

  const applied = await applyAgentSandboxSwitch(enabled);
  const current = await state();
  // The install this call started may not show as running yet when it is
  // read back; the answer says what was started, not only what was seen.
  if (applied.provisioning && current.provisioning !== true) current.provisioning = true;
  const body = { ...current, applied: { openclaw: applied.openclaw, provisioning: applied.provisioning } };
  if (applied.error) {
    return NextResponse.json({ ...body, error: applied.error, code: "apply_failed" }, { status: 502 });
  }
  return NextResponse.json(body);
}
