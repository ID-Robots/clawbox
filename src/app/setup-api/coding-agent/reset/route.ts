import { NextResponse } from "next/server";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { hasOwnerSession } from "@/lib/owner-session";
import { getCodingAgentStatus, resetCodingAgentSetup } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * Put the coding agent back to factory and return the owner to the setup
 * wizard: switch off, no default folder, effort/ceilings/review at defaults,
 * the wizard flag cleared.
 *
 * OWNER ONLY, and for the same reason as `enable`: middleware admits the MCP
 * bearer on every /setup-api route and the agent holds it. Reset switches the
 * agent OFF, so the bearer could only use this to disable itself — but the
 * wizard it returns to is the consent screen for a delegated shell, and
 * nothing running inside that shell gets to re-open its own onboarding.
 *
 * Clears the finished run history and its evidence folders as well: a
 * "start over" that left last week's runs listed under a freshly-configured
 * agent was not starting over. Held runs (live, paused, drafted) stay.
 *
 * What it does NOT clear: the GitHub login — a credential against another
 * service, with its own two-tap Sign out in Settings.
 *
 * @returns 200 with the re-read status, or 403 without an owner session.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Resetting the coding agent needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  try {
    // Read BEFORE the clear so the agent's tool list is refreshed only when the
    // reset actually took the family offline — same rule as the enable route.
    const readyBefore = (await getCodingAgentStatus()).ready;
    const clearedRuns = await resetCodingAgentSetup();
    console.error(`[coding-agent] settings reset by the owner; ${clearedRuns} finished run(s) cleared, the setup wizard will run again`);
    const status = await getCodingAgentStatus();
    await refreshCodingAgentToolsIfReadinessChanged(readyBefore, status.ready);
    return NextResponse.json({ ...status, clearedRuns });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reset the coding agent" },
      { status: 500 },
    );
  }
}
