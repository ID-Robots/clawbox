"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Is the coding agent working right now?", for the chat.
 *
 * WHY THE TOOL PILLS ARE NOT ENOUGH
 *
 * `coding_agent_run` returns as soon as the device has SPAWNED the run — the
 * route answers 202 in milliseconds, by design, because the MCP call must not
 * hold a connection open for twenty minutes. So the chat's tool pill goes
 * "🔧 coding agent run" → "✓" within a second, while the actual work carries
 * on for minutes. The pill is telling the truth about the tool call and the
 * wrong thing about the box: the crab looks idle while Claude Code is editing
 * files in the next room.
 *
 * This hook asks the DEVICE instead, so the indicator lasts exactly as long as
 * the work does.
 *
 * WHY IT COSTS ALMOST NOTHING
 *
 * It does not poll on a timer while nothing is happening. It probes once when
 * the chat opens (to catch a run started before this session, or from the
 * Coding Agent app), and again whenever `nudge()` is called — which the chat
 * does the moment it sees a coding-agent tool call go by. Only once a run is
 * known to be in flight does it poll, and it stops as soon as none is. On an
 * idle box that is one request per chat open, and none after.
 */

export interface CodingAgentActivity {
  id: string;
  projectId: string | null;
  task: string;
  startedAt: number;
  source: "agent" | "owner";
}

interface RunPayload {
  id: string;
  projectId: string | null;
  task: string;
  status: string;
  startedAt: number;
  source: string;
}

/** How often to re-ask while a run is actually in flight. */
const POLL_MS = 5_000;
/** Enough to catch a run even if a couple of newer ones finished meanwhile. */
const LOOK_BACK = 3;

/** True when the tool the chat just saw is one of the coding-agent family. */
export function isCodingAgentTool(name: string): boolean {
  return /coding_agent/i.test(name);
}

export function useCodingAgentActivity(active: boolean): {
  run: CodingAgentActivity | null;
  nudge: () => void;
} {
  const [run, setRun] = useState<CodingAgentActivity | null>(null);
  // Bumped by nudge(); the effect below re-runs and probes immediately.
  const [probe, setProbe] = useState(0);
  const runningRef = useRef(false);
  runningRef.current = run !== null;

  const nudge = useCallback(() => setProbe((n) => n + 1), []);

  useEffect(() => {
    if (!active) {
      setRun(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = async () => {
      try {
        const res = await fetch(`/setup-api/coding-agent/runs?limit=${LOOK_BACK}`, { cache: "no-store" });
        if (!res.ok) throw new Error("runs");
        const data = await res.json() as { runs?: RunPayload[] };
        const busy = (data.runs ?? []).find((r) => r.status === "running") ?? null;
        if (!alive) return;
        setRun(busy
          ? {
            id: busy.id,
            projectId: busy.projectId,
            task: busy.task,
            startedAt: busy.startedAt,
            source: busy.source === "owner" ? "owner" : "agent",
          }
          : null);
        // Keep asking only while there is something to ask about. A run that
        // just ended stops the loop on this very tick.
        if (busy) timer = setTimeout(() => { void read(); }, POLL_MS);
      } catch {
        // The device is the source of truth and it did not answer. Say nothing
        // rather than claim work is happening — a stuck indicator on a chat
        // that cannot reach its own box would be worse than none.
        if (alive) setRun(null);
      }
    };

    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, probe]);

  return { run, nudge };
}
