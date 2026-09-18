"use client";

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import {
  PROGRESS_CARD_COLLAPSED_KEY,
  progressCardAge,
  progressCardCounts,
  progressCardCurrentStep,
  readProgressCardCollapsed,
  writeProgressCardCollapsed,
  type ProgressCard,
  type ProgressStepStatus,
} from "@/lib/chat-progress-card";
import {
  parseProgressMarkdown,
  progressInlineText,
  type ProgressBar,
  type ProgressBlock,
  type ProgressInline,
} from "@/lib/progress-card-markdown";

// ── The agent's "Task progress" card, pinned over the composer (TASK-896) ────
//
// The OpenClaw Control UI keeps the session's progress card — the one the agent
// maintains with its `progress_card` tool — in a collapsible surface inside the
// composer. The ClawBox chat showed nothing of it, so an owner chatting here
// never saw what the agent was working on. This is that surface: a header row
// that is also the fold toggle (title, "Updated N ago", the step the agent is
// on, the done/total count), and under it the note — Markdown parsed by
// `progress-card-markdown.ts` into React elements, never HTML — and the plan.
//
// It sits IN the column between the transcript and the composer, never over
// either: the transcript is the flex child that gives up the height, and the
// body is capped (the Control UI's 300px, tighter on a short or narrow screen —
// see CARD_CSS) and scrolls inside itself, so a long card cannot push the text
// box away.
// Folding it is remembered in localStorage and shared by both chat surfaces.

const CARD_BORDER = "1px solid rgba(249,115,22,0.24)";
const CARD_BG = "rgba(249,115,22,0.06)";
const TITLE_FG = "#fed7aa";
const BODY_FG = "rgba(255,255,255,0.82)";
const MUTED_FG = "rgba(255,255,255,0.5)";
const HAIRLINE = "rgba(255,255,255,0.1)";
const CORAL = "#f97316";
const DONE_GREEN = "#22c55e";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** How often "Updated N ago" is re-read while the card is on screen. */
const AGE_TICK_MS = 30_000;

// The body's ceiling: the Control UI's 300px, but never more than about a
// third of the screen — the chat panel is shorter than the window, and on a
// short screen (a laptop browser, a phone with its keyboard up) the transcript
// has to keep most of the height. Anything taller scrolls inside the card.
const CARD_CSS = `
.chat-progress-body { max-height: min(300px, 34dvh); }
@media (max-height: 760px) { .chat-progress-body { max-height: min(220px, 28dvh); } }
@media (max-width: 640px) { .chat-progress-body { max-height: min(240px, 30dvh); } }
@keyframes chat-progress-spin { to { transform: rotate(360deg) } }
@keyframes chat-progress-sweep { 0% { transform: translateX(-100%) } 100% { transform: translateX(250%) } }
.chat-progress-spinner { animation: chat-progress-spin 0.9s linear infinite; }
.chat-progress-indeterminate { animation: chat-progress-sweep 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .chat-progress-spinner { animation: none; }
  .chat-progress-indeterminate { animation: none; transform: translateX(75%); }
}
.chat-progress-body a:focus-visible, .chat-progress-toggle:focus-visible { outline: 2px solid ${CORAL}; outline-offset: 2px; }
`;

