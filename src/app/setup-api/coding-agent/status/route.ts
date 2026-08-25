import { NextResponse } from "next/server";
import { getCodingAgentStatus } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * GET → the coding agent's state: the owner's switch, whether the harness
 * (Claude Code + claude-ds + ClawBox AI) is ready, and how many runs are busy.
 *
 * Readable with the MCP bearer on purpose: mcp/lib/context.ts probes it at
 * startup to decide whether the coding_agent_* tools are registered at all
 * (a tool that could only ever answer 409 is a tool that trips Hermes' circuit
 * breaker). The Settings panel reads the same payload. Nothing here is a
 * secret, and nothing here changes anything.
 */
export async function GET() {
  try {
    return NextResponse.json(await getCodingAgentStatus());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 },
    );
  }
}
