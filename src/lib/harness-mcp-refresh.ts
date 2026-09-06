import { reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";

/**
 * Ask the agent to rebuild its tool list when the ACTIVE HARNESS moved under it.
 *
 * WHY THIS EXISTS — the fifth of five, and the biggest of them. The ClawBox MCP
 * server probes this device ONCE, while its stdio child boots
 * (`mcp/lib/context.ts` / `mcp/lib/edition.ts`), and the answer decides more
 * than any other snapshot in that file: on the `dual` SKU it settles which
 * harness's built-in APPS `ui_open_app` and `ui_list_apps` offer, which TOOL SET
 * is registered at all (`resolveEdition` — the skills family on Hermes, the app
 * store on OpenClaw), what `device_status` calls the agent, and which field
 * guide `clawbox_context` serves.
 *
 * `/setup-api/harness/select` deliberately does not bounce the other gateway, so
 * nothing told that child anything. The owner switched to Hermes in Settings and
 * `ui_open_app("hermes")` went on answering "There is no such app on this
 * ClawBox" for the box's own dashboard — TASK-541's exact symptom — while
 * `clawbox app open hermes` from the same agent's shell succeeded, because a CLI
 * run IS its own startup. It cleared at the next MCP restart, and nothing on the
 * box caused one (TASK-715).
 *
 * THE MECHANISM IS THE HARNESS'S OWN, not a poll bolted onto the two handlers
 * whose answer happens to be visible. `reload.mcp` respawns the child and
 * re-probes EVERYTHING, so the app list, the registered tool set, the tool
 * descriptions and the orientation answers move together — a per-call re-read
 * of the app list alone would leave one surface fresh and the rest of the
 * session stale, which is the harder bug to see: `ui_list_apps` would name
 * `hermes-skills` in the same session where `skill_list` is not registered and
 * `device_status` still says OpenClaw.
 *
 * IT IS NOT FREE — the reload kills and respawns every MCP child and
 * invalidates the model's prompt cache — so, like all four siblings
 * (`email-mcp-refresh`, `coding-agent-mcp-refresh`, `provider-mcp-refresh`,
 * `hermes-image-refresh`), it is asked for only on a real flip.
 */

/**
 * Reload the MCP servers iff this request actually changed the active harness.
 *
 * Both directions. Switching TO Hermes gives its dashboard the reload directly;
 * switching AWAY leaves an OpenClaw box, where `reportMcpReloadRefused` says the
 * true sentence for that edition — OpenClaw spawns the ClawBox MCP server per
 * session and reaps it after ten idle minutes, so it self-heals and needs no
 * repair.
 *
 * Never throws and never reports to the caller: the selection is PERSISTED by
 * the time this runs, and a best-effort refresh must not turn a switch that
 * succeeded into an error. A box that cannot be asked catches up at the next
 * restart, which is what every box did before this existed.
 *
 * @param before the harness this switch REPLACED, as answered by the write
 * @param after  the harness now active
 * @returns true when the box's MCP children were respawned for this change
 */
export async function refreshHarnessToolsIfSwitched(
  before: string,
  after: string,
): Promise<boolean> {
  // A re-select of the harness already running changes nothing the agent can
  // see, and must cost nothing. `before` comes back from the persist itself, so
  // this compares what was actually replaced — not a value read earlier that
  // another request may have moved in between.
  if (before === after) return false;

  const moved = `the active harness moved from ${before} to ${after}`;
  // `.catch` even though `reloadMcpServers` documents that it never throws: the
  // promise it makes is to the OWNER'S SWITCH, which is already persisted, and
  // it must not depend on a neighbouring module keeping its own.
  if (!(await reloadMcpServers().catch(() => false))) {
    await reportMcpReloadRefused("harness/select", moved);
    return false;
  }
  console.log(`[harness/select] ${moved}; asked the agent to reload its MCP servers`);
  return true;
}
