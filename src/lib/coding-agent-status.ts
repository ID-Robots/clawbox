/**
 * The coding run's status machine — the ONE list every consumer derives from.
 *
 * Server (coding-agent.ts), client (CodingAgentApp, the activity hook) and the
 * MCP server (mcp/tools/coding-agent.ts) each used to declare this union by
 * hand, and the persisted-status allow-list was a fourth copy: a status
 * missing from that copy made a restart silently DELETE the record (paused
 * runs and drafts vanished, found the hard way). Adding a status now means
 * adding it here, and the predicates below say what it means.
 *
 * Pure TypeScript on purpose: no Node imports, so the browser bundle and the
 * MCP process can both import it.
 */

/**
 * EVERY status a run record can carry. Gates what is read back from disk.
 * The type is DERIVED from this list, not written beside it: a status added
 * to one and not the other used to compile, and the mismatch was found at
 * the restart that dropped the record.
 */
export const RUN_STATUSES = ["running", "completed", "failed", "stopped", "paused", "draft"] as const;

export type CodingRunStatus = (typeof RUN_STATUSES)[number];

export function isCodingRunStatus(value: unknown): value is CodingRunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/** A process exists for this run right now. */
export function isLive(status: CodingRunStatus): boolean {
  return status === "running";
}

/**
 * Held by the owner, not history: a live run, a paused one waiting to be
 * resumed, a draft waiting to be started. Never cleared, never trimmed to
 * make room, never picked as "the last finished run".
 */
export function isHeld(status: CodingRunStatus): boolean {
  return status === "running" || status === "paused" || status === "draft";
}

/** Over, one way or another — what the history list and the review pass look at. */
export function isSettled(status: CodingRunStatus): boolean {
  return !isHeld(status);
}
