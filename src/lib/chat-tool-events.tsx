import { useCallback, useState } from "react";
import type { ChatToolSummary } from "@/lib/chat-history-cache";

// The OpenClaw gateway broadcasts tool-call lifecycle as `event: 'agent'`
// with `stream: 'tool'`; payload `data.phase` is `start | update | result`.

export interface ChatToolCall {
  id: string;
  name: string;
  prettyName: string;
  phase: "running" | "done";
  startedAt: number;
}

// An MCP server prefixes its tools with its own name: `server__tool`. Stripping
// it is what makes both readers below look at the TOOL, not the server it came
// from — without it a server called `image-gen` would make every one of its
// tools look like image generation.
const TOOL_SERVER_PREFIX_RE = /^[a-z0-9-]+__/i;

function prettifyToolName(raw: string): string {
  if (!raw) return "tool";
  const stripped = raw.replace(TOOL_SERVER_PREFIX_RE, "");
  const cleaned = stripped.replace(/[_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : raw;
}

/**
 * True if `raw` names the harness' image-generation tool.
 *
 * Matched loosely (both words, either order, with or without a server prefix)
 * because the name reaches us straight off the wire: `image_generate` today,
 * but `mcp__x__generate_image` or `image_generation` are the same event as far
 * as the chat is concerned.
 */
export function isImageGenerationTool(raw: string): boolean {
  const name = raw.replace(TOOL_SERVER_PREFIX_RE, "").toLowerCase();
  return name.includes("image") && name.includes("gen");
}

export function useChatToolCalls(): {
  toolCalls: ChatToolCall[];
  applyToolEvent: (data: Record<string, unknown> | undefined) => void;
  clearToolCalls: () => void;
} {
  const [toolCalls, setToolCalls] = useState<ChatToolCall[]>([]);

  const applyToolEvent = useCallback((data: Record<string, unknown> | undefined) => {
    if (!data) return;
    const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (!id) return;
    const name = typeof data.name === "string" && data.name.length > 0 ? data.name : "tool";
    const phase = typeof data.phase === "string" ? data.phase : "";
    setToolCalls((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (phase === "start") {
        if (idx === -1) {
          return [...prev, { id, name, prettyName: prettifyToolName(name), phase: "running", startedAt: Date.now() }];
        }
        const cur = prev[idx];
        if (cur.name === name && cur.phase === "running") return prev;
        const next = prev.slice();
        next[idx] = { ...cur, name, prettyName: cur.name === name ? cur.prettyName : prettifyToolName(name), phase: "running" };
        return next;
      }
      if (phase === "result") {
        if (idx === -1 || prev[idx].phase === "done") return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], phase: "done" };
        return next;
      }
      if (phase === "update" && idx !== -1 && prev[idx].name !== name) {
        const next = prev.slice();
        next[idx] = { ...next[idx], name, prettyName: prettifyToolName(name) };
        return next;
      }
      return prev;
    });
  }, []);

  const clearToolCalls = useCallback(() => {
    setToolCalls((prev) => (prev.length === 0 ? prev : []));
  }, []);

  return { toolCalls, applyToolEvent, clearToolCalls };
}

// ---------------------------------------------------------------------------
// Rendering. Restyled after the Claude Code web UI: while a turn runs, each
// step is a quiet text row rather than a colored pill; once the turn is done,
// the whole step record collapses behind one "Ran N commands" line. The three
// tones survive the restyle — "it ran", "it is running" and "it went wrong"
// must stay one glance apart — they just moved from pill backgrounds onto the
// glyph and the text itself.
// ---------------------------------------------------------------------------

const ROW_FG_RUNNING = "#fdba74";
const ROW_FG_DONE = "rgba(255,255,255,0.45)";
// The palette the chat already uses for an error banner — so "it ran" and
// "it went wrong" stay one glance apart.
const ROW_FG_FAILED = "#fca5a5";

type ChipTone = "running" | "done" | "failed";

const ROW_FG: Record<ChipTone, string> = {
  running: ROW_FG_RUNNING,
  done: ROW_FG_DONE,
  failed: ROW_FG_FAILED,
};

const CHIP_GLYPH: Record<ChipTone, string> = { running: "🔧", done: "✓", failed: "!" };

/**
 * One step row.
 *
 * Extracted so the LIVE row and the REPLAYED row are the same element rather
 * than two that merely look alike today: a turn must not change appearance the
 * moment the page is refreshed, and the only way to guarantee that is to render
 * both from here.
 */
