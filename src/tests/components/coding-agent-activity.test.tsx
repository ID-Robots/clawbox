/**
 * The chat's coding-run badges.
 *
 * Two bugs shaped this, both found on the real box:
 *
 * 1. `coding_agent_run` answers 202 with a run id in milliseconds, so the
 *    chat's tool pill for it reaches "done" almost at once while the run works
 *    on. Anything driven by the tool-call lifecycle goes quiet while the box is
 *    busy — so these badges follow the DEVICE's run record instead.
 * 2. The first version dropped the badge when the run ended, and runs here take
 *    9-15 seconds: it appeared and vanished while the owner was still reading
 *    the message above it. The badge now STAYS and reports the outcome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { renderHook } from "@testing-library/react";
import { translations } from "@/lib/translations";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import { artifactUrl, isCodingAgentTool, useCodingAgentActivity } from "@/lib/use-coding-agent-activity";

const NOW = Date.now();
const RUNNING = {
  id: "run-k3x9q2ab",
  projectId: "timer",
  task: "Build a countdown timer",
  status: "running",
  startedAt: NOW,
  completedAt: null,
  source: "agent",
};

function runsResponse(runs: unknown[]) {
  return new Response(JSON.stringify({ runs }), { status: 200, headers: { "content-type": "application/json" } });
}

const en = translations.en;
const LABELS = {
  running: en["codingAgent.chatWorking"],
  runningOwner: en["codingAgent.chatWorkingOwner"],
  completed: en["codingAgent.chatFinished"],
  failed: en["codingAgent.chatFailed"],
  stopped: en["codingAgent.chatStopped"],
  tokensWord: en["codingAgent.tokensWord"],
  liveWork: en["codingAgent.chatLiveWork"],
  showDetails: en["codingAgent.showDetails"],
  hideDetails: en["codingAgent.hideDetails"],
  thinking: en["codingAgent.thinking"],
  filesTouched: en["codingAgent.chatFilesTouched"],
  turns: en["codingAgent.chatTurns"],
  steps: {
    screenshot: en["codingAgent.chatScreenshot"],
    lookingAtPage: en["codingAgent.chatLookingAtPage"],
    openingPage: en["codingAgent.chatOpeningPage"],
    drivingPage: en["codingAgent.chatDrivingPage"],
    closingPage: en["codingAgent.chatClosingPage"],
    write: en["codingAgent.chatWrite"],
    edit: en["codingAgent.chatEdit"],
    read: en["codingAgent.chatRead"],
  },
};
const OPEN = en["codingAgent.chatOpenApp"];
/**
 * The header is the expand/collapse control. Reached by test id, not by role
 * and name: jsdom computes an accessible name by walking the whole tree, and
 * on the box — where the suite shares the CPU with a live coding run — a few
 * of those queries per test blew the 5 s budget. Its role is asserted once.
 */
const header = () => screen.getByTestId("coding-agent-activity-toggle");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which tools mean a run may have started", () => {
  it("recognises the coding-agent family and nothing else", () => {
    for (const name of ["coding_agent_run", "coding_agent_status", "clawbox__coding_agent_run"]) {
      expect(isCodingAgentTool(name), name).toBe(true);
    }
    for (const name of ["bash", "code_project_init", "web_search", "email_send"]) {
      expect(isCodingAgentTool(name), name).toBe(false);
    }
  });
});

