import { getActiveHarness } from "@/lib/harness";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";

/**
 * Ask Hermes to rebuild its MCP tool list, for every caller that needs to.
 *
 * WHY THERE IS A CALLER AT ALL. The ClawBox MCP server probes what this device
 * can do ONCE, while it boots (`mcp/lib/context.ts`), and registers or withholds
 * whole tool families on the answer — the mailbox read tools, the coding-agent
 * family, the honest-refusal `image_generate`. It is then a long-lived stdio
 * child of the agent, so a setting the owner changes underneath it never reaches
 * the tool list until something respawns the server.
 *
 * The mechanism is Hermes' own: its dashboard JSON-RPC socket accepts
 * `reload.mcp`, and with `confirm: true` and NO `session_id` it runs
 * `shutdown_mcp_servers()` + `discover_mcp_tools()` globally — the ClawBox server
 * starts again and re-probes, and live sessions pick the new list up at their
 * next turn boundary via Hermes' own between-turns refresh.
 *
 * IT IS NOT FREE, which is why this is a plain call and not something a caller
 * fires on every save: the reload kills and respawns every MCP child process and
 * invalidates the model's prompt cache, so the next turn re-sends and re-pays for
 * a system prompt that was cached. Each caller owns the rule for WHEN that is
 * worth it, and each says so where it decides.
 */

/**
 * Hermes' own confirmation flag. Passing it is what makes the call act rather
 * than ask: `reload.mcp` is gated by `approvals.mcp_reload_confirm`, which
 * defaults to true, and without this the dashboard answers
 * `{ status: "confirm_required" }` and does nothing.
 */
const RELOAD_PARAMS = { confirm: true } as const;

/**
 * True when Hermes agreed to reload, false when it could not be asked.
 *
 * Never throws, and deliberately does not distinguish between the ways "no"
 * happens — no dashboard, a socket that died, an error frame. A caller that
 * cannot fix any of those does not benefit from telling them apart; what it
 * does with the false is say so in its own words.
 */
export async function reloadMcpServers(): Promise<boolean> {
  const result = await dashboardRpc("reload.mcp", RELOAD_PARAMS).catch(() => null);
  return result !== null;
}

/**
 * Say that a wanted reload did not happen — in the words that are TRUE for THIS
 * box, which is not the same sentence on both editions.
 *
 * Every family this module serves is registered on BOTH editions (the mailbox
 * read tools, the coding-agent family, the honest-refusal `image_generate`), but
 * the only mechanism here is HERMES' dashboard JSON-RPC. An OpenClaw box has no
 * dashboard by design, so `reloadMcpServers()` can never return true there — and
 * nothing is broken when it does not: OpenClaw spawns the ClawBox MCP server
 * lazily per session and reaps it after ten idle minutes, so the probe re-runs
 * and the tool list catches up on its own. Reporting that as an ERROR is the
 * recurring false-alarm shape — a repair announced over an operation that in
 * fact succeeded — and it costs a real one: an operator who learns to skip these
 * lines skips the Hermes box that genuinely refused.
 *
 * So `console.error` is kept for exactly the case a human can act on: a box that
 * HAS a dashboard and it said no. Everything else is a `console.log` that says
 * what will actually happen next.
 *
 * UNKNOWN IS NOT OPENCLAW. `getActiveHarness()` swallows its own read failures
 * and answers `openclaw` by default, but if the call itself throws we keep the
 * error — a harness lookup that fell over must not be the thing that quiets a
 * real Hermes failure.
 *
 * @param tag   the caller's log prefix, e.g. `coding-agent/mcp-refresh`
 * @param what  what changed, in the caller's own words, e.g. "the coding agent
 *              became available"
 */
export async function reportMcpReloadRefused(tag: string, what: string): Promise<void> {
  const harness = await getActiveHarness().catch(() => null);
  if (harness !== null && harness !== "hermes") {
    console.log(
      `[${tag}] ${what}; this edition has no dashboard to ask — the tool list re-probes `
        + "when the MCP server is next spawned",
    );
    return;
  }
  console.error(`[${tag}] ${what}, but the agent would not reload its MCP servers`);
}
