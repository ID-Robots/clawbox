import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@/tests/helpers/test-utils";
import {
  ToolCallPills,
  ToolCallSummaryChips,
  useChatToolCalls,
} from "@/lib/chat-tool-events";
import type { ChatToolSummary } from "@/lib/chat-history-cache";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

/**
 * The step rows for the box's own apps, as they are drawn: live from the tool
 * stream, and replayed from a finished turn's record.
 *
 * The live rows are fed exactly as the chat feeds them — through
 * `applyToolEvent`, with the gateway's `agent`/`tool` payload or the harness
 * adapter's `{ toolCallId, name, phase, detail }` — so a field the hook stops
 * reading fails here rather than on a box.
 */

let locale: Locale = "en";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale,
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => translations[locale][key] ?? key,
  }),
}));

beforeEach(() => {
  locale = "en";
});

function liveRows(events: Record<string, unknown>[]) {
  const hook = renderHook(() => useChatToolCalls());
  act(() => {
    for (const event of events) hook.result.current.applyToolEvent(event);
  });
  const view = render(<ToolCallPills toolCalls={hook.result.current.toolCalls} runningLabel="Running" />);
  return { hook, view };
}

describe("live step rows", () => {
  it("names an OpenClaw exec step that ran the memory CLI by its app, with the shard", () => {
    const { view } = liveRows([
      { toolCallId: "t1", name: "exec", phase: "start", args: { command: "timeout 60 openclaw memory search \"router vlan\" 2>&1 | head -40" } },
      { toolCallId: "t1", name: "exec", phase: "result" },
    ]);
    expect(view.container.textContent).toContain("Memory Shard Search");
    expect(view.container.textContent).not.toContain("exec");
    expect(view.container.querySelectorAll("[data-testid=memory-shard-mark]")).toHaveLength(1);
  });

  it("names a Claude CLI step by its app, whether it came through the MCP bridge or Bash, and leaves Grep alone", () => {
    const { view } = liveRows([
      { toolCallId: "c1", name: "mcp__openclaw__memory_search", phase: "start", args: { query: "router" } },
      { toolCallId: "c1", name: "mcp__openclaw__memory_search", phase: "result" },
      { toolCallId: "c2", name: "Grep", phase: "start", args: { pattern: "vlan" } },
      { toolCallId: "c2", name: "Grep", phase: "result" },
      { toolCallId: "c3", name: "Bash", phase: "start", args: { command: "openclaw wiki search alpha", description: "Search the wiki" } },
    ]);
    const rows = Array.from(view.container.querySelectorAll("div[style]")).map((row) => row.textContent);
    expect(view.container.textContent).toContain("Memory Shard Search");
    expect(view.container.textContent).not.toContain("openclaw memory search");
    expect(view.container.textContent).toContain("Grep");
    expect(view.container.textContent).toContain("Prime Radiant Search");
    // The still-running Bash step is its own row, and it says so.
    expect(rows.some((text) => text?.includes("Prime Radiant Search") && text.includes("Running") && !text.includes("Grep"))).toBe(true);
    expect(view.container.querySelectorAll("[data-testid=memory-shard-mark]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-testid=prime-radiant-icon]")).toHaveLength(1);
  });

  it("reads a Hermes terminal step's command from the adapter's detail", () => {
    const { view } = liveRows([
      { toolCallId: "h1", name: "terminal", phase: "start", detail: "openclaw wiki get entity.alpha" },
      { toolCallId: "h2", name: "mcp_clawbox_backup_status", phase: "start" },
    ]);
    expect(view.container.textContent).toContain("Prime Radiant Page");
    expect(view.container.textContent).toContain("ClawKeep Status");
    expect(view.container.querySelectorAll("[data-testid=prime-radiant-icon]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-testid=clawkeep-mark]")).toHaveLength(1);
  });

  it("relabels a step whose command arrives after its start", () => {
    const { hook, view } = liveRows([
      { toolCallId: "u1", name: "exec", phase: "start" },
    ]);
    expect(view.container.textContent).toContain("exec");
    act(() => {
      hook.result.current.applyToolEvent({ toolCallId: "u1", name: "exec", phase: "update", args: { command: "openclaw cron list" } });
    });
    expect(hook.result.current.toolCalls[0].prettyName).toBe("Automations List");
    // A result's own text is output, not the command — it never relabels.
    act(() => {
      hook.result.current.applyToolEvent({ toolCallId: "u1", name: "exec", phase: "result", detail: "openclaw memory status" });
    });
    expect(hook.result.current.toolCalls[0]).toMatchObject({ phase: "done", prettyName: "Automations List" });
  });

  it("collapses repeats of the same app step and keeps a different command apart", () => {
    const { view } = liveRows([
      { toolCallId: "a", name: "exec", phase: "start", args: { command: "openclaw memory search a" } },
      { toolCallId: "b", name: "exec", phase: "start", args: { command: "openclaw memory search b" } },
      { toolCallId: "c", name: "exec", phase: "start", args: { command: "ls -la" } },
    ]);
    expect(view.container.textContent).toContain("Memory Shard Search (2)");
    expect(view.container.textContent).toContain("exec");
  });

  it("leaves a plain shell step as the shell step it is", () => {
    const { view } = liveRows([
      { toolCallId: "p1", name: "exec", phase: "start", args: { command: "echo \"openclaw memory search\"" } },
    ]);
    expect(view.container.textContent).toContain("exec");
    expect(view.container.querySelector('[data-testid$="-mark"]')).toBeNull();
  });
});

