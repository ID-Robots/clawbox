import { reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";

/**
 * Ask the agent to rebuild its MCP tool list when the coding agent becomes
 * usable, or stops being.
 *
 * WHY THIS EXISTS. Three tools — `coding_agent_run`, `coding_agent_status` and
 * `coding_agent_stop` — are registered CONDITIONALLY by the ClawBox MCP server
 * (mcp/tools/coding-agent.ts): the server asks
 * `/setup-api/coding-agent/status` while it boots (mcp/lib/context.ts
 * `probeCodingAgent`) and, when the answer is no, `registerCodingAgentTools`
 * returns without declaring any of them. That is not caution about the switch —
 * the routes refuse the call anyway. It is the same circuit-breaker rule the
 * email read tools are held to: a tool that can only ever answer 409 keeps
 * failing, the agent's per-server breaker opens, and it takes EVERY ClawBox tool
 * offline with it, not just these three.
 *
 * The bug it fixes is that the probe happens ONCE, at server startup, and the
 * server is a long-lived stdio child of the agent. When the owner flips the
 * switch on, `/setup-api/coding-agent/enable` writes the setting and hands the
 * browser a freshly-read status that says "ready" — and nothing tells the
 * running agent, so it still has no way to start the run the panel is now
 * advertising, until something unrelated respawns the server. It is the third
 * instance of one shape: #486 fixed it for `email_list`/`email_read` and #503
 * for the image tools, and this was the call site left out.
 *
 * The mechanism is the agent's own `reload.mcp`, shared with both siblings — see
 * `hermes-mcp-reload.ts`. What belongs HERE is the rule for when it is worth
 * paying for, below.
 */

/** @see refreshCodingAgentToolsIfReadinessChanged */
export interface CodingAgentRefreshOptions {
  /**
   * True when something else in THIS request already respawned the box's MCP
   * children — the image reconciler on the ClawBox AI connect path, which
   * reloads or bounces for its own family and takes every other family's tool
   * list with it. The reload is global, so a second one would buy nothing and
   * cost a second prompt-cache invalidation.
   */
  alreadyReloaded?: boolean;
}

/**
 * Reload the MCP servers, but ONLY if this request flipped whether the coding
 * agent family would be registered at all.
 *
 * The guard is the important half. A reload kills and respawns every MCP child
 * process and invalidates the model's prompt cache, so the next turn on this box
 * re-sends and re-pays for a system prompt that was cached — it is not free, and
 * the route this hangs off also carries the effort, step-limit, token-ceiling
 * and default-folder settings. None of those change WHICH tools exist, and
 * neither does the switch itself on a box whose harness is not installed: there
 * `ready` stays false either way, and the owner must not be charged for a
 * reload that would register nothing.
 *
 * The verdict compared is `CodingAgentStatus.ready` — `enabled` AND the harness
 * installed AND ClawBox AI connected — because that is the same fact
 * `probeCodingAgent` reads. Comparing the raw switch instead would fire on a box
 * that cannot run anything, and stay silent on none of the cases that matter.
 *
 * Never throws and never reports. The setting IS saved by the time this runs, an
 * OpenClaw box has no dashboard to ask at all, and a box whose dashboard is down
 * must not have the owner's save turned into an error by a best-effort refresh:
 * the switch is still enforced route-side and the tool list catches up at the
 * next restart — which is exactly the behaviour of every box before this
 * existed.
 *
 * BOTH WRITE PATHS, not just the switch. `ready` is `enabled` AND the harness
 * installed AND ClawBox AI connected, and the owner can move the third one on
 * its own: `applyClawaiToHermes` is what writes `clawai_token`, and every Hermes
 * connect entry point funnels through it. A box whose switch is already on goes
 * ready:false → ready:true the moment the AI is connected — which is exactly the
 * order the readiness text sends the owner in ("ClawBox AI is not connected.
 * Open Settings → AI Models and sign in to ClawBox AI first."). So this helper
 * hangs off the connect path too; see `hermes-clawai.ts`.
 *
 * @param before what `getCodingAgentStatus().ready` said BEFORE the write
 * @param after  what it says after — the same field the panel is shown, so the
 *               agent's tools and the owner's panel cannot disagree.
 * @param options see `CodingAgentRefreshOptions`
 */
export async function refreshCodingAgentToolsIfReadinessChanged(
  before: boolean,
  after: boolean,
  options: CodingAgentRefreshOptions = {},
): Promise<void> {
  if (before === after) return;
  const became = `the coding agent became ${after ? "available" : "unavailable"}`;
  if (options.alreadyReloaded) {
    // Nothing to ask for: the respawn that already happened in this request
    // rebuilt EVERY family's tool list, this one included.
    console.log(`[coding-agent/mcp-refresh] ${became}; the MCP servers were already reloaded for this change`);
    return;
  }
  // `.catch` even though `reloadMcpServers` documents that it never throws: the
  // "never throws" above is a promise made to the OWNER'S SAVE, which has
  // already been written to disk by the time this runs, and it must not depend
  // on a neighbouring module keeping its own promise.
  if (!(await reloadMcpServers().catch(() => false))) {
    // Logged, not surfaced, and in the words that are true for this edition —
    // an OpenClaw box has no dashboard to ask and needs no repair. See
    // `reportMcpReloadRefused` for why that distinction is worth making.
    await reportMcpReloadRefused("coding-agent/mcp-refresh", became);
    return;
  }
  console.log(`[coding-agent/mcp-refresh] ${became}; asked the agent to reload its MCP servers`);
}
