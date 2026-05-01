import { useCallback, useState } from "react";

// The OpenClaw gateway broadcasts tool-call lifecycle as `event: 'agent'`
// with `stream: 'tool'`; payload `data.phase` is `start | update | result`.

export interface ChatToolCall {
  id: string;
  name: string;
  prettyName: string;
  phase: "running" | "done";
  startedAt: number;
}

function prettifyToolName(raw: string): string {
  if (!raw) return "tool";
  const stripped = raw.replace(/^[a-z0-9-]+__/i, "");
  const cleaned = stripped.replace(/[_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : raw;
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

export function ToolCallPills({ toolCalls, runningLabel }: { toolCalls: ChatToolCall[]; runningLabel: string }) {
  if (toolCalls.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      {toolCalls.map((tc) => {
        const done = tc.phase === "done";
        return (
          <div
            key={tc.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              background: done ? DONE_BG : RUNNING_BG,
              color: done ? DONE_FG : RUNNING_FG,
              border: done ? DONE_BORDER : RUNNING_BORDER,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <span aria-hidden="true">{done ? "✓" : "🔧"}</span>
            <span>{tc.prettyName}</span>
            {!done && <span style={{ opacity: 0.7 }}>· {runningLabel}</span>}
          </div>
        );
      })}
    </div>
  );
}
