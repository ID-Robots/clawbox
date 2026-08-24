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

const RUNNING_BG = "rgba(249,115,22,0.12)";
const RUNNING_BORDER = "1px solid rgba(249,115,22,0.25)";
const RUNNING_FG = "#fdba74";
const DONE_BG = "rgba(34,197,94,0.12)";
const DONE_BORDER = "1px solid rgba(34,197,94,0.25)";
const DONE_FG = "#86efac";
// A step that came back with a failure. Same pill, the palette the chat already
// uses for an error banner — so "it ran" and "it went wrong" are one glance
// apart instead of looking identical.
const FAILED_BG = "rgba(239,68,68,0.12)";
const FAILED_BORDER = "1px solid rgba(239,68,68,0.25)";
const FAILED_FG = "#fca5a5";

type ChipTone = "running" | "done" | "failed";

const CHIP_TONE: Record<ChipTone, { background: string; border: string; color: string }> = {
  running: { background: RUNNING_BG, border: RUNNING_BORDER, color: RUNNING_FG },
  done: { background: DONE_BG, border: DONE_BORDER, color: DONE_FG },
  failed: { background: FAILED_BG, border: FAILED_BORDER, color: FAILED_FG },
};

const CHIP_GLYPH: Record<ChipTone, string> = { running: "🔧", done: "✓", failed: "!" };

/**
 * One pill.
 *
 * Extracted so the LIVE pill and the REPLAYED chip are the same element rather
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
        padding: "4px 10px",
        borderRadius: 999,
        ...CHIP_TONE[tone],
        fontSize: 12,
        fontWeight: 500,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true">{CHIP_GLYPH[tone]}</span>
      <span>{label}</span>
      {suffix ? <span style={{ opacity: 0.7 }}>· {suffix}</span> : null}
    </div>
  );
}

export function ToolCallPills({ toolCalls, runningLabel }: { toolCalls: ChatToolCall[]; runningLabel: string }) {
  if (toolCalls.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      {toolCalls.map((tc) => {
        const done = tc.phase === "done";
        return (
          <ToolChip
            key={tc.id}
            tone={done ? "done" : "running"}
            label={tc.prettyName}
            {...(done ? {} : { suffix: runningLabel })}
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
 * The argument summary rides on `title` rather than in the pill: it is
 * model-authored text of unpredictable length, and a chip row that reflows to
 * three lines because one command was long stops reading as a row of steps.
 */
export function ToolCallSummaryChips(
  { toolCalls, label }: { toolCalls: ChatToolSummary[]; label: string },
) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div
      data-testid="chat-tool-summary"
      aria-label={label}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "flex-start",
        marginTop: 8,
      }}
    >
      {toolCalls.map((call, index) => (
        <ToolChip
          key={`${call.name}-${index}`}
          tone={call.status === "error" ? "failed" : "done"}
          label={prettifyToolName(call.name)}
          {...(call.detail ? { title: `${call.name}: ${call.detail}` } : { title: call.name })}
        />
      ))}
    </div>
  );
}
