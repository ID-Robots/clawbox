/**
 * The `/setup-api/update/versions` payload, and the one predicate that decides
 * whether its OpenClaw component is about something this device has.
 *
 * Two tools read that route — `update_check` (mcp/tools/system.ts) and
 * `device_status` (mcp/tools/orientation.ts). TASK-543 was the two of them
 * answering differently: `getVersionInfo()` fills `openclaw.target` from the
 * ClawBox pin even where `openclaw.current` is null, so the raw payload offers
 * a Hermes box an OpenClaw version to converge on for a harness it does not
 * ship. One predicate here, imported by both, so they cannot diverge again.
 */

import type { McpContext } from "./context";

interface ComponentVersion {
  current?: string | null;
  target?: string | null;
  updateAvailable?: boolean;
}

export interface VersionsPayload {
  clawbox?: ComponentVersion;
  openclaw?: ComponentVersion;
  /** Present only on the SKUs that ship Hermes — its presence is the signal. */
  hermes?: ComponentVersion;
  /** The install edition, read from the root-owned edition lock per call. */
  edition?: string;
}

/**
 * Whether an OpenClaw version block means anything on this device.
 *
 * The payload's own `edition` decides, ahead of the context: `ctx.install` is a
 * snapshot taken once when the MCP child spawned, while the route answers from
 * `readEdition()` on every call. Only the `hermes` SKU ships no OpenClaw —
 * `dual` has one to update even while Hermes is the harness answering.
 */
export function shipsOpenclaw(payload: VersionsPayload | null | undefined, ctx: McpContext): boolean {
  return (payload?.edition ?? ctx.install) !== "hermes";
}

/** The versions payload as the agent on this device should see it. */
export function versionsForDevice(payload: VersionsPayload, ctx: McpContext): VersionsPayload {
  if (shipsOpenclaw(payload, ctx)) return payload;
  const shaped = { ...payload };
  delete shaped.openclaw;
  return shaped;
}
