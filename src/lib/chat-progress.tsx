// The agent's own task-progress card, as the chat shows it.
//
// A VIEW of an authoritative record and nothing else. The plan is written by
// the agent into the harness's own progress-card store and read back through
// `HarnessAdapter.loadProgressCard`; this file decides how it looks and makes
// exactly one judgement of its own — see `progressStepView`, which is about the
// RUN rather than about the card, because the store cannot know whether the
// agent is still working on the step it last marked `in_progress`.
//
// What this deliberately does not do is derive a checklist from tool events or
// transcript text. A card assembled that way would be indistinguishable on
// screen from the real one and would disagree with it the moment the agent
// revised its plan — and the customer would have no way to tell which of the
// two was the agent's actual intent.
//
// Shaped after `chat-clarify.tsx` and `chat-approvals.tsx`: the same ground,
// the same hairline, the same muted body text, because an owner reads
// everything the chat puts above its composer as one family.

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { timeAgo } from "@/components/clawkeep-ui";
import type { ProgressCard, ProgressStep, ProgressStepStatus } from "@/lib/harness/transport";

const CARD_BG = "rgba(255,255,255,0.04)";
const CARD_BORDER = "1px solid rgba(255,255,255,0.10)";
const TITLE_FG = "rgba(255,255,255,0.82)";
const BODY_FG = "rgba(255,255,255,0.72)";
const MUTED_FG = "rgba(255,255,255,0.45)";
const ACTIVE_FG = "#fdba74";
const DONE_FG = "#86efac";

/**
 * How one step is drawn — the store's three states plus one this surface
 * derives.
 *
 * `stopped` is a step the agent marked `in_progress` and then stopped working
 * on: the turn ended, was aborted, or the socket went away, and nothing writes
 * a "we gave up here" status into the card. Drawing that row as an active,
 * pulsing step would tell the customer the box is still working when it is
 * doing nothing at all — the one lie a progress card must not tell — so the
 * RUN decides, since it is the only thing that knows.
 */
export type ProgressStepView = ProgressStepStatus | "stopped";

/** `running` is "a turn is in flight in this conversation right now". */
export function progressStepView(status: ProgressStepStatus, running: boolean): ProgressStepView {
  return status === "in_progress" && !running ? "stopped" : status;
}

/** Completed out of total. `total` is 0 for a card that is markdown only. */
export function progressCounts(steps: readonly ProgressStep[] | undefined): { done: number; total: number } {
  const list = steps ?? [];
  return { done: list.filter((s) => s.status === "completed").length, total: list.length };
}

/** The one step the agent says it is on, or null. The store allows at most one. */
export function currentProgressStep(steps: readonly ProgressStep[] | undefined): ProgressStep | null {
  return (steps ?? []).find((s) => s.status === "in_progress") ?? null;
}

const STATE_LABEL: Record<ProgressStepView, string> = {
  completed: "chat.progress.stepCompleted",
  in_progress: "chat.progress.stepInProgress",
  pending: "chat.progress.stepPending",
  stopped: "chat.progress.stepStopped",
};

const STATE_GLYPH: Record<ProgressStepView, string> = {
  completed: "check_circle",
  in_progress: "progress_activity",
  pending: "radio_button_unchecked",
  stopped: "pause_circle",
};

const STATE_FG: Record<ProgressStepView, string> = {
  completed: DONE_FG,
  in_progress: ACTIVE_FG,
  pending: MUTED_FG,
  stopped: MUTED_FG,
};

export interface TaskProgressCardProps {
  card: ProgressCard;
  /**
   * Is a turn in flight in THIS conversation? Only used to tell an active step
   * from an abandoned one — see `progressStepView`.
   */
  running: boolean;
  /** The caller's clock, so the card and the rest of the surface agree on now. */
  nowMs?: number;
}

/**
 * The card. Expanded on arrival, because a plan the owner has to click to see
 * is a plan they will not read; collapsing is one press and survives every
 * later revision of the same card (the caller keys this on the session, so a
 * different conversation gets its own fresh one).
 */
