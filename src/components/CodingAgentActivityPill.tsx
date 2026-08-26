"use client";

import { useEffect, useState } from "react";
import type { CodingAgentActivity } from "@/lib/use-coding-agent-activity";

/**
 * "The coding agent is still working", shown in the chat for exactly as long
 * as that is true.
 *
 * It sits with the live tool pills and borrows their shape on purpose: this is
 * the same kind of fact they report — what the box is doing right now — and the
 * eye should not have to learn a second vocabulary for it. The difference is
 * what drives it. A tool pill is fed by the gateway's tool-call lifecycle and
 * so goes "done" the moment `coding_agent_run` returns its run id; this is fed
 * by the device's own run record, so it stays up while the work does.
 *
 * The elapsed time ticks because a run takes minutes: a static pill leaves the
 * owner wondering whether it is working or wedged, and the ticking second is
 * the cheapest possible proof of life.
 */

const RUNNING_BG = "rgba(251,191,36,0.12)";
const RUNNING_BORDER = "1px solid rgba(251,191,36,0.25)";
const RUNNING_FG = "#fcd34d";

function elapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

export default function CodingAgentActivityPill(
  { run, label, ownerLabel, openLabel, onOpen }: {
    run: CodingAgentActivity;
    label: string;
    ownerLabel: string;
    openLabel: string;
    onOpen?: () => void;
  },
) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-testid="coding-agent-activity"
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        background: RUNNING_BG,
        border: RUNNING_BORDER,
        color: RUNNING_FG,
        fontSize: 12,
        fontWeight: 500,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true">🤖</span>
      {/* The run the OWNER started is named as theirs: the assistant should not
          appear to be doing something the person at the desk kicked off. */}
      <span>{run.source === "owner" ? ownerLabel : label}</span>
      {run.projectId ? <span style={{ opacity: 0.7 }}>· {run.projectId}</span> : null}
      <span style={{ opacity: 0.7 }}>· {elapsed(run.startedAt, now)}</span>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={openLabel}
          aria-label={openLabel}
          style={{
            marginLeft: 2,
            background: "transparent",
            border: 0,
            color: "inherit",
            opacity: 0.75,
            cursor: "pointer",
            font: "inherit",
            padding: 0,
            textDecoration: "underline",
          }}
        >
          {openLabel}
        </button>
      ) : null}
    </div>
  );
}
