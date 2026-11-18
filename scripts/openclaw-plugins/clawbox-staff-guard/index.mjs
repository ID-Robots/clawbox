// ClawBox's staff guard, as an OpenClaw plugin (TASK-2444, TASK-2445).
//
// WHAT IT IS FOR. On an organisation box (org_mode, src/lib/org-mode.ts) every
// member of staff talks to an agent of their own, `clawbox-staff-<name>`
// (src/lib/org-staff-agents.ts), whose tool policy is the staff allow-list of
// config/org-staff-policy.json. That policy is the core's and comes first; this
// hook is the part of the rule the core's policy cannot say — a file tool may
// write only inside the member's own folder, and read only there or in the
// chat's staged attachments — and a second refusal of every tool the table
// does not name, so a policy someone widened by hand is still not a way out.
//
// THE SEAM IS THE CORE'S OWN, the same as clawbox-path-guard's:
// `before_tool_call`, `{ block: true, blockReason }` (docs/plugins/hooks/
// tool-policy.md in the pinned core), with `ctx.agentId` / `ctx.sessionKey`
// saying whose agent is calling. Installed and enabled by gateway-pre-start.sh
// beside the other hook plugins, with the policy table copied in beside it.
//
// Every agent that is not a member of staff's — the owner's — gets "no
// opinion" without anything else being looked at.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { staffDenyMessage, staffToolCallDenyReason } from "./staff-guard.mjs";

const PLUGIN_ID = "clawbox-staff-guard";

/**
 * OpenClaw's state directory: the plugin is installed at
 * `<state dir>/extensions/clawbox-staff-guard/`, so it is two levels up —
 * whatever HOME or OPENCLAW_HOME the gateway was started with.
 */
function openclawHomeOf(moduleUrl) {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(path.dirname(here)) === "extensions" ? path.dirname(path.dirname(here)) : undefined;
}

const OPENCLAW_HOME = openclawHomeOf(import.meta.url);

/**
 * The hook. Never throws: a guard that throws is skipped by the dispatcher
 * (fail-open), so every failure to judge a staff call is a refusal instead.
 */
export function onBeforeToolCall(event, ctx) {
  let reason;
  try {
    reason = staffToolCallDenyReason(event, ctx, OPENCLAW_HOME ? { openclawHome: OPENCLAW_HOME } : {});
  } catch (err) {
    // Only a staff call can get here with a table that would not load, and
    // a member's call that cannot be judged is not run.
    reason = `the staff policy could not be read (${err instanceof Error ? err.message : String(err)})`;
    const agent = typeof ctx?.agentId === "string" ? ctx.agentId : String(ctx?.sessionKey ?? "");
    if (!agent.toLowerCase().includes("clawbox-staff-")) return undefined;
  }
  if (!reason) return undefined;
  return { block: true, blockReason: staffDenyMessage(reason) };
}

const clawboxStaffGuardPlugin = {
  id: PLUGIN_ID,
  name: "ClawBox staff guard",
  description: "On an organisation ClawBox, holds a member of staff's agent to the staff tool allow-list and its file tools to that member's own folder.",
  register(api) {
    api.on("before_tool_call", onBeforeToolCall);
  },
};

export default clawboxStaffGuardPlugin;
