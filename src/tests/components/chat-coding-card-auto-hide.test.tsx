import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// See chat-header-close-button.test.tsx for why a ChatPopup mount gets 30 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * A coding-run card leaving the chat on its own, five seconds after the chat
 * saw its run finish cleanly — and ONLY then.
 *
 * The clock itself is pinned in coding-run-auto-hide.test.tsx; this pins the
 * chat's side of it: the card is filtered out like a dismissed one (the rest
 * of the transcript untouched), the same 🤖 chip brings it back in its place,
 * and a run that is still going, failed, still has its pull request with
 * GitHub, or was already finished when the chat opened keeps its card. A
 * card that leaves holding the keyboard focus hands it to that chip.
 *
 * The device's run record is stubbed at the hook with real React state, so a
 * test can move a run on the way a poll would.
 */
const NOW = Date.now();
type Status = "running" | "completed" | "failed";
const run = (id: string, task: string, status: Status, prPhase: string | null = null) => ({
  id, projectId: "timer", task,
  startedAt: NOW - 30_000, completedAt: status === "running" ? null : NOW,
  status, source: "agent" as const,
  subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
  tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
  progress: [], screenshots: [], todos: [],
  transcriptPath: null, sessionId: null, directory: null,
  prPhase,
});

const feed = vi.hoisted(() => ({
  initial: [] as unknown[],
  push: null as null | ((runs: unknown[]) => void),
  nudge: () => {},
}));

vi.mock("@/lib/use-coding-agent-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-coding-agent-activity")>();
  const React = await import("react");
  return {
    ...actual,
    useCodingAgentActivity: () => {
      const [runs, setRuns] = React.useState(feed.initial);
      feed.push = setRuns;
      return { runs, nudge: feed.nudge };
    },
  };
});

