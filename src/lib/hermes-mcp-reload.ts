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
