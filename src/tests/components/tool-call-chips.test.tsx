import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@/tests/helpers/test-utils";
import {
  groupConsecutiveBy,
  prettifyToolName,
  toolBrand,
  ToolCallPills,
  ToolCallSummaryChips,
  type ChatToolCall,
} from "@/lib/chat-tool-events";
import type { ChatToolSummary } from "@/lib/chat-history-cache";

function call(id: string, name: string, phase: "running" | "done" = "done"): ChatToolCall {
  return { id, name, prettyName: name, phase, startedAt: 0 };
}

describe("groupConsecutiveBy", () => {
  it("collapses only ADJACENT repeats, preserving run order", () => {
    const groups = groupConsecutiveBy(
      ["gateway", "gateway", "exec", "gateway"],
      (s) => s,
    );
    expect(groups).toEqual([["gateway", "gateway"], ["exec"], ["gateway"]]);
  });
});

describe("ToolCallPills", () => {
  it("renders a consecutive run of the same tool as one counted pill", () => {
    const { container } = render(
      <ToolCallPills
        toolCalls={[
          call("1", "gateway"),
          call("2", "gateway"),
          call("3", "gateway"),
          call("4", "exec"),
        ]}
        runningLabel="Running"
      />,
    );
    expect(container.textContent).toContain("gateway (3)");
    expect(container.textContent).not.toContain("gateway (1)");
    // exec ran once — no count suffix.
    expect(container.textContent).toContain("exec");
    expect(container.textContent).not.toContain("exec (");
  });

  it("keeps a still-running call inside its group as one running pill", () => {
    const { container } = render(
      <ToolCallPills
        toolCalls={[call("1", "gateway"), call("2", "gateway", "running")]}
        runningLabel="Running"
      />,
    );
    expect(container.textContent).toContain("gateway (2)");
    expect(container.textContent).toContain("Running");
  });

  it("does not collapse the same tool across a different one in between", () => {
    const { container } = render(
      <ToolCallPills
        toolCalls={[call("1", "gateway"), call("2", "exec"), call("3", "gateway")]}
        runningLabel="Running"
      />,
    );
    // Two separate gateway pills, neither counted.
    expect(container.textContent).not.toContain("(2)");
  });
});

describe("ToolCallSummaryChips", () => {
  it("rests collapsed behind the counted line, and opens on a click", () => {
    const toolCalls: ChatToolSummary[] = [
      { name: "gateway", detail: "GET /a" },
      { name: "gateway", detail: "GET /b" },
    ];
    const { container } = render(
      <ToolCallSummaryChips toolCalls={toolCalls} label="steps" ranLabel="Ran 2 commands" />,
    );
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-tool-summary-toggle"]');
    expect(toggle?.textContent).toContain("Ran 2 commands");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // The step record is a click away, not on screen.
    expect(container.textContent).not.toContain("gateway");
    if (toggle) fireEvent.click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("gateway (2)");
    const chip = container.querySelector("div[title]");
    expect(chip?.getAttribute("title")).toBe("gateway: GET /a\ngateway: GET /b");
  });

  it("opens itself when any call failed, and never hides the failure in a collapsed run", () => {
    const toolCalls: ChatToolSummary[] = [
      { name: "gateway" },
      { name: "gateway", status: "error" },
      { name: "gateway" },
    ];
    const { container } = render(
      <ToolCallSummaryChips toolCalls={toolCalls} label="steps" ranLabel="Ran 3 commands" />,
    );
    // A failure is not something to fold away: the record starts open …
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-tool-summary-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // … and the failed call stands alone: ok, failed, ok — no counts anywhere.
    expect(container.textContent).not.toContain("(");
    expect(container.textContent).toContain("!");
  });
});

describe("the box's knowledge tools carry their app's name and mark", () => {
  it.each([
    ["wiki_status", "Prime Radiant Status"],
    ["wiki_search", "Prime Radiant Search"],
    ["wiki_get", "Prime Radiant Page"],
    ["memory_search", "Memory Shard Search"],
    ["memory_get", "Memory Shard Read"],
    ["openclaw__wiki_search", "Prime Radiant Search"],
  ])("names %s as %s", (name, label) => {
    expect(prettifyToolName(name)).toBe(label);
  });

  it("leaves every other tool as it was", () => {
    expect(prettifyToolName("exec")).toBe("exec");
    expect(prettifyToolName("web_search")).toBe("web search");
    expect(prettifyToolName("constructor")).toBe("constructor");
    expect(toolBrand("exec")).toBeNull();
    expect(toolBrand("toString")).toBeNull();
  });

  it("draws the tesseract on a Prime Radiant row and the shard on a Memory Shard row, live and replayed", () => {
    const live = render(
      <ToolCallPills
        toolCalls={[
          { id: "1", name: "wiki_search", prettyName: prettifyToolName("wiki_search"), phase: "done", startedAt: 0 },
          { id: "2", name: "wiki_search", prettyName: prettifyToolName("wiki_search"), phase: "done", startedAt: 0 },
          { id: "3", name: "memory_search", prettyName: prettifyToolName("memory_search"), phase: "done", startedAt: 0 },
          { id: "4", name: "exec", prettyName: "exec", phase: "done", startedAt: 0 },
        ]}
        runningLabel="Running"
      />,
    );
    expect(live.container.textContent).toContain("Prime Radiant Search (2)");
    expect(live.container.textContent).toContain("Memory Shard Search");
    expect(live.container.querySelectorAll("[data-testid=prime-radiant-icon]")).toHaveLength(1);
    expect(live.container.querySelectorAll("[data-testid=memory-shard-mark]")).toHaveLength(1);
    live.unmount();

    const replay = render(
      <ToolCallSummaryChips
        toolCalls={[
          { name: "wiki_status", status: "ok" } as ChatToolSummary,
          { name: "memory_search", status: "ok" } as ChatToolSummary,
        ]}
        label="Steps"
      />,
    );
    fireEvent.click(replay.getByTestId("chat-tool-summary-toggle"));
    expect(replay.container.textContent).toContain("Prime Radiant Status");
    expect(replay.container.querySelectorAll("[data-testid=prime-radiant-icon]")).toHaveLength(1);
    expect(replay.container.querySelectorAll("[data-testid=memory-shard-mark]")).toHaveLength(1);
  });
});