// The owner's put-away cards (src/lib/use-dismissed-coding-runs.ts), kept in a
// plain map so a × in one test is not still put away in the next.
const kv = vi.hoisted(() => ({ cache: new Map<string, string>() }));
vi.mock("@/lib/client-kv", () => ({
  init: async () => {},
  get: (key: string) => kv.cache.get(key) ?? null,
  getJSON: () => null,
  set: (key: string, value: string) => { kv.cache.set(key, value); },
  setJSON: () => {},
  remove: () => {},
  flush: () => {},
}));

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return { ok: true, json: async () => ({ provider: "openrouter", current: "", reasoning: "medium", providers: [], models: [] }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  kv.cache.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

const cards = () => screen.queryAllByTestId("coding-agent-activity");
const cardTitles = () => cards().map((el) => el.querySelector('[data-testid="coding-agent-activity-toggle"]')?.textContent ?? "");
const push = (runs: unknown[]) => act(() => { feed.push!(runs); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/**
 * Mount on real timers — the chat's own start-up is async — and only then
 * hand the clock to the test, so every timer the auto-hide starts is fake.
 */
async function open(initial: unknown[]) {
  feed.initial = initial;
  render(<ChatPopup isOpen onClose={() => {}} />);
  await screen.findAllByTestId("coding-agent-activity");
  vi.useFakeTimers();
}

describe("a coding-run card that finished cleanly leaves on its own", () => {
  it("stays 4.999 s after its run finishes, is gone at 5 s, and the 🤖 chip brings it back in place", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);

    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    expect(cards()).toHaveLength(2);
    expect(cards()[0]).toHaveAttribute("data-status", "completed");
    expect(cards()[0]).toHaveClass("coding-agent-autohide");
    expect(cards()[1]).not.toHaveClass("coding-agent-autohide");

    advance(4_999);
    expect(cards()).toHaveLength(2);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();

    advance(1);
    expect(cards()).toHaveLength(1);
    expect(cardTitles()[0]).toContain("Beta task");
    // The transcript itself is where it was; only the card went.
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("coding-agent-restore"));
    expect(cards()).toHaveLength(2);
    expect(cardTitles()[0]).toContain("Alpha task");
    expect(cardTitles()[1]).toContain("Beta task");
    expect(cards()[0]).not.toHaveClass("coding-agent-autohide");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();

    // Restored for good: it does not count down again.
    advance(60_000);
    expect(cards()).toHaveLength(2);
  });

  it("keeps a failed run's card, a running one, and one that was already finished when the chat opened", async () => {
    await open([
      run("run-alpha", "Alpha task", "completed"),
      run("run-beta", "Beta task", "running"),
      run("run-gamma", "Gamma task", "running"),
    ]);

    push([
      run("run-alpha", "Alpha task", "completed"),
      run("run-beta", "Beta task", "failed"),
      run("run-gamma", "Gamma task", "running"),
    ]);
    advance(60_000);
    expect(cards()).toHaveLength(3);
    for (const card of cards()) expect(card).not.toHaveClass("coding-agent-autohide");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("brings a hidden card back by itself when its run is running again", async () => {
    await open([run("run-alpha", "Alpha task", "running")]);

    push([run("run-alpha", "Alpha task", "completed")]);
    advance(5_000);
    expect(cards()).toHaveLength(0);
    expect(screen.getByTestId("coding-agent-restore")).toBeInTheDocument();

    push([run("run-alpha", "Alpha task", "running")]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toHaveAttribute("data-status", "running");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("hides two finished cards on their own clocks", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);

    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    advance(3_000);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "completed")]);

    advance(2_000);
    expect(cards()).toHaveLength(1);
    expect(cardTitles()[0]).toContain("Beta task");
    advance(2_999);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
    // One chip for both, as for cards put away by hand.
    expect(screen.getAllByTestId("coding-agent-restore")).toHaveLength(1);
  });

  it("keeps a finished run's card while its pull request is with GitHub, and lets it go 5 s after the merge", async () => {
    await open([run("run-alpha", "Alpha task", "running", "opening")]);

    push([run("run-alpha", "Alpha task", "completed", "review")]);
    expect(cards()[0]).toHaveAttribute("data-status", "completed");
    expect(cards()[0]).not.toHaveClass("coding-agent-autohide");
    advance(60_000);
    expect(cards()).toHaveLength(1);

    push([run("run-alpha", "Alpha task", "completed", "merged")]);
    expect(cards()[0]).toHaveClass("coding-agent-autohide");
    advance(4_999);
    expect(cards()).toHaveLength(1);
    advance(1);
    expect(cards()).toHaveLength(0);
  });

  it("keeps a finished run's card whose pull request was left for the owner", async () => {
    await open([run("run-alpha", "Alpha task", "running", "opening")]);
    push([run("run-alpha", "Alpha task", "completed", "blocked")]);
    advance(60_000);
    expect(cards()).toHaveLength(1);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("hands the keyboard focus to the 🤖 chip when the card holding it leaves", async () => {
    await open([run("run-alpha", "Alpha task", "running")]);
    push([run("run-alpha", "Alpha task", "completed")]);
    const view = cards()[0].querySelector<HTMLButtonElement>('[data-testid="coding-agent-activity-view"]')!;
    act(() => { view.focus(); });
    expect(document.activeElement).toBe(view);

    advance(5_000);
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId("coding-agent-restore"));
  });

  it("leaves the focus where it is when the card that leaves does not hold it", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    const betaView = cards()[1].querySelector<HTMLButtonElement>('[data-testid="coding-agent-activity-view"]')!;
    act(() => { betaView.focus(); });

    advance(5_000);
    expect(cardTitles()).toEqual([expect.stringContaining("Beta task")]);
    expect(document.activeElement).toBe(betaView);
  });
});

/**
 * The chip and the owner's ×, side by side: the chip is for the cards that
 * left on their own and for nothing else — a card the owner put away stays
 * away (src/lib/use-dismissed-coding-runs.ts, chat-coding-card-dismiss.test.tsx).
 */
describe("the 🤖 chip and the cards put away with ×", () => {
  const dismissOf = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('[data-testid="coding-agent-activity-dismiss"]')!;
  const RESTORE = translations.en["codingAgent.chatRestore"];

  it("brings back the card that left on its own, and never the one put away with ×", async () => {
    await open([
      run("run-alpha", "Alpha task", "running"),
      run("run-beta", "Beta task", "running"),
      run("run-gamma", "Gamma task", "running"),
    ]);
    push([
      run("run-alpha", "Alpha task", "completed"),
      run("run-beta", "Beta task", "running"),
      run("run-gamma", "Gamma task", "running"),
    ]);
    advance(5_000);
    expect(cardTitles()).toEqual([expect.stringContaining("Beta task"), expect.stringContaining("Gamma task")]);

    fireEvent.click(dismissOf(cards()[0]));
    expect(cardTitles()).toEqual([expect.stringContaining("Gamma task")]);

    const chip = screen.getByTestId("coding-agent-restore");
    // Named for what it does now: the finished runs, not every hidden card.
    expect(chip).toHaveAttribute("aria-label", RESTORE);
    expect(chip).toHaveAttribute("title", RESTORE);
    fireEvent.click(chip);
    // Alpha is back in its place, first; Beta is not.
    expect(cardTitles()).toEqual([expect.stringContaining("Alpha task"), expect.stringContaining("Gamma task")]);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("draws no chip when the only card gone was put away with × while it counted down", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    expect(cards()[0]).toHaveClass("coding-agent-autohide");
    fireEvent.click(dismissOf(cards()[0]));
    expect(cardTitles()).toEqual([expect.stringContaining("Beta task")]);

    advance(5_000);
    expect(cardTitles()).toEqual([expect.stringContaining("Beta task")]);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("keeps a card put away with × away when its run goes back to running", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    fireEvent.click(dismissOf(cards()[0]));
    push([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    expect(cardTitles()).toEqual([expect.stringContaining("Beta task")]);
  });

  it("hands the focus to the chip when × takes the last card and the chip is there", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    advance(5_000);
    const betaClose = dismissOf(cards()[0]);
    act(() => { betaClose.focus(); });
    fireEvent.click(betaClose);
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId("coding-agent-restore"));
  });

  it("hands the focus from the chip to the first card it brings back", async () => {
    await open([run("run-alpha", "Alpha task", "running"), run("run-beta", "Beta task", "running")]);
    push([run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")]);
    advance(5_000);
    const chip = screen.getByTestId("coding-agent-restore");
    act(() => { chip.focus(); });
    fireEvent.click(chip);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(cards()[0].querySelector('[data-testid="coding-agent-activity-toggle"]'));
    expect(cards()[0]).toHaveAttribute("data-run-id", "run-alpha");
  });
});