describe("useCodingAgentActivity", () => {
  it("asks the device once when the chat opens, and reports a run in flight", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => { urls.push(String(url)); return runsResponse([RUNNING]); });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toMatchObject({ id: "run-k3x9q2ab", projectId: "timer", status: "running" });
    expect(urls[0]).toMatch(/\/setup-api\/coding-agent\/runs\?limit=/);
    // The evidence folder rides on the same request — the card thumbnails it.
    expect(urls[0]).toMatch(/[?&]artifacts=1/);
  });

  it("carries the run's newest steps and screenshots, and nothing the card does not draw", async () => {
    const progress = Array.from({ length: 12 }, (_, i) => `step ${i}`);
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([{
      ...RUNNING,
      progress,
      thinkingTokens: 1200,
      numTurns: 4,
      artifacts: [
        { name: "notes.txt", bytes: 10, kind: "text" },
        { name: "shot-1.png", bytes: 100, kind: "image" },
        { name: "shot-2.png", bytes: 100, kind: "image" },
        { name: "shot-3.png", bytes: 100, kind: "image" },
        { name: "shot-4.png", bytes: 100, kind: "image" },
        { name: 7, kind: "image" },
      ],
    }])));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    const run = result.current.runs[0];
    // The last eight, in order — the runner keeps more, the card has no room.
    expect(run.progress).toEqual(progress.slice(-8));
    // Images only, the newest three, oldest first.
    expect(run.screenshots).toEqual(["shot-2.png", "shot-3.png", "shot-4.png"]);
    expect(run.thinkingTokens).toBe(1200);
    expect(run.numTurns).toBe(4);
    expect(run).not.toHaveProperty("artifacts");
  });

  it("tolerates a record without progress or artifacts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([RUNNING])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toMatchObject({ progress: [], screenshots: [], thinkingTokens: 0, numTurns: 0 });
  });

  it("builds the served URL of a screenshot with both parts encoded", () => {
    expect(artifactUrl("run-k3x9q2ab", "after fix.png"))
      .toBe("/setup-api/coding-agent/artifacts?runId=run-k3x9q2ab&file=after%20fix.png");
  });

  it("KEEPS the badge after the run ends, carrying the outcome", async () => {
    vi.useFakeTimers();
    let status = "running";
    const fetchMock = vi.fn(async () =>
      runsResponse([{ ...RUNNING, status, completedAt: status === "running" ? null : NOW + 12_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs[0].status).toBe("running");

    status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    // Still there — this is the regression the owner reported.
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].status).toBe("completed");
    expect(result.current.runs[0].completedAt).toBe(NOW + 12_000);
  });

  it("keeps badges as the conversation continues, and stops polling once nothing runs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([{ ...RUNNING, status: "completed", completedAt: NOW + 9_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ open }) => useCodingAgentActivity(open), {
      initialProps: { open: true },
    });
    await act(async () => { await Promise.resolve(); });
    const calls = fetchMock.mock.calls.length;

    // Messages keep arriving and the chat re-renders: the badge stays, and no
    // timer is quietly ticking behind it.
    rerender({ open: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.runs).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("does not adopt runs that finished before this conversation", async () => {
    const old = {
      ...RUNNING, id: "run-yesterday", status: "completed",
      startedAt: NOW - 86_400_000, completedAt: NOW - 86_390_000,
    };
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([old])));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(0);
  });

  it("asks nothing at all while the chat is closed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([RUNNING]));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useCodingAgentActivity(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the badges alone when the device cannot be reached", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) throw new Error("offline");
      return runsResponse([RUNNING]);
    }));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    // A failed request must not rewrite what already happened.
    fail = true;
    act(() => { result.current.nudge(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(1);
  });
});

