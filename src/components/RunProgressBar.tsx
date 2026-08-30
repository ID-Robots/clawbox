"use client";

import type { CodingRunStatus } from "@/lib/coding-agent-status";
import { formatEta, type RunProgressEstimate } from "@/lib/coding-agent-progress";

/**
 * A coding run's colour, and its progress bar — the two things the chat card
 * (CodingAgentActivityPill) and the Coding Agent app both draw for a run.
 *
 * They used to draw them separately, and drifted: the chat's draft was slate
 * (the same as stopped, so a draft read as "over") while the app's was
 * violet. One table now, and one bar; the app's status chip and the chat's
 * glyph take their colour from the same row.
 *
 * Tailwind for the static parts and inline style for what changes per run
 * (the fill's width and colour). The chat popup renders Tailwind like any
 * other part of the desktop — the card already relies on `animate-pulse` and
 * `sr-only` — so both hosts can draw this the same way.
 */

export const RUN_TONE: Record<CodingRunStatus, {
  /** The status word's colour, the bar's fill, the card's glyph. */
  color: string;
  /** The chat card's glyph for the status. */
  glyph: string;
  /** The app's status chip: text plus a 40 % border of the same hue. */
  chip: string;
}> = {
  running: { color: "#fcd34d", glyph: "🤖", chip: "text-amber-400 border-amber-400/40" },
  completed: { color: "#86efac", glyph: "✓", chip: "text-emerald-400 border-emerald-400/40" },
  failed: { color: "#fca5a5", glyph: "!", chip: "text-red-400 border-red-400/40" },
  stopped: { color: "#cbd5e1", glyph: "◼", chip: "text-[var(--text-muted)] border-white/20" },
  paused: { color: "#93c5fd", glyph: "⏸", chip: "text-sky-300 border-sky-300/40" },
  // Violet, like the app's Start button: a draft is a run waiting to begin,
  // not a stopped one, so it must not share stopped's slate.
  draft: { color: "#c4b5fd", glyph: "✎", chip: "text-violet-300 border-violet-300/40" },
};

/**
 * The bar and its "≈ 12 min left". Nothing when there is nothing honest to
 * draw (see estimateRunProgress); the ETA only once it is worth saying.
 * aria-hidden: the status word above it is what is announced, and a bar that
 * moves every poll would be narrated every poll.
 */
export default function RunProgressBar({ estimate, color, timeLeft, testId, className }: {
  estimate: RunProgressEstimate;
  color: string;
  /** Follows "≈ 12 min": the owner's word for "left". */
  timeLeft: string;
  testId: string;
  className?: string;
}) {
  if (estimate.fraction == null) return null;
  return (
    <div data-testid={testId} aria-hidden="true" className={`flex items-center gap-2 ${className ?? ""}`}>
      <div className="flex-1 h-[3px] rounded bg-white/10 overflow-hidden">
        <div
          className="h-full rounded transition-[width] duration-700 ease-out"
          style={{ width: `${Math.round(estimate.fraction * 100)}%`, background: color }}
        />
      </div>
      {estimate.etaMs != null && (
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">{`≈ ${formatEta(estimate.etaMs)} ${timeLeft}`}</span>
      )}
    </div>
  );
}
