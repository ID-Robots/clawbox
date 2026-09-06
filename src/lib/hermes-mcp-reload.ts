import { getActiveHarness } from "@/lib/harness";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";
import { logSafe } from "@/lib/log-safe";

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
 * Statuses that mean the dashboard CARRIED THE RELOAD OUT.
 *
 * Deliberately generous on synonyms, because the two mistakes cost different
 * things. Calling a real reload a refusal costs one honest log line on a box
 * that is fine. Calling a refusal a reload costs the silence this whole
 * mechanism exists to remove: the tool list stays stale, and the one line that
 * would tell an operator so is the line that says the opposite.
 */
const ACTED_STATUSES = new Set(["ok", "reloaded", "success", "completed", "done"]);

/**
 * True when Hermes agreed to reload, false when it could not be asked OR said no.
 *
 * Never throws, and deliberately does not distinguish between the ways "no"
 * happens — no dashboard, a socket that died, an error frame, a dashboard that
 * wants a human. A caller that cannot fix any of those does not benefit from
 * telling them apart; what it does with the false is say so in its own words.
 *
 * READS THE VERDICT, NOT THE RETURN. `dashboardRpc` maps an error frame to null,
 * so the transport cases were always honest — but `{ status: "confirm_required" }`
 * is a perfectly ordinary non-error reply that means NOTHING HAPPENED (see
 * `RELOAD_PARAMS`), and a `result !== null` test scored it as success. That is
 * the "reported from the fact that a call returned, not from what it returned"
 * shape, in the one helper all four refresh call sites depend on.
 *
 * A reply that names NO status stays a success: that is the historical reading,
 * and only a frame that names a state is allowed to contradict it — a dashboard
 * that answers `{}` must not start reporting a refusal that never happened.
 */
export async function reloadMcpServers(): Promise<boolean> {
  const result = await dashboardRpc("reload.mcp", RELOAD_PARAMS).catch(() => null);
  if (result === null || result === undefined) return false;
  const status = (result as { status?: unknown }).status;
  if (typeof status !== "string") return true;
  return ACTED_STATUSES.has(status.trim().toLowerCase());
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
  // BOUND THE RECORD, whoever the caller is. Six families share these two
  // lines and one of them (`provider-mcp-refresh`) builds `what` by joining a
  // provider list whose length nothing here decides, so one value stays one
  // line and one caller does not decide how much gets written. It is not a
  // barrier CodeQL recognises and is not offered as one — the values that
  // reach the journal are rebuilt at their own source (see
  // `harness-mcp-refresh.ts`); this is the record's own rule.
  const line = `[${logSafe(tag, 60)}] ${logSafe(what)}`;
  const harness = await getActiveHarness().catch(() => null);
  if (harness !== null && harness !== "hermes") {
    console.log(
      `${line}; this edition has no dashboard to ask — the tool list re-probes `
        + "when the MCP server is next spawned",
    );
    return;
  }
  console.error(`${line}, but the agent would not reload its MCP servers`);
}