describe("the badge", () => {
  const pill = (over: Record<string, unknown> = {}) => {
    render(
      <CodingAgentActivityPill
        run={{
          id: "run-k3x9q2ab", projectId: "timer", task: "x",
          startedAt: NOW - 95_000, completedAt: null,
          status: "running", source: "agent", ...over,
        } as never}
        labels={LABELS}
        openLabel={OPEN}
      />,
    );
    return screen.getByTestId("coding-agent-activity");
  };

  it("names the work, the project and how long it has been going", () => {
    const el = pill();
    expect(el.textContent).toContain(LABELS.running);
    expect(el.textContent).toContain("timer");
    expect(el.textContent).toMatch(/1m 3[0-9]s/);
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("data-status", "running");
  });

  it("reports the outcome once the run is over, and freezes the time it took", () => {
    const el = pill({ status: "completed", startedAt: NOW - 95_000, completedAt: NOW - 83_000 });
    expect(el.textContent).toContain(LABELS.completed);
    expect(el.textContent).toContain("12s"); // completedAt - startedAt, not "now"
    expect(el).toHaveAttribute("data-status", "completed");
    // A settled badge must not keep announcing itself as it scrolls by.
    expect(el).toHaveAttribute("aria-live", "off");
  });

  it("says plainly when a run did not finish", () => {
    expect(pill({ status: "failed", completedAt: NOW }).textContent).toContain(LABELS.failed);
  });

  it("says plainly when a run was stopped", () => {
    expect(pill({ status: "stopped", completedAt: NOW }).textContent).toContain(LABELS.stopped);
  });

  it("does not credit the assistant for a run the owner started", () => {
    const el = pill({ source: "owner" });
    expect(el.textContent).toContain(LABELS.runningOwner);
    expect(el.textContent).not.toContain(LABELS.running);
  });

  it("shows the newest progress line while the run is live, as a chip", () => {
    const el = pill({ progress: ["Write app.js", "$ npm test"] });
    expect(el.textContent).toContain("npm test");
    expect(el.textContent).not.toContain("app.js"); // collapsed: the newest step only
    expect(screen.getByTestId("coding-agent-activity-progress")).toBeInTheDocument();
  });

  it("drops the progress line once the run has settled — the card reports the outcome, not its last step", () => {
    const el = pill({ status: "completed", completedAt: NOW, progress: ["$ npm test"] });
    expect(el.textContent).not.toContain("npm test");
  });

  it("offers a way into the app only when there is somewhere to go", () => {
    const onOpen = vi.fn();
    const run = {
      id: "run-x", projectId: null, task: "x", startedAt: NOW,
      completedAt: null, status: "running" as const, source: "agent" as const,
      subagentsTotal: 0, subagentsActive: 0, subagentsByType: {}, tokensUsed: 0, thinkingTokens: 0,
      filesTouched: 0, numTurns: 0, progress: [], screenshots: [],
    };
    const { rerender } = render(
      <CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} onOpen={onOpen} />,
    );
    screen.getByTitle(OPEN).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(<CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} />);
    expect(screen.queryByTitle(OPEN)).not.toBeInTheDocument();
  });
});

/**
 * The owner's two asks, in their words: "We can click on the Coding Agent
 * pill to expand and see live work, also replace the
 * mcp__clawbox__browser_screenshot with good looking ui element that we can
 * also click and open the screenshot."
 */
