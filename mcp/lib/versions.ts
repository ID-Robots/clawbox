/**
 * The `/setup-api/update/versions` payload, and the one predicate that decides
 * whether its OpenClaw component is about something this device has.
 *
 * Two tools read that route — `update_check` (mcp/tools/system.ts) and
 * `device_status` (mcp/tools/orientation.ts). TASK-543 was the two of them
 * answering differently: `getVersionInfo()` fills `openclaw.target` from the
 * ClawBox pin even where `openclaw.current` is null, so the raw payload offers
 * a Hermes box an OpenClaw version to converge on for a harness it does not
 * ship. One predicate here, imported by both, so those two cannot diverge
 * again. The same rule is written out once more for the browser in
 * `SettingsApp.tsx`'s About panel (a client component, which cannot import the
 * fs-backed edition modules) — that is the prior art this matches.
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
  /** Present only on the SKUs that ship Hermes; carried through untouched. */
  hermes?: ComponentVersion;
  /**
   * The install edition, from the root-owned edition lock. Absent on a device
   * whose software predates the field.
   */
  edition?: string;
  /**
   * Whether the device actually reached GitHub for this check.
   *
   * Declared here because `updateAvailable: false` is unfalsifiable without
   * it: GitHub refuses anonymous git-upload-pack POSTs from an address that
   * has made too many, the device then compares HEAD against the STALE refs
   * its last successful fetch left, and every component reads "current"
   * (TASK-655). Absent on a device whose software predates the field, which is
   * "not known" — never "unreachable".
   */
  remote?: { reachable: boolean; refusedAnonymously?: boolean; reason?: string };
}

/**
 * Whether an OpenClaw version block means anything on this device.
 *
 * `dual` settles it outright: that SKU has an OpenClaw to update even while
 * Hermes is the harness answering, which is why `ctx.edition` — the resolved
 * TOOL SET — cannot be the gate on its own.
 *
 * Otherwise every source has to agree the device is not Hermes, and that is
 * deliberate rather than belt-and-braces. `readEdition()` — behind both
 * `payload.edition` and `ctx.install` — collapses an unreadable lock into its
 * "openclaw" default, while `ctx.edition` is the one input that fails CLOSED
 * there (`mcp/lib/edition.ts` resolves an unreadable lock to "hermes" and says
 * why). Requiring both keeps a truncated `/etc/clawbox/edition.env` on a Hermes
 * box from putting the block back.
 *
 * The payload is preferred over `ctx.install` for the positive answer because
 * the context is a snapshot taken once when the MCP child spawned, while the
 * payload is read per request (cached for 60 s in `getVersionInfo()`).
 */
export function shipsOpenclaw(payload: VersionsPayload | null | undefined, ctx: McpContext): boolean {
  // Resolve the install FIRST, then ask whether it is dual — asking `ctx.install
  // === "dual"` on its own would let the stale snapshot outvote a payload that
  // now says `hermes`, which is the one direction this whole predicate exists
  // to get right.
  const install = payload?.edition ?? ctx.install;
  if (install === "dual") return true;
  return install !== "hermes" && ctx.edition !== "hermes";
}

/** The versions payload as the agent on this device should see it. */
export function versionsForDevice(payload: VersionsPayload, ctx: McpContext): VersionsPayload {
  if (shipsOpenclaw(payload, ctx)) return payload;
  const shaped = { ...payload };
  delete shaped.openclaw;
  return shaped;
}