function ToolChip(
  { tone, label, suffix, title }: { tone: ChipTone; label: string; suffix?: string; title?: string },
) {
  return (
    <div
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "1px 2px",
        color: ROW_FG[tone],
        fontSize: 12,
        fontWeight: 500,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true" style={{ width: 14, textAlign: "center", flexShrink: 0 }}>{CHIP_GLYPH[tone]}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {suffix ? <span style={{ opacity: 0.7, flexShrink: 0 }}>· {suffix}</span> : null}
    </div>
  );
}

/**
 * Collapse CONSECUTIVE runs of the same-looking chip into one group — seven
 * `gateway` calls in a row render as one `gateway (7)` chip, not a column of
 * seven identical pills. Only adjacent repeats collapse: a different tool
 * between two `gateway` calls keeps them apart, so the row still reads as the
 * order the steps ran in. Keyed on what the chip DISPLAYS (pretty name, and
 * for summaries the tone too), because two entries that render identically
 * are the ones that read as duplication.
 */
export function groupConsecutiveBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && key(last[0]) === key(item)) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

function countedLabel(label: string, count: number): string {
  return count > 1 ? `${label} (${count})` : label;
}

export function ToolCallPills({ toolCalls, runningLabel }: { toolCalls: ChatToolCall[]; runningLabel: string }) {
  if (toolCalls.length === 0) return null;
  const groups = groupConsecutiveBy(toolCalls, (tc) => tc.prettyName);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
      {groups.map((group) => {
        // The running call is always the group's newest member; a group with
        // one still in flight shows as running so the count keeps ticking up
        // on the same pill instead of spawning a second one.
        const running = group.some((tc) => tc.phase !== "done");
        return (
          <ToolChip
            // First member's id: stable while the group grows.
            key={group[0].id}
            tone={running ? "running" : "done"}
            label={countedLabel(group[0].prettyName, group.length)}
            {...(running ? { suffix: runningLabel } : {})}
          />
        );
      })}
    </div>
  );
}

/**
 * The steps a FINISHED turn took, as stored on the message.
 *
 * The live pills are cleared the moment a turn ends, so before this the only
 * record that the agent had run a browser or a shell was a sentence in the
 * reply. These persist — they come back with the transcript on a refresh, which
 * is the whole difference between an indicator and a record.
 *
 * Collapsed to one "Ran N commands" line by default: the record matters, the
 * screen space does not. It opens itself when any step FAILED — a failure is
 * not something to fold away — and the argument summary rides on `title`
 * rather than in the row, because it is model-authored text of unpredictable
 * length.
 */
export function ToolCallSummaryChips(
  { toolCalls, label, ranLabel }: {
    toolCalls: ChatToolSummary[];
    /** Accessible name for the whole record. */
    label: string;
    /** The collapsed line, already counted — e.g. "Ran 4 commands". */
    ranLabel?: string;
  },
) {
  // A failed step must be visible without a click.
  const [open, setOpen] = useState(() => (toolCalls ?? []).some((c) => c.status === "error"));
  if (!toolCalls || toolCalls.length === 0) return null;
  const anyFailed = toolCalls.some((c) => c.status === "error");
  return (
    <div data-testid="chat-tool-summary" aria-label={label} style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="chat-tool-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "none",
          border: 0,
          padding: "2px 4px",
          marginLeft: -4,
          borderRadius: 6,
          cursor: "pointer",
          font: "inherit",
          fontSize: 12,
          fontWeight: 500,
          color: anyFailed ? ROW_FG_FAILED : "rgba(255,255,255,0.5)",
        }}
      >
        <span>{ranLabel ?? countedLabel(label, toolCalls.length)}</span>
        <span
          aria-hidden="true"
          className="material-symbols-rounded"
          style={{
            fontSize: 14,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          chevron_right
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", marginTop: 2 }}>
          {groupConsecutiveBy(
            toolCalls,
            // Tone is part of the key: a failed call must never disappear into a
            // collapsed run of successes.
            (call) => `${prettifyToolName(call.name)} ${call.status === "error" ? "error" : "ok"}`,
          ).map((group, index) => (
            <ToolChip
              key={`${group[0].name}-${index}`}
              tone={group[0].status === "error" ? "failed" : "done"}
              label={countedLabel(prettifyToolName(group[0].name), group.length)}
              // Every collapsed call keeps its argument summary — one per line.
              title={group.map((call) => (call.detail ? `${call.name}: ${call.detail}` : call.name)).join("\n")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