export function TaskProgressCard({ card, running, nowMs }: TaskProgressCardProps) {
  // The hook rather than label props, as in `chat-clarify.tsx`: with no
  // provider above it, `useT` falls back to the key.
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const steps = card.steps ?? [];
  const { done, total } = progressCounts(steps);
  const current = currentProgressStep(steps);
  // What the card says it is doing, in one line. The agent's own words where
  // there are any — a step is already a sentence about the work — and a stated
  // fact otherwise. Never invented: a card with no steps at all says nothing
  // here and lets its markdown speak.
  const statusLine = current
    ? current.step
    : total === 0
      ? null
      : done === total
        ? t("chat.progress.allDone")
        : t("chat.progress.waiting");

  return (
    <div
      data-testid="chat-progress"
      data-open={open ? "true" : "false"}
      style={{
        background: CARD_BG,
        border: CARD_BORDER,
        borderRadius: 10,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <button
        type="button"
        data-testid="chat-progress-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? t("chat.progress.collapse") : t("chat.progress.expand")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "transparent",
          border: "none",
          padding: 0,
          color: TITLE_FG,
          font: "inherit",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15, color: MUTED_FG }}>
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{t("chat.progress.title")}</span>
        {total > 0 && (
          <span data-testid="chat-progress-count" style={{ color: MUTED_FG, fontWeight: 500 }}>
            {t("chat.progress.count", { done, total })}
          </span>
        )}
        {/* No stamp, no line. A card whose store did not say when it was
            written must not be printed as "just now" — see the parse. */}
        {card.updatedAt > 0 && (
          <span data-testid="chat-progress-updated" style={{ color: MUTED_FG, fontWeight: 500 }}>
            · {timeAgo(card.updatedAt, t, nowMs)}
          </span>
        )}
      </button>

      {statusLine && (
        <div
          data-testid="chat-progress-status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: current && running ? ACTIVE_FG : MUTED_FG,
            wordBreak: "break-word",
          }}
        >
          {/* Only a step that is genuinely being worked on gets the moving
              dot. A stopped run leaves a still one, for the reason
              `progressStepView` gives. */}
          {current && running && (
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: ACTIVE_FG,
                flexShrink: 0,
                animation: "clawHeaderPulse 1.2s ease-in-out infinite",
              }}
            />
          )}
          <span style={{ minWidth: 0 }}>{statusLine}</span>
        </div>
      )}

      {open && card.markdown && (
        <div
          data-testid="chat-progress-body"
          style={{ fontSize: 12.5, lineHeight: 1.5, color: BODY_FG, wordBreak: "break-word" }}
        >
          {renderText(card.markdown, t("chat.table"))}
        </div>
      )}

      {open && steps.length > 0 && (
        <ol
          data-testid="chat-progress-steps"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}
        >
          {steps.map((step, index) => {
            const view = progressStepView(step.status, running);
            const label = t(STATE_LABEL[view]);
            return (
              <li
                // The agent may write the same words twice; the position is the
                // identity here, and the list is re-read whole on every change.
                key={`${index}:${step.step}`}
                data-testid="chat-progress-step"
                data-state={view}
                style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12.5, color: BODY_FG }}
              >
                <span
                  className="material-symbols-rounded"
                  aria-hidden="true"
                  style={{
                    fontSize: 15,
                    lineHeight: "18px",
                    flexShrink: 0,
                    color: STATE_FG[view],
                    // The glyph moves only while the step is genuinely live,
                    // on the chat's own pulse rather than a second animation
                    // of its own — the busy dot in the tab strip is the same
                    // one, and two nearly-identical rhythms on one surface
                    // read as a fault.
                    ...(view === "in_progress"
                      ? { animation: "clawHeaderPulse 1.2s ease-in-out infinite" }
                      : {}),
                  }}
                >
                  {STATE_GLYPH[view]}
                </span>
                <span
                  style={{
                    minWidth: 0,
                    wordBreak: "break-word",
                    color: view === "pending" ? MUTED_FG : BODY_FG,
                    textDecoration: view === "completed" ? "line-through" : "none",
                    textDecorationColor: "rgba(255,255,255,0.25)",
                  }}
                >
                  {step.step}
                </span>
                {/* The state in words, for a reader who cannot see the glyph —
                    and on screen for the one state a glyph cannot carry on its
                    own, because "this stopped unfinished" is not something a
                    paused icon says by itself. */}
                <span
                  data-testid="chat-progress-step-state"
                  style={
                    view === "stopped"
                      ? { fontSize: 11, color: MUTED_FG, flexShrink: 0 }
                      : {
                          position: "absolute",
                          width: 1,
                          height: 1,
                          overflow: "hidden",
                          clip: "rect(0 0 0 0)",
                          whiteSpace: "nowrap",
                        }
                  }
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