describe("replayed step rows", () => {
  it("names a finished turn's box steps by their apps and keeps the raw command on hover", () => {
    const toolCalls: ChatToolSummary[] = [
      { name: "terminal", detail: "openclaw memory search \"meeting notes\"", status: "ok" },
      { name: "mcp_clawbox_memory_shard_status", status: "ok" },
      { name: "terminal", detail: "uname -sr", status: "ok" },
      { name: "image_generate", detail: "a crab on a desk", status: "ok" },
      { name: "cronjob_manage", status: "error" },
    ];
    const view = render(<ToolCallSummaryChips toolCalls={toolCalls} label="Steps" ranLabel="Ran 5 commands" />);
    // A failed step opens the record by itself.
    expect(view.getByTestId("chat-tool-summary-toggle").getAttribute("aria-expanded")).toBe("true");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Memory Shard Search");
    expect(text).toContain("Memory Shard Status");
    expect(text).toContain("terminal");
    expect(text).toContain("Image Generation");
    expect(text).toContain("Automations");
    expect(view.container.querySelectorAll("[data-testid=memory-shard-mark]")).toHaveLength(2);
    expect(view.container.querySelectorAll("[data-testid=image-generation-mark]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-testid=automations-mark]")).toHaveLength(1);
    const titles = Array.from(view.container.querySelectorAll("div[title]")).map((row) => row.getAttribute("title"));
    expect(titles).toContain("terminal: openclaw memory search \"meeting notes\"");
  });

  it("draws the desktop's mark for each app", () => {
    const toolCalls: ChatToolSummary[] = [
      { name: "clawbox__browser_open" },
      { name: "clawbox__coding_agent_run" },
      { name: "clawbox__vnc_status" },
      { name: "clawbox__screen_capture" },
      { name: "clawbox__app_install" },
      { name: "skills_list" },
      { name: "clawbox__preferences_set" },
      { name: "clawbox__update_check" },
    ];
    const view = render(<ToolCallSummaryChips toolCalls={toolCalls} label="Steps" />);
    fireEvent.click(view.getByTestId("chat-tool-summary-toggle"));
    expect(view.container.querySelectorAll("[data-testid=agent-browser-icon]")).toHaveLength(1);
    const glyphs = Object.fromEntries(
      Array.from(view.container.querySelectorAll<HTMLElement>('[data-testid$="-mark"]')).map((el) => [el.dataset.testid, el.textContent]),
    );
    expect(glyphs).toEqual({
      "coding-mark": "smart_toy",
      "vnc-mark": "desktop_windows",
      "screenshot-mark": "screenshot_monitor",
      "store-mark": "storefront",
      "hermes-skills-mark": "extension",
      "settings-mark": "settings",
      "system_update-mark": "system_update",
    });
    // The glyph is decoration: the row's accessible text is the label alone.
    for (const mark of view.container.querySelectorAll('[data-testid$="-mark"]')) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("in the owner's language", () => {
  it("uses the desktop's own app name and a translated action", () => {
    locale = "de";
    const de = translations.de;
    const expected = de["chat.step.label"]
      .replace("{app}", de["app.memoryShard"])
      .replace("{action}", de["chat.step.action.search"]);
    expect(expected).not.toBe("Memory Shard Search");

    const live = liveRows([
      { toolCallId: "d1", name: "exec", phase: "start", args: { command: "openclaw memory search x" } },
    ]);
    expect(live.view.container.textContent).toContain(expected);
    live.view.unmount();

    const replay = render(
      <ToolCallSummaryChips
        toolCalls={[{ name: "wiki_status" }, { name: "cron" }]}
        label="Schritte"
      />,
    );
    fireEvent.click(replay.getByTestId("chat-tool-summary-toggle"));
    expect(replay.container.textContent).toContain(
      de["chat.step.label"].replace("{app}", "Prime Radiant").replace("{action}", de["chat.step.action.status"]),
    );
    expect(replay.container.textContent).toContain(de["chat.step.app.automations"]);
  });
});
