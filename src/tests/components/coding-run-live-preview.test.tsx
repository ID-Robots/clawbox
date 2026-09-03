import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import CodingRunLivePreview, { livePreviewCommand } from "@/components/CodingRunLivePreview";

// xterm and its WebSocket have no business in jsdom; the panel is what is
// under test, and what it types into the terminal.
vi.mock("@/components/TerminalApp", () => ({
  default: ({ initialCommand }: { initialCommand?: string }) => <div data-testid="terminal-stub">{initialCommand}</div>,
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

describe("the floating live terminal", () => {
  it("tails a working run, resumes a finished one, and has nothing for a run without either", () => {
    expect(livePreviewCommand({ transcriptPath: "/home/clawbox/.claude-ds/projects/x/s.jsonl", sessionId: null, directory: "/home/clawbox/Projects/site", live: true }))
      .toBe("/home/clawbox/clawbox/scripts/coding-run-preview '/home/clawbox/.claude-ds/projects/x/s.jsonl'");
    expect(livePreviewCommand({ transcriptPath: null, sessionId: "abc-123", directory: "/home/clawbox/Projects/it's", live: true }))
      .toBe("cd '/home/clawbox/Projects/it'\\''s' && claude-ds --resume abc-123");
    expect(livePreviewCommand({ transcriptPath: null, sessionId: null, directory: null, live: true })).toBeNull();
  });

  it("folds on a click of its bar and unfolds on another, keeping the terminal mounted", () => {
    render(<CodingRunLivePreview runId="run-1" command="tail -f x" onClose={() => {}} />);
    expect(screen.getByTestId("terminal-stub").textContent).toBe("tail -f x");
    const bar = screen.getByTestId("coding-live-preview-bar");
    expect(bar).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("coding-live-preview")).toHaveAttribute("data-folded", "true");
    // Still there, still tailing.
    expect(screen.getByTestId("terminal-stub")).toBeInTheDocument();
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(bar).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on the X, and hands the command to a real Terminal window on request", () => {
    const onClose = vi.fn();
    const opened: string[] = [];
    const onTerminal = (e: Event) => opened.push((e as CustomEvent<{ command: string }>).detail.command);
    window.addEventListener("clawbox:open-terminal", onTerminal);
    try {
      render(<CodingRunLivePreview runId="run-1" command="tail -f x" onClose={onClose} />);
      fireEvent.click(screen.getByTestId("coding-live-preview-open"));
      expect(opened).toEqual(["tail -f x"]);
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("coding-live-preview-close"));
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("clawbox:open-terminal", onTerminal);
    }
  });

  it("says so, instead of a terminal, when there is nothing to show yet", () => {
    render(<CodingRunLivePreview runId="run-1" command={null} onClose={() => {}} />);
    expect(screen.queryByTestId("terminal-stub")).toBeNull();
    expect(screen.getByText("codingAgent.livePreviewNotYet")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-live-preview-open")).toBeNull();
  });
});
