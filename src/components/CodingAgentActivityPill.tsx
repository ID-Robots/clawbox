"use client";

import { useEffect, useState } from "react";
import { artifactUrl, type CodingAgentActivity } from "@/lib/use-coding-agent-activity";
import { describeProgressLine, type ProgressDescription, type ProgressLabelKey } from "@/lib/coding-agent-progress";

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
 *
 * CLICK TO EXPAND
 *
 * The owner asked to "click on the Coding Agent pill to expand and see live
 * work". Collapsed, the card is what it always was, except the newest
 * progress line is drawn as a chip (icon + a word in the owner's language)
 * instead of the harness's own text — "Screenshot", never
 * "mcp__clawbox__browser_screenshot". Expanded, it adds a live-work panel:
 * the last few steps as chips, the counters, and thumbnails of the newest
 * screenshots, each of which opens in the chat's full-size preview. A
 * finished run stays expandable: its steps are the record of what it did.
 *
 * Whether a card is expanded is local state, on purpose. ChatPopup keys each
 * card by run id and the hook drops its runs when the chat closes, so a card
 * lives exactly as long as "this run, while the chat is open" — the lifetime
 * the expanded flag should have. A Set in ChatPopup would carry the same
 * information one level up and need clearing on close by hand.
 */

const TONE = {
  running: { color: "#fcd34d", glyph: "🤖" },
  completed: { color: "#86efac", glyph: "✓" },
  failed: { color: "#fca5a5", glyph: "!" },
  stopped: { color: "#cbd5e1", glyph: "◼" },
} as const;

/** How each kind of step reads at a glance: tools blue, files green, commands mono. */
const CHIP_TONE: Record<ProgressDescription["kind"], React.CSSProperties> = {
  tool: { background: "rgba(96,165,250,0.14)", color: "#bfdbfe" },
  file: { background: "rgba(52,211,153,0.12)", color: "#a7f3d0" },
  command: { background: "rgba(0,0,0,0.35)", color: "rgba(255,255,255,0.75)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  text: { background: "transparent", color: "rgba(255,255,255,0.45)", paddingLeft: 0 },
};

export interface CodingAgentCardLabels {
  running: string;
  runningOwner: string;
  completed: string;
  failed: string;
  stopped: string;
  /** A "{n} agents" template. */
  agents?: string;
  /** Follows a count: "46k tokens". */
  tokensWord?: string;
  /** The expanded panel's heading. */
  liveWork?: string;
  /** The header's tooltip, by state. */
  showDetails?: string;
  hideDetails?: string;
  /** A "thinking · {n} tokens" template. */
  thinking?: string;
  /** Follow a count: "3 files touched", "12 turns". */
  filesTouched?: string;
  turns?: string;
  /** One word per describable step; a missing entry falls back to English. */
  steps?: Partial<Record<ProgressLabelKey, string>>;
}

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

/**
 * One step of the run as a chip. A button when it leads somewhere (the
 * Screenshot chip opens the picture), a plain span otherwise. Either way a
 * click must not bubble to the card, which would toggle it.
 */
function StepChip({ step, label, onClick, title }: {
  step: ProgressDescription;
  label: string;
  onClick?: () => void;
  title?: string;
}) {
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    padding: "1px 7px",
    borderRadius: 6,
    fontSize: 11,
    lineHeight: "16px",
    border: 0,
    font: "inherit",
    ...CHIP_TONE[step.kind],
  };
  const inner = (
    <>
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13, flexShrink: 0 }}>{step.icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {step.detail ? (
        <span style={{ opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.detail}</span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        title={title}
        style={{ ...style, cursor: "zoom-in" }}
      >
        {inner}
      </button>
    );
  }
  return <span data-kind={step.kind} title={title} style={style}>{inner}</span>;
}

export default function CodingAgentActivityPill(
  { run, labels, openLabel, onOpen, onPreview }: {
    run: CodingAgentActivity;
    /**
     * One per status, plus the owner-started variant of "running", plus the
     * counted words for the meta line and the live-work panel's copy.
     */
    labels: CodingAgentCardLabels;
    openLabel: string;
    onOpen?: () => void;
    /**
     * Open a screenshot full-size. The chat owns the one preview portal
     * (ChatPopup's `preview`), so the card asks for it rather than drawing a
     * second lightbox. `alt` is the picture's accessible name.
     */
    onPreview?: (src: string, alt: string) => void;
  },
) {
  const live = run.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

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
  const thinking = run.thinkingTokens ?? 0;
  const progress = run.progress ?? [];
  const screenshots = run.screenshots ?? [];
  const newestShot = screenshots.length > 0 ? screenshots[screenshots.length - 1] : null;
  const lastStep = progress.length > 0 ? describeProgressLine(progress[progress.length - 1]) : null;

  const stepLabel = (step: ProgressDescription) =>
    (step.labelKey && labels.steps?.[step.labelKey]) || step.label;
  const preview = (name: string) => onPreview?.(artifactUrl(run.id, name), name);
  // The collapsed "Screenshot" chip opens the newest picture — the owner's
  // second ask. Only when there IS one: the chip can precede the file.
  const chipOpens = (step: ProgressDescription) =>
    step.labelKey === "screenshot" && newestShot && onPreview ? () => preview(newestShot) : undefined;

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

  // The expanded panel's counters. Turns only once there are any: the runner
  // learns the count from the final result event, so a live run has 0, and
  // "0 turns" beside a ticking clock reads as "stuck".
  const counters: string[] = [];
  if (used > 0 && labels.tokensWord) counters.push(`${tokens(used)} ${labels.tokensWord}`);
  if (thinking > 0 && labels.thinking) counters.push(labels.thinking.replaceAll("{n}", tokens(thinking)));
  if (labels.filesTouched) counters.push(`${run.filesTouched ?? 0} ${labels.filesTouched}`);
  if ((run.numTurns ?? 0) > 0 && labels.turns) counters.push(`${run.numTurns} ${labels.turns}`);

  return (
    <div
      data-testid="coding-agent-activity"
      data-status={run.status}
      data-expanded={expanded ? "true" : "false"}
      role="status"
      // The elapsed time re-renders every second. Inside a polite live region
      // that makes a screen reader announce the whole card on every tick for
      // as long as the run lasts. The status text is what is worth announcing;
      // the clock is marked aria-hidden above.
      aria-live={live ? "polite" : "off"}
      // The whole card is the control, as asked. Anything inside that does
      // its own thing (the open link, a chip, a thumbnail) stops the click
      // here so it does not also toggle — and so does the expanded panel as
      // a whole, which is for reading, not pressing.
      onClick={toggle}
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
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* role=button on a div rather than a <button>: a native button
            would turn Enter/Space into a second click on top of the
            keydown handler, and could not hold the open link beside it
            (a button inside a button is invalid). Its name is the title;
            aria-expanded carries the state and the tooltip says what a
            press does. Mouse clicks reach the card's own handler. */}
        <div
          data-testid="coding-agent-activity-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          title={expanded ? labels.hideDetails : labels.showDetails}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            toggle();
          }}
          style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, outlineOffset: 2 }}
        >
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
          <span
            className="material-symbols-rounded"
            aria-hidden="true"
            style={{ fontSize: 16, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}
          >
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </div>
        {onOpen ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
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
      {live && !expanded && lastStep ? (
        // What the run is doing RIGHT NOW, off the record's newest progress
        // line. Only while live: a finished card reports the outcome, not its
        // last step. aria-live=off, not aria-hidden — the chip can be a
        // button, and a focusable thing hidden from the tree is a trap — so a
        // line that changes every few seconds is not narrated each time.
        <div data-testid="coding-agent-activity-progress" aria-live="off" style={{ display: "flex", minWidth: 0 }}>
          <StepChip
            step={lastStep}
            label={stepLabel(lastStep)}
            onClick={chipOpens(lastStep)}
            title={lastStep.kind === "text" ? firstLine(lastStep.label, 200) : undefined}
          />
        </div>
      ) : null}
      {expanded ? (
        // The live-work panel. Its own (silent) live region for the same
        // reason as the chip above: the list moves every few seconds.
        //
        // Clicks stop here. The owner opened this panel to read it: a click
        // on a step to see it whole, on the counters, on the gap between two
        // thumbnails, or the mouse-up that ends selecting a command to copy
        // all landed on the card's handler and collapsed the panel under
        // them. The cursor below says the panel is not a control; this makes
        // that true.
        <div
          data-testid="coding-agent-activity-details"
          aria-live="off"
          onClick={(e) => e.stopPropagation()}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 2,
            paddingTop: 6,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            cursor: "default",
          }}
        >
          {labels.liveWork ? (
            <div style={{ fontSize: 10.5, letterSpacing: 0.4, textTransform: "uppercase", color: "rgba(255,255,255,0.4)" }}>
              {labels.liveWork}
            </div>
          ) : null}
          {progress.length > 0 ? (
            <ol
              data-testid="coding-agent-activity-steps"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}
            >
              {progress.map((line, i) => {
                const step = describeProgressLine(line);
                return (
                  <li key={`${i}:${line}`} style={{ display: "flex", minWidth: 0 }}>
                    <StepChip
                      step={step}
                      label={stepLabel(step)}
                      onClick={chipOpens(step)}
                      title={step.kind === "text" ? firstLine(step.label, 200) : undefined}
                    />
                  </li>
                );
              })}
            </ol>
          ) : null}
          {counters.length > 0 ? (
            <div
              data-testid="coding-agent-activity-counters"
              style={{ display: "flex", flexWrap: "wrap", columnGap: 6, rowGap: 2, color: "rgba(255,255,255,0.5)", fontSize: 11 }}
            >
              {counters.map((c, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {i > 0 ? <span aria-hidden="true">·</span> : null}
                  {c}
                </span>
              ))}
            </div>
          ) : null}
          {screenshots.length > 0 ? (
            // The newest screenshots, oldest first so the last one — the
            // state of the page now — is on the right. Each opens full-size
            // in the chat's preview; the file name is the picture's name.
            <div data-testid="coding-agent-activity-screenshots" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {screenshots.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); preview(name); }}
                  title={name}
                  style={{ padding: 0, border: 0, background: "none", cursor: "zoom-in", lineHeight: 0, borderRadius: 8 }}
                >
                  {/* Sized by the strip, not the file: a run's screenshots are
                      full pages, and the strip is a row of thumbnails. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- a device-served file behind cookie auth, not an optimizable asset */}
                  <img
                    src={artifactUrl(run.id, name)}
                    alt={name}
                    loading="lazy"
                    style={{ height: 64, width: 96, objectFit: "cover", objectPosition: "top", borderRadius: 8, display: "block", border: "1px solid rgba(255,255,255,0.1)" }}
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
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
