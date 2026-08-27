"use client";

import { useEffect, useState } from "react";
import type { CodingAgentActivity } from "@/lib/use-coding-agent-activity";

/**
 * One delegated coding run, as a card in the chat.
 *
 * Grown from a one-line pill into the same kind of card the Claude Code web
 * UI shows for a delegated workflow: a title line naming the work, a meta
 * line with the status, how the run is spending its effort and for how long,
 * and — when the run fans out — one dot per sub-agent, filled while that
 * helper is still out. The dots are the Coding Agent app's own vocabulary
 * (see CodingAgentApp), so the chat and the app read the same way.
 *
 * The card STAYS once the run ends, reporting the outcome. Runs measured on
 * the box take 9-15 seconds — a badge that vanished with the run was gone
 * before the owner had finished reading the message above it.
 *
 * The elapsed time ticks while the run is in flight and freezes at the total
 * once it is not: a moving second is the cheapest proof a multi-minute run is
 * alive, and a frozen one is the record of how long it took.
 */

const TONE = {
  running: { color: "#fcd34d", glyph: "🤖" },
  completed: { color: "#86efac", glyph: "✓" },
  failed: { color: "#fca5a5", glyph: "!" },
  stopped: { color: "#cbd5e1", glyph: "◼" },
} as const;

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** "46k" / "1.3M" — the Coding Agent app's own compaction. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function firstLine(text: string, max = 64): string {
  const line = (text ?? "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export default function CodingAgentActivityPill(
  { run, labels, openLabel, onOpen }: {
    run: CodingAgentActivity;
    /**
     * One per status, plus the owner-started variant of "running", plus the
     * counted words for the meta line: `agents` is a "{n} agents" template,
     * `tokensWord` follows a count.
     */
    labels: { running: string; runningOwner: string; completed: string; failed: string; stopped: string; agents?: string; tokensWord?: string };
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
  const title = firstLine(run.task) || run.projectId || label;

  // Tolerate a record from before these fields existed (or a test's stub).
  const subTotal = run.subagentsTotal ?? 0;
  const subActive = live ? (run.subagentsActive ?? 0) : 0;
  const byType = run.subagentsByType ?? {};
  const used = run.tokensUsed ?? 0;

  const meta: React.ReactNode[] = [
    <span key="label" style={{ color: tone.color }}>{label}</span>,
  ];
  if (run.projectId) meta.push(<span key="project">{run.projectId}</span>);
  if (subTotal > 0 && labels.agents) {
    meta.push(<span key="agents">{labels.agents.replaceAll("{n}", String(subTotal))}</span>);
  }
  if (used > 0 && labels.tokensWord) {
    meta.push(<span key="tokens">{`${tokens(used)} ${labels.tokensWord}`}</span>);
  }
  // aria-hidden lives on the clock's own span below.
  meta.push(<span key="took" aria-hidden="true">{took}</span>);

  return (
    <div
      data-testid="coding-agent-activity"
      data-status={run.status}
      role="status"
      // The elapsed time re-renders every second. Inside a polite live region
      // that makes a screen reader announce the whole card on every tick for
      // as long as the run lasts. The status text is what is worth announcing;
      // the clock is marked aria-hidden above.
      aria-live={live ? "polite" : "off"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 12px",
        borderRadius: 12,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.85)",
        fontSize: 12,
        maxWidth: "100%",
        minWidth: 220,
        alignSelf: "flex-start",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden="true" style={{ color: tone.color, flexShrink: 0 }}>{tone.glyph}</span>
        <span style={{
          fontWeight: 600,
          fontSize: 12.5,
          color: "rgba(255,255,255,0.9)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}>
          {title}
        </span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            title={openLabel}
            aria-label={openLabel}
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.55)",
              cursor: "pointer",
              font: "inherit",
              fontSize: 11.5,
              padding: 0,
              textDecoration: "underline",
              flexShrink: 0,
            }}
          >
            {openLabel}
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2, color: "rgba(255,255,255,0.5)", fontSize: 11.5 }}>
        {meta.map((part, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 ? <span aria-hidden="true">·</span> : null}
            {part}
          </span>
        ))}
      </div>
      {subTotal > 0 ? (
        // One dot per sub-agent, capped so a fan-out cannot flood the card;
        // filled + pulsing while that helper is still out, hollow once it is
        // back. The per-type breakdown rides on `title` — same vocabulary as
        // the Coding Agent app's dots.
        <span
          data-testid="coding-agent-activity-subagents"
          style={{ display: "flex", alignItems: "center", gap: 4 }}
          title={Object.entries(byType).map(([k, n]) => `${n}× ${k}`).join(", ")}
        >
          {Array.from({ length: Math.min(subTotal, 12) }).map((_, i) => (
            <span
              key={i}
              className={i < subActive ? "animate-pulse" : undefined}
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: i < subActive ? "#34d399" : "rgba(52,211,153,0.35)",
              }}
            />
          ))}
          {subTotal > 12 ? <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.5)" }}>+{subTotal - 12}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
