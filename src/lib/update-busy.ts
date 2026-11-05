/**
 * Agent work running on the box right now, asked before an update stops it
 * (GitHub #1269). An update stops the OpenClaw gateway and restarts the setup
 * server; a sub-agent, an ACP run or a chat turn caught by that stop is killed
 * mid-task and the owner only hears "delegated task failed" afterwards.
 *
 * Counted: coding-agent runs that are live, and gateway sessions with a run
 * active or queued (`sessions.list` with `activeOnly`). A gateway that does not
 * answer (stopped, booting, or masked on a Hermes box) counts as no work: this
 * is a warning before a click, and it must never be the reason an update
 * cannot start.
 */

export interface ActiveAgentWork {
  /** Live coding-agent runs. */
  coding: number;
  /** Gateway sessions with a run active or queued. */
  agents: number;
  total: number;
}

/** How long the gateway gets to answer before it counts as idle. */
const GATEWAY_ASK_MS = 3_000;

export async function activeAgentWork(): Promise<ActiveAgentWork> {
  const [coding, agents] = await Promise.all([
    import("@/lib/coding-agent")
      .then((m) => m.runningCount())
      .catch(() => 0),
    import("@/lib/openclaw-gateway-ws")
      .then((m) => m.gatewayWsActiveSessions({ timeoutMs: GATEWAY_ASK_MS }))
      .then((r) => r.sessionKeys.length)
      .catch(() => 0),
  ]);
  return { coding, agents, total: coding + agents };
}