describe("the card, expanded", () => {
  const SHOT_URL = artifactUrl("run-k3x9q2ab", "after.png");
  const card = (over: Record<string, unknown> = {}, onPreview?: (src: string, alt: string) => void) => {
    render(
      <CodingAgentActivityPill
        run={{
          id: "run-k3x9q2ab", projectId: "timer", task: "x",
          startedAt: NOW - 30_000, completedAt: null,
          status: "running", source: "agent",
          subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
          tokensUsed: 46_000, thinkingTokens: 0, filesTouched: 3, numTurns: 0,
          progress: ["Write style.css", "Now the JavaScript:", "$ node --check /home/clawbox/clawbox/data/app.js", "mcp__clawbox__browser_screenshot"],
          screenshots: ["before.png", "after.png"],
          ...over,
        }}
        labels={LABELS}
        openLabel={OPEN}
        onOpen={vi.fn()}
        onPreview={onPreview}
      />,
    );
    return screen.getByTestId("coding-agent-activity");
  };

  it("collapsed, the newest step is a 'Screenshot' chip — never the raw mcp__ name", () => {
    const el = card();
    expect(el.textContent).toContain(LABELS.steps.screenshot);
    expect(el.textContent).not.toMatch(/mcp__/);
    expect(header()).toHaveAttribute("role", "button");
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("coding-agent-activity-details")).not.toBeInTheDocument();
  });

  it("the collapsed Screenshot chip opens the newest screenshot in the chat's preview", () => {
    const onPreview = vi.fn();
    card({}, onPreview);
    const chip = screen.getByTestId("coding-agent-activity-progress").querySelector("button");
    expect(chip?.textContent).toContain(LABELS.steps.screenshot);
    fireEvent.click(chip!);
    expect(onPreview).toHaveBeenCalledWith(SHOT_URL, "after.png");
    // Opening the picture is not a request to expand the card.
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("the Screenshot chip is not a control when the run has saved no picture yet", () => {
    card({ screenshots: [] }, vi.fn());
    const line = screen.getByTestId("coding-agent-activity-progress");
    expect(line.querySelector("button")).toBeNull();
    expect(line.textContent).toContain(LABELS.steps.screenshot);
  });

  it("a click expands the card into the live-work panel: the last steps as chips, the counters, the screenshots", () => {
    const el = card();
    fireEvent.click(el);
    expect(header()).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("coding-agent-activity-details");
    expect(details.textContent).toContain(LABELS.liveWork);

    const steps = screen.getByTestId("coding-agent-activity-steps");
    const chips = Array.from(steps.querySelectorAll("li"));
    expect(chips).toHaveLength(4);
    expect(chips[0].textContent).toContain(`${LABELS.steps.write}`);
    expect(chips[0].textContent).toContain("style.css");
    expect(chips[1].textContent).toContain("Now the JavaScript:");
    expect(chips[2].textContent).toContain("node --check data/app.js"); // device prefix gone
    expect(chips[3].textContent).toContain(LABELS.steps.screenshot);
    expect(steps.textContent).not.toMatch(/mcp__/);
    // The one-line chip gives way to the list; the same step is not shown twice.
    expect(screen.queryByTestId("coding-agent-activity-progress")).not.toBeInTheDocument();

    const counters = screen.getByTestId("coding-agent-activity-counters").textContent ?? "";
    expect(counters).toContain(`46k ${LABELS.tokensWord}`);
    expect(counters).toContain(`3 ${LABELS.filesTouched}`);
    // Turns arrive with the final result; a live run must not claim "0 turns".
    expect(counters).not.toContain(LABELS.turns);

    const imgs = Array.from(screen.getByTestId("coding-agent-activity-screenshots").querySelectorAll("img"));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([artifactUrl("run-k3x9q2ab", "before.png"), SHOT_URL]);
    expect(imgs[1]).toHaveAttribute("alt", "after.png");
    expect(imgs[1]).toHaveAttribute("loading", "lazy");
  });

  it("shows thinking tokens and turns once there are any", () => {
    card({ thinkingTokens: 2_300, numTurns: 12, status: "completed", completedAt: NOW });
    fireEvent.click(header());
    const counters = screen.getByTestId("coding-agent-activity-counters").textContent ?? "";
    expect(counters).toContain(LABELS.thinking.replace("{n}", "2k"));
    expect(counters).toContain(`12 ${LABELS.turns}`);
  });

  it("a thumbnail opens that screenshot in the chat's preview, without collapsing the card", () => {
    const onPreview = vi.fn();
    card({}, onPreview);
    fireEvent.click(header());
    fireEvent.click(screen.getByTitle("after.png"));
    expect(onPreview).toHaveBeenCalledWith(SHOT_URL, "after.png");
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("a click inside the expanded panel — to read a step or the counters — does not collapse it", () => {
    card();
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // A free-text step is a plain span, not a button: nothing of its own to
    // stop the click, so the panel has to.
    const steps = screen.getByTestId("coding-agent-activity-steps");
    const text = steps.querySelector('[data-kind="text"]');
    expect(text?.textContent).toContain("Now the JavaScript:");
    fireEvent.click(text!);
    expect(header()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("coding-agent-activity-counters"));
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // The panel's own surface — the gap between two thumbnails, say.
    fireEvent.click(screen.getByTestId("coding-agent-activity-details"));
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // The header still collapses it: the panel is inert, the card is not.
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles from the keyboard with Enter and Space, and ignores other keys", () => {
    card();
    fireEvent.keyDown(header(), { key: "Enter" });
    expect(header()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(header(), { key: " " });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(header(), { key: "Tab" });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(header()).toHaveAttribute("tabindex", "0");
  });

  it("names its state for a screen reader and says what a press does", () => {
    card();
    expect(header()).toHaveAttribute("title", LABELS.showDetails);
    fireEvent.click(header());
    expect(header()).toHaveAttribute("title", LABELS.hideDetails);
  });

  it("the open link goes to the app and does not toggle the card", () => {
    card();
    fireEvent.click(screen.getByTitle(OPEN));
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("a finished run stays expandable — its steps are the record of what it did", () => {
    const el = card({ status: "completed", completedAt: NOW, numTurns: 6 });
    expect(screen.queryByTestId("coding-agent-activity-progress")).not.toBeInTheDocument();
    fireEvent.click(el);
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("coding-agent-activity-steps").querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByTestId("coding-agent-activity-counters").textContent).toContain(`6 ${LABELS.turns}`);
  });

  it("the panel does not narrate its every change inside the live card", () => {
    card();
    fireEvent.click(header());
    expect(screen.getByTestId("coding-agent-activity-details")).toHaveAttribute("aria-live", "off");
  });
});
