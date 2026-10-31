/**
 * The busy gate's real reads (see `update-busy.ts`): the gateway's session
 * index and drain fence over its own WebSocket, and the coding agent's count.
 *
 * SERVER ONLY.
 */

import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";
import {
  countActiveSessions,
  withTotal,
  type AgentWorkCounts,
  type GatewayCall,
} from "@/lib/update-busy";

/** One gateway read must not hold an update or a refusal for long. */
const GATEWAY_READ_TIMEOUT_MS = 5_000;

/**
 * The drain's own calls answer slower by design: with final chat writes or
 * other protected work pending, the core holds `gateway.suspend.status` (and
 * preparation) for up to 15 s before it answers. Cut at 5 s, a drain doing
 * exactly its job read as a gateway that had gone away.
 */
const GATEWAY_SUSPEND_TIMEOUT_MS = 30_000;

export const gatewayCall: GatewayCall = (method, params) =>
  gatewayWsCall(method, params, {
    timeoutMs: method.startsWith("gateway.suspend.") ? GATEWAY_SUSPEND_TIMEOUT_MS : GATEWAY_READ_TIMEOUT_MS,
  });

/**
 * The gateway's runs in flight, from `sessions.list` with `activeOnly` (only
 * running or queued sessions, before pagination). A gateway that does not
 * answer — stopped, starting, absent on this edition — has no run in flight to
 * protect, so it counts nothing; one that refuses the filter is asked for the
 * plain list.
 */
async function gatewayRuns(call: GatewayCall): Promise<Pick<AgentWorkCounts, "agentRuns" | "subagentRuns">> {
  try {
    return countActiveSessions(await call("sessions.list", { activeOnly: true }));
  } catch (err) {
    if ((err as { name?: unknown }).name !== "GatewayRpcError") return { agentRuns: 0, subagentRuns: 0 };
  }
  try {
    return countActiveSessions(await call("sessions.list", {}));
  } catch {
    return { agentRuns: 0, subagentRuns: 0 };
  }
}

/** Imported when asked: the coding agent's module is large and this one is loaded at boot. */
async function codingRuns(): Promise<number> {
  try {
    const { runningCount } = await import("@/lib/coding-agent");
    return runningCount();
  } catch {
    return 0;
  }
}

/** Everything an update would cut short, right now. */
export async function activeAgentWork(call: GatewayCall = gatewayCall): Promise<AgentWorkCounts> {
  const [gateway, coding] = await Promise.all([gatewayRuns(call), codingRuns()]);
  return withTotal({ ...gateway, codingRuns: coding });
}

/**
 * Reopen admission on a gateway this update drained but did not stop (the step
 * failed before its stop, or never needed one). Best-effort and quiet: a
 * gateway that has since exited took its lease with it, and its successor
 * answers an id it never issued with a refusal that changes nothing.
 */
export async function resumeGatewayAdmission(suspensionId: string, call: GatewayCall = gatewayCall): Promise<void> {
  try {
    await call("gateway.suspend.resume", { suspensionId });
  } catch {
    /* gone, or not ours to resume */
  }
}
