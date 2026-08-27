import { reloadMcpServers } from "@/lib/hermes-mcp-reload";

/**
 * Ask Hermes to rebuild its MCP tool list when the mailbox becomes readable, or
 * stops being.
 *
 * WHY THIS EXISTS. Two tools, `email_list` and `email_read`, are registered
 * CONDITIONALLY by the ClawBox MCP server (mcp/tools/email.ts): the server asks
 * `/setup-api/email/status` for `canRead` while it boots (mcp/lib/context.ts)
 * and, when the answer is no, it never declares them. That is not caution about
 * the mailbox — the route refuses the call anyway. It is about Hermes' own
 * per-server circuit breaker: a tool that can only ever answer 409 keeps
 * failing, the breaker opens, and it takes EVERY ClawBox tool offline with it,
 * not just the two. So "not registered" really is the right answer for a
 * send-only box, and registering them always is not an option.
 *
 * The bug it fixes is that the probe happens ONCE, at server startup, and the
 * server is a long-lived stdio child of Hermes. When the owner connects a
 * mailbox or moves the mode from "Send only" to "Read on demand", the running
 * server keeps the tool list it built at boot, so the agent still has no way to
 * open the mailbox the owner just gave it — until something unrelated happens
 * to respawn the server. Measured on the owner's device
 * (`~/.hermes/logs/mcp-stderr.log`): 8 starts logged `profile=full, 41 tools`
 * and 21 logged `43 tools`, the 41-tool starts all predating the mailbox
 * becoming readable, and the two missing tools were exactly these.
 *
 * The mechanism is Hermes' own `reload.mcp`, and it is shared with the other
 * family that has the same startup-only gate — see `hermes-mcp-reload.ts`. What
 * belongs HERE is the rule for when it is worth paying for, below.
 */

/**
 * Reload Hermes' MCP servers, but ONLY if this settings change flipped whether
 * the agent may read the mailbox.
 *
 * The guard is the important half. A reload kills and respawns every MCP child
 * process and invalidates the model's prompt cache, so the next turn on this box
 * re-sends and re-pays for a system prompt that was cached — it is not free, and
 * firing it on every email save (a display name edited, a password rotated in
 * place) would charge the owner for nothing. Readability flips maybe once in the
 * life of a mailbox; that is the event worth a reload, and it is the only one
 * this fires on.
 *
 * Never throws and never reports. A box whose dashboard is down, or an OpenClaw
 * box that has no dashboard at all, must not have its email settings save turned
 * into an error by a best-effort refresh: the settings ARE saved, the gate is
 * still enforced route-side, and the tool list catches up at the next restart —
 * which is exactly the behaviour of every box before this existed.
 */
export async function refreshEmailToolsIfReadabilityChanged(before: boolean, after: boolean): Promise<void> {
  if (before === after) return;
  if (!(await reloadMcpServers())) {
    // Logged, not surfaced. Worth a line because "the agent still cannot see my
    // mailbox" is otherwise invisible from the outside, and this is the one
    // place that knows the refresh was wanted and did not happen.
    console.error(
      `[email/mcp-refresh] mailbox readability changed to ${after}, but Hermes would not reload its MCP servers`,
    );
    return;
  }
  console.log(`[email/mcp-refresh] mailbox readability changed to ${after}; asked Hermes to reload its MCP servers`);
}
