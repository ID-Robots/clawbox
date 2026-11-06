/**
 * A coding team's status words, and the one predicate on them the client
 * shares with the server. Disk-free on purpose, like coding-agent-status.ts
 * for runs: coding-team-board.ts reads the board files, so a component (or
 * the slim-poll module both sides use) cannot import the predicate from there.
 */
export const TEAM_STATUSES = ["queued", "planning", "working", "reviewing", "done", "failed", "stopped"] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** Done, failed or stopped: nothing more happens to the team. */
export function isSettledTeamStatus(status: TeamStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}
