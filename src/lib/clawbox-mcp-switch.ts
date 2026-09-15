import { getKnown } from "@/lib/config-store";

/**
 * The owner's on/off switch for the ClawBox MCP server — the assistant's device
 * tools (Settings → Harness, owner's request 2026-09-15).
 *
 * The MCP server (`mcp/clawbox-mcp.ts`) is what gives the assistant its system,
 * file, app, browser and coding-agent tools, and the harness spawns it only
 * because its own config lists it: `mcp.servers.clawbox` in openclaw.json,
 * reconciled by `scripts/gateway-pre-start.sh` at every gateway start, and
 * `mcp_servers.clawbox` in `~/.hermes/config.yaml`, reconciled by
 * `scripts/register-mcp.sh` at every web-server boot. Both of those writers
 * read THIS key before they write, or the next boot would quietly undo the
 * owner's off.
 *
 * ABSENT MEANS ON. This is the box's default capability, not a consent: a box
 * that has never been asked has its tools, and only an explicit `false` takes
 * them away. A store that EXISTS and cannot be read is a third answer to the
 * two boot scripts: they leave the registration exactly as the last readable
 * run left it, so a corrupt write can neither undo an owner's off nor strip a
 * working box. This reader is for the Settings panel's drawing only; the route
 * that flips the switch refuses a write it cannot land rather than guessing.
 */
export const CLAWBOX_MCP_ENABLED_KEY = "clawbox_mcp_enabled";

/**
 * The one rule, on a raw store value: only the boolean `false` is off.
 *
 * A string `"false"`, `0`, `null` and an absent key all read as on, because
 * nothing on the device writes any of them and a hand-edit that meant "off"
 * has the switch in Settings to say so unambiguously. The two boot scripts
 * apply the same test (`is False` in Python), so the desktop, the route and the
 * scripts cannot disagree about a value.
 */
export function isClawboxMcpEnabledValue(value: unknown): boolean {
  return value !== false;
}

/** The switch as the store holds it now; on unless it says exactly `false`. */
export async function readClawboxMcpEnabled(): Promise<boolean> {
  const { value, known } = await getKnown(CLAWBOX_MCP_ENABLED_KEY);
  if (!known) return true;
  return isClawboxMcpEnabledValue(value);
}