export function ChatProgressCard({ card }: { card: ProgressCard }) {
  const { t, locale } = useT();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(() => readProgressCardCollapsed());
  const [now, setNow] = useState(() => Date.now());

  // A second chat surface (the popup and the full page in two tabs) folding the card folds this one.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROGRESS_CARD_COLLAPSED_KEY) setCollapsed(event.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // "Updated 2h ago" has to keep counting while nothing new arrives; a new
  // revision re-reads the clock at once so it never says "5m ago" for a write
  // that just landed.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, AGE_TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [card.revision, card.updatedAt]);

  const blocks = useMemo(() => parseProgressMarkdown(card.markdown), [card.markdown]);
  const { done, total } = progressCardCounts(card);
  const current = progressCardCurrentStep(card);
  const summary = current?.step ?? firstLine(blocks);

  // Everything the agent wrote was stripped (a note of nothing but raw HTML): nothing left to show.
  if (blocks.length === 0 && card.steps.length === 0) return null;

  const age = progressCardAge(card.updatedAt, now);
  const agoText = age === null
    ? null
    : age.unit === "now"
      ? t("chat.progressCard.justNow")
      : age.unit === "minutes"
        ? t("chat.progressCard.minutesAgo", { n: age.n })
        : age.unit === "hours"
          ? t("chat.progressCard.hoursAgo", { n: age.n })
          : t("chat.progressCard.daysAgo", { n: age.n });
  const updatedIso = card.updatedAt !== null ? new Date(card.updatedAt).toISOString() : undefined;
  const updatedFull = card.updatedAt !== null ? formatLocalTime(card.updatedAt, locale) : undefined;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeProgressCardCollapsed(next);
  };

  const statusLabel = (status: ProgressStepStatus) =>
    status === "completed"
      ? t("chat.progressCard.status.completed")
      : status === "in_progress"
        ? t("chat.progressCard.status.inProgress")
        : t("chat.progressCard.status.pending");

  return (
    <section
      data-testid="chat-progress-card"
      data-collapsed={collapsed ? "true" : "false"}
      data-revision={card.revision}
      aria-label={t("chat.progressCard.title")}
      style={{ padding: "8px 12px 0", background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}
    >
      <style>{CARD_CSS}</style>
      <div style={{ border: CARD_BORDER, background: CARD_BG, borderRadius: 10, overflow: "hidden" }}>
        <button
          type="button"
          className="chat-progress-toggle"
          data-testid="chat-progress-card-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          title={collapsed ? t("chat.progressCard.expand") : t("chat.progressCard.collapse")}
          onClick={toggle}
          style={{
            width: "100%", minHeight: 36, display: "flex", alignItems: "center", gap: 8,
            padding: "6px 10px", border: "none", background: "none", cursor: "pointer",
            color: BODY_FG, fontFamily: "inherit", fontSize: 12.5, textAlign: "left",
          }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 17, color: CORAL, flexShrink: 0 }}>
            checklist
          </span>
          <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6, overflow: "hidden", whiteSpace: "nowrap" }}>
            <span data-testid="chat-progress-card-title" style={{ fontWeight: 600, color: TITLE_FG, flexShrink: 0 }}>
              {t("chat.progressCard.title")}
            </span>
            {agoText !== null && (
              <>
                <span aria-hidden="true" style={{ color: MUTED_FG, flexShrink: 0 }}>·</span>
                <time
                  data-testid="chat-progress-card-updated"
                  dateTime={updatedIso}
                  title={updatedFull}
                  style={{ color: MUTED_FG, fontSize: 11.5, flexShrink: 0 }}
                >
                  {t("chat.progressCard.updated", { ago: agoText })}
                </time>
              </>
            )}
            {summary && (
              <>
                <span aria-hidden="true" style={{ color: MUTED_FG, flexShrink: 0 }}>·</span>
                <span
                  data-testid="chat-progress-card-summary"
                  style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: "rgba(255,255,255,0.72)" }}
                >
                  {summary}
                </span>
              </>
            )}
          </span>
          {total > 0 && (
            <span
              data-testid="chat-progress-card-count"
              aria-label={t("chat.progressCard.count", { done, total })}
              style={{
                flexShrink: 0, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                padding: "1px 7px", borderRadius: 999,
                color: done === total ? DONE_GREEN : TITLE_FG,
                background: done === total ? "rgba(34,197,94,0.12)" : "rgba(249,115,22,0.14)",
              }}
            >
              {done}/{total}
            </span>
          )}
          <span
            className="material-symbols-rounded"
            aria-hidden="true"
            style={{ fontSize: 18, color: MUTED_FG, flexShrink: 0, transition: "transform 120ms ease", transform: collapsed ? "none" : "rotate(180deg)" }}
          >
            expand_more
          </span>
        </button>
        {!collapsed && (
          <div
            id={bodyId}
            className="chat-progress-body"
            data-testid="chat-progress-card-body"
            style={{
              overflowY: "auto", overscrollBehavior: "contain", padding: "2px 12px 10px",
              borderTop: "1px solid rgba(249,115,22,0.14)", color: BODY_FG, fontSize: 12.5, lineHeight: 1.5,
              wordBreak: "break-word", scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent",
            }}
          >
            {blocks.length > 0 && (
              <div data-testid="chat-progress-card-markdown">
                <ProgressBlocks blocks={blocks} statusLabel={statusLabel} barLabel={t("chat.progressCard.bar")} locale={locale} />
              </div>
            )}
            {card.steps.length > 0 && (
              <ol
                data-testid="chat-progress-card-plan"
                aria-label={t("chat.progressCard.plan")}
                style={{ listStyle: "none", margin: blocks.length > 0 ? "8px 0 0" : "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}
              >
                {card.steps.map((step, index) => (
                  <li
                    key={index}
                    data-testid="chat-progress-step"
                    data-status={step.status}
                    aria-current={step.status === "in_progress" ? "step" : undefined}
                    style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
                  >
                    <StepIcon status={step.status} />
                    <span
                      data-testid="chat-progress-step-text"
                      style={{
                        flex: 1, minWidth: 0,
                        color: step.status === "completed" ? MUTED_FG : step.status === "in_progress" ? "#fff" : BODY_FG,
                        fontWeight: step.status === "in_progress" ? 600 : 400,
                      }}
                    >
                      <span className="sr-only">{statusLabel(step.status)}: </span>
                      {step.step}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function StepIcon({ status }: { status: ProgressStepStatus }) {
  const box: CSSProperties = { width: 18, height: 19, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" };
  if (status === "in_progress") {
    return (
      <span aria-hidden="true" style={box}>
        <span
          className="chat-progress-spinner"
          style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid rgba(249,115,22,0.25)", borderTopColor: CORAL, boxSizing: "border-box" }}
        />
      </span>
    );
  }
  return (
    <span
      className="material-symbols-rounded"
      aria-hidden="true"
      style={{
        ...box, fontSize: 16,
        color: status === "completed" ? DONE_GREEN : "rgba(255,255,255,0.35)",
        fontVariationSettings: status === "completed" ? "'FILL' 1" : undefined,
      }}
    >
      {status === "completed" ? "check_circle" : "radio_button_unchecked"}
    </span>
  );
}

/** The first thing the note says, for the header when there is no plan step to name. */
function firstLine(blocks: ProgressBlock[]): string | null {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      const text = progressInlineText(block.children);
      if (text) return text;
    } else if (block.type === "progress" && block.label) {
      return block.label;
    }
  }
  return null;
}

function formatLocalTime(ms: number, locale: string): string | undefined {
  try {
    return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return undefined;
  }
}

// ── The note ────────────────────────────────────────────────────────────────

interface BlockProps {
  statusLabel: (status: ProgressStepStatus) => string;
  barLabel: string;
  locale: string;
}

function ProgressBlocks({ blocks, ...props }: { blocks: ProgressBlock[] } & BlockProps) {
  return <>{blocks.map((block, index) => <Block key={index} block={block} {...props} />)}</>;
}

function Block({ block, ...props }: { block: ProgressBlock } & BlockProps) {
  switch (block.type) {
    case "paragraph":
      return <p style={{ margin: "6px 0" }}><Inlines nodes={block.children} {...props} /></p>;
    case "heading":
      return (
        <div
          role="heading"
          aria-level={Math.min(6, block.level + 2)}
          style={{ margin: "8px 0 4px", fontWeight: 600, color: "#fff", fontSize: block.level <= 2 ? 13.5 : 12.5 }}
        >
          <Inlines nodes={block.children} {...props} />
        </div>
      );
    case "rule":
      return <hr style={{ border: "none", borderTop: `1px solid ${HAIRLINE}`, margin: "8px 0" }} />;
    case "code":
      return (
        <pre style={{ margin: "6px 0", padding: "6px 8px", borderRadius: 6, background: "rgba(0,0,0,0.3)", overflowX: "auto", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.45, whiteSpace: "pre" }}>
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote style={{ margin: "6px 0", paddingLeft: 8, borderLeft: "2px solid rgba(255,255,255,0.18)", color: "rgba(255,255,255,0.65)" }}>
          <ProgressBlocks blocks={block.children} {...props} />
        </blockquote>
      );
    case "progress":
      return <ProgressBarView bar={block} fallbackLabel={props.barLabel} locale={props.locale} />;
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      const allTasks = block.items.every((item) => item.checked !== null);
      return (
        <ListTag
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          style={{ margin: "6px 0", paddingLeft: allTasks ? 2 : 18, listStyle: allTasks ? "none" : undefined }}
        >
          {block.items.map((item, index) => (
            <li key={index} style={{ margin: `2px 0 2px ${item.depth * 14}px`, listStyle: item.checked !== null ? "none" : undefined }}>
              {item.checked !== null && (
                <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 4 }}>
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15, color: item.checked ? DONE_GREEN : "rgba(255,255,255,0.4)" }}>
                    {item.checked ? "check_box" : "check_box_outline_blank"}
                  </span>
                  <span className="sr-only">{props.statusLabel(item.checked ? "completed" : "pending")}: </span>
                </span>
              )}
              <Inlines nodes={item.children} {...props} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div data-testid="chat-progress-card-table" style={{ margin: "6px 0", overflowX: "auto", maxWidth: "100%" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    key={c}
                    scope="col"
                    style={{
                      textAlign: block.align[c] ?? "left", padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.16)",
                      color: "rgba(255,255,255,0.6)", fontWeight: 600, fontSize: 11, letterSpacing: "0.03em", whiteSpace: "nowrap",
                    }}
                  >
                    <Inlines nodes={cell} {...props} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? "left", padding: "4px 8px", borderBottom: `1px solid ${HAIRLINE}`, verticalAlign: "top" }}>
                      <Inlines nodes={cell} {...props} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Inlines({ nodes, ...props }: { nodes: ProgressInline[] } & BlockProps): ReactNode {
  return <>{nodes.map((node, index) => <Inline key={index} node={node} {...props} />)}</>;
}

function Inline({ node, ...props }: { node: ProgressInline } & BlockProps): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "break":
      return <br />;
    case "strong":
      return <strong style={{ fontWeight: 600, color: "#fff" }}><Inlines nodes={node.children} {...props} /></strong>;
    case "em":
      return <em><Inlines nodes={node.children} {...props} /></em>;
    case "del":
      return <del style={{ color: MUTED_FG }}><Inlines nodes={node.children} {...props} /></del>;
    case "code":
      return (
        <code style={{ fontFamily: MONO, fontSize: "0.92em", padding: "1px 4px", borderRadius: 4, background: "rgba(255,255,255,0.08)" }}>
          {node.text}
        </code>
      );
    case "link":
      // `href` is the sanitiser's own output: http(s) or mailto, nothing else reaches here.
      return (
        <a href={node.href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "#fdba74", textDecoration: "underline", textUnderlineOffset: 2 }}>
          <Inlines nodes={node.children} {...props} />
        </a>
      );
    case "progress":
      return <ProgressBarView bar={node} fallbackLabel={props.barLabel} locale={props.locale} inline />;
  }
}

function formatPercent(fraction: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(fraction);
  } catch {
    return `${Math.round(fraction * 100)}%`;
  }
}

/**
 * A `<progress>` from the note, drawn as a bar the chat styles itself (the
 * native element looks different in every engine). Its `aria-label` is shown as
 * the bar's caption, the way the Control UI pins it above the note.
 */
function ProgressBarView({ bar, fallbackLabel, locale, inline = false }: { bar: ProgressBar; fallbackLabel: string; locale: string; inline?: boolean }) {
  const fraction = bar.value === null ? null : bar.max > 0 ? bar.value / bar.max : 0;
  const percent = fraction === null ? null : formatPercent(fraction, locale);
  const track = (
    <span
      role="progressbar"
      aria-label={bar.label ?? fallbackLabel}
      aria-valuemin={0}
      aria-valuemax={bar.max}
      aria-valuenow={bar.value ?? undefined}
      aria-valuetext={percent ?? undefined}
      data-testid="chat-progress-bar"
      style={{
        position: "relative", display: "block", overflow: "hidden", borderRadius: 999,
        height: inline ? 6 : 7, background: "rgba(255,255,255,0.1)",
        width: inline ? 88 : "100%", flexShrink: 0,
      }}
    >
      <span
        className={fraction === null ? "chat-progress-indeterminate" : undefined}
        style={{
          position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 999,
          width: fraction === null ? "40%" : `${Math.max(0, Math.min(1, fraction)) * 100}%`,
          background: fraction !== null && fraction >= 1 ? DONE_GREEN : `linear-gradient(90deg, ${CORAL}, #fb923c)`,
          transition: "width 240ms ease",
        }}
      />
    </span>
  );
  if (inline) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
        {track}
        {percent && <span aria-hidden="true" style={{ fontSize: 11, color: MUTED_FG, fontVariantNumeric: "tabular-nums" }}>{percent}</span>}
      </span>
    );
  }
  return (
    <div style={{ margin: "8px 0" }}>
      {(bar.label || percent) && (
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4, fontSize: 11.5 }}>
          <span style={{ color: BODY_FG, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bar.label}</span>
          {percent && <span style={{ color: MUTED_FG, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{percent}</span>}
        </div>
      )}
      {track}
    </div>
  );
}
