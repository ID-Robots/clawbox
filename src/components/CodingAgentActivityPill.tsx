"use client";

import { useEffect, useState } from "react";
import type { CodingAgentActivity } from "@/lib/use-coding-agent-activity";

/**
 * One delegated coding run, as a badge in the chat.
 *
 * It sits with the live tool pills and borrows their shape and their three
 * tones on purpose: this is the same kind of fact they report — what the box
 * did — and the eye should not have to learn a second vocabulary for it. What
 * differs is the source. A tool pill is fed by the gateway's tool-call
 * lifecycle and so reaches "done" the moment `coding_agent_run` hands back a
 * run id; this is fed by the device's own run record, so it tracks the work.
 *
 * The badge STAYS once the run ends, reporting the outcome. Runs measured on
 * the box take 9-15 seconds — a badge that vanished with the run was gone
 * before the owner had finished reading the message above it.
 *
 * The elapsed time ticks while the run is in flight and freezes at the total
 * once it is not: a moving second is the cheapest proof a multi-minute run is
 * alive, and a frozen one is the record of how long it took.
 */

const TONE = {
  running: { background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.25)", color: "#fcd34d", glyph: "🤖" },
  completed: { background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.22)", color: "#86efac", glyph: "✓" },
  failed: { background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5", glyph: "!" },
  stopped: { background: "rgba(148,163,184,0.12)", border: "1px solid rgba(148,163,184,0.25)", color: "#cbd5e1", glyph: "◼" },
} as const;

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

export default function CodingAgentActivityPill(
  { run, labels, openLabel, onOpen }: {
    run: CodingAgentActivity;
    /** One per status, plus the owner-started variant of "running". */
    labels: { running: string; runningOwner: string; completed: string; failed: string; stopped: string };
    openLabel: string;
    onOpen?: () => void;
  },
) {
  const live = run.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const tone = TONE[run.status];
  // A run the OWNER started says so, so the assistant is not credited with
  // work the person at the desk kicked off.
  const label = live && run.source === "owner" ? labels.runningOwner : labels[run.status];
  const took = elapsed(run.startedAt, live ? now : (run.completedAt ?? now));

  return (
    <div
      data-testid="coding-agent-activity"
      data-status={run.status}
      role="status"
      // The elapsed time re-renders every second. Inside a polite live region
      // that makes a screen reader announce the whole pill on every tick for
      // as long as the run lasts. The status text is what is worth announcing;
      // the clock is marked aria-hidden below.
      aria-live={live ? "polite" : "off"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        background: tone.background,
        border: tone.border,
        color: tone.color,
        fontSize: 12,
        fontWeight: 500,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true">{tone.glyph}</span>
      <span>{label}</span>
      {run.projectId ? <span style={{ opacity: 0.7 }}>· {run.projectId}</span> : null}
      {/* aria-hidden: it changes every second, and a live region would
          announce the whole pill on every tick. Sighted users get the clock;
          screen readers get the status, which is what actually changed. */}
      <span aria-hidden="true" style={{ opacity: 0.7 }}>· {took}</span>
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
